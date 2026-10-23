
import { isOwnedBy, type SessionIdentity } from "./syncPolicy";

/*
 * Pure rules that protect pending (unsynced) offline queue items
 * (no browser APIs, unit-testable).
 *
 *  - Switching to a DIFFERENT account is blocked while any unsynced item
 *    exists that the new account does not own (every type, every status
 *    except SYNCED, including NEEDS_ATTENTION and items from before account
 *    tracking). The same owner (tenant + user + device) may always sign in.
 *  - The block is lifted either because the items were synced by their
 *    owner, or because a verified export covering every one of them was
 *    saved on this device. An export NEVER changes, deletes or reassigns
 *    items: they stay in the queue, owned by the original account, and can
 *    only be synced by that account.
 *  - A queued item can be deleted only if it is SYNCED and owned by the
 *    current account.
 *
 * The export file is a record for audit and manual recovery. It is NOT an
 * import: this application has no import endpoint, and nothing reads the
 * file back. Its digest detects accidental damage; it is not a signature and
 * does not prove authenticity (anyone with the file can recompute it).
 *
 * LIMITS (not tamper-proof): all of this runs in the user's browser. Someone
 * who clears the browser profile or edits IndexedDB can bypass the block.
 * The server's ownership checks at upload (session user and device must own
 * the operation) are the real protection against uploading another
 * account's work.
 */

export const EXPORT_FORMAT = "billing-pending-export";
export const EXPORT_VERSION = 1;

export const EXPORT_NOTE =
    "Record for audit and manual recovery only. This file is NOT imported by the application: " +
    "no import endpoint exists. The items remain in the queue on the original device, owned by " +
    "their original account, and can only be sent by that account signed in there.";

/** The fields of a queue item the rules need (SyncQueueItem fits this). */
export interface GuardItem {
    operationId: string;
    operationType: string;
    entityType: string;
    payload: Record<string, unknown>;
    status: string;
    localSeq: number;
    attempts: number;
    createdAt: string;
    lastAttemptAt?: string;
    nextAttemptAt?: string;
    errorMessage?: string;
    owner?: SessionIdentity;
    legacyUnowned?: boolean;
}

export interface ExportItem {
    operationId: string;
    operationType: string;
    entityType: string;
    status: string;
    localSeq: number;
    attempts: number;
    createdAt: string;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    errorMessage: string | null;
    legacyUnowned: boolean;
    owner: SessionIdentity | null;
    payload: Record<string, unknown>;
}

export interface PendingExport {
    format: typeof EXPORT_FORMAT;
    version: typeof EXPORT_VERSION;
    exportedAt: string;
    itemCount: number;
    note: string;
    // SHA-256 (hex) of the canonical JSON of format, version and items.
    digest: string;
    items: ExportItem[];
}

/** What is remembered on this device after an export was saved. */
export interface ExportAcknowledgement {
    exportedAt: string;
    // Digest of the exported file.
    exportDigest: string;
    // operationId -> digest of that item's immutable content.
    manifest: Record<string, string>;
    // Digest of the manifest itself (detects a damaged acknowledgement).
    manifestDigest: string;
}

export type SwitchDecision =
    | { allowed: true; viaExport: boolean; unsyncedForOthers: number }
    | {
        allowed: false;
        // Unsynced items the new account does not own.
        blockingCount: number;
        // ... of which not covered by a valid export.
        uncoveredCount: number;
        byStatus: Record<string, number>;
        // ... of which have no recorded owner.
        unownedCount: number;
    };

// ------------------------------------------------------------ basics

export function isUnsynced(item: { status: string }): boolean {
    return item.status !== "SYNCED";
}

export function unsyncedItems<T extends { status: string }>(items: T[]): T[] {
    return items.filter(isUnsynced);
}

function ownedBy(item: GuardItem, identity: SessionIdentity): boolean {
    return isOwnedBy(item, identity);
}

/** Stable JSON: object keys sorted, undefined dropped. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
    const api = globalThis.crypto?.subtle;
    if (!api) throw new Error("Secure cryptography is not available in this browser");
    const digest = await api.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneOwner(owner: SessionIdentity | undefined): SessionIdentity | null {
    return owner ? { tenantId: owner.tenantId, userId: owner.userId, deviceId: owner.deviceId } : null;
}

/** Copy of an item for export. Never returns the original object. */
export function toExportItem(item: GuardItem): ExportItem {
    return {
        operationId: item.operationId,
        operationType: item.operationType,
        entityType: item.entityType,
        status: item.status,
        localSeq: item.localSeq,
        attempts: item.attempts,
        createdAt: item.createdAt,
        lastAttemptAt: item.lastAttemptAt ?? null,
        nextAttemptAt: item.nextAttemptAt ?? null,
        errorMessage: item.errorMessage ?? null,
        legacyUnowned: item.legacyUnowned === true,
        owner: cloneOwner(item.owner),
        payload: JSON.parse(JSON.stringify(item.payload ?? {})) as Record<string, unknown>,
    };
}

/**
 * Digest of an item's IMMUTABLE content (what was sold, by whom, when it was
 * queued). Status, attempts and error text change during sync attempts and
 * are therefore not part of it; they are still preserved in the export.
 */
export async function itemContentDigest(item: GuardItem): Promise<string> {
    return sha256Hex(
        canonicalJson({
            operationId: item.operationId,
            operationType: item.operationType,
            entityType: item.entityType,
            localSeq: item.localSeq,
            createdAt: item.createdAt,
            legacyUnowned: item.legacyUnowned === true,
            owner: cloneOwner(item.owner),
            payload: item.payload ?? {},
        })
    );
}

// ------------------------------------------------------------ export

async function exportDigestOf(items: ExportItem[]): Promise<string> {
    return sha256Hex(canonicalJson({ format: EXPORT_FORMAT, version: EXPORT_VERSION, items }));
}

/**
 * Build the verified export of ALL unsynced items (every owner, every type
 * and status except SYNCED) and the acknowledgement to remember. Reads the
 * items only; nothing is changed or removed.
 */
export async function buildPendingExport(
    items: GuardItem[],
    now: number
): Promise<{ file: PendingExport; acknowledgement: ExportAcknowledgement }> {
    const pending = unsyncedItems(items)
        .slice()
        .sort((a, b) => a.localSeq - b.localSeq || a.operationId.localeCompare(b.operationId));
    const exportItems = pending.map(toExportItem);
    const exportedAt = new Date(now).toISOString();

    const manifest: Record<string, string> = {};
    for (const item of pending) manifest[item.operationId] = await itemContentDigest(item);

    const digest = await exportDigestOf(exportItems);
    const file: PendingExport = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt,
        itemCount: exportItems.length,
        note: EXPORT_NOTE,
        digest,
        items: exportItems,
    };

    return {
        file,
        acknowledgement: {
            exportedAt,
            exportDigest: digest,
            manifest,
            manifestDigest: await sha256Hex(canonicalJson(manifest)),
        },
    };
}

/** Whether a (parsed) export file is complete and its digest matches. */
export async function verifyPendingExport(file: PendingExport): Promise<boolean> {
    if (
        !file || file.format !== EXPORT_FORMAT || file.version !== EXPORT_VERSION ||
        !Array.isArray(file.items) || file.itemCount !== file.items.length
    ) {
        return false;
    }
    return (await exportDigestOf(file.items)) === file.digest;
}

/** Whether a stored acknowledgement is undamaged. */
export async function isAcknowledgementIntact(ack: ExportAcknowledgement | null | undefined): Promise<boolean> {
    if (!ack || typeof ack.manifest !== "object" || ack.manifest === null) return false;
    if (typeof ack.manifestDigest !== "string" || typeof ack.exportDigest !== "string") return false;
    return (await sha256Hex(canonicalJson(ack.manifest))) === ack.manifestDigest;
}

// ------------------------------------------------------------ decisions

/**
 * May `candidate` sign in on this device? Blocked while any unsynced item
 * is not owned by the candidate, unless a valid export covers every such
 * item (same operation ID AND unchanged immutable content).
 */
export async function decideAccountSwitch(
    items: GuardItem[],
    candidate: SessionIdentity,
    acknowledgement: ExportAcknowledgement | null
): Promise<SwitchDecision> {
    const blocking = unsyncedItems(items).filter((item) => !ownedBy(item, candidate));
    if (blocking.length === 0) return { allowed: true, viaExport: false, unsyncedForOthers: 0 };

    const intact = await isAcknowledgementIntact(acknowledgement);
    const uncovered: GuardItem[] = [];
    for (const item of blocking) {
        const expected = intact ? acknowledgement!.manifest[item.operationId] : undefined;
        if (expected === undefined || expected !== (await itemContentDigest(item))) uncovered.push(item);
    }

    if (uncovered.length === 0) return { allowed: true, viaExport: true, unsyncedForOthers: blocking.length };

    const byStatus: Record<string, number> = {};
    for (const item of blocking) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;

    return {
        allowed: false,
        blockingCount: blocking.length,
        uncoveredCount: uncovered.length,
        byStatus,
        unownedCount: blocking.filter((item) => !item.owner).length,
    };
}

/**
 * Throws unless the item may be deleted: SYNCED and owned by the current
 * account. Pending, failed, syncing, NEEDS_ATTENTION and foreign items are
 * never deletable.
 */
export function assertQueueItemDeletable(item: GuardItem | undefined, identity: SessionIdentity | null): void {
    if (!item) throw new Error("Sync queue item not found");
    if (!identity) throw new Error("Sign in to delete a queue item");
    if (item.status !== "SYNCED") {
        throw new Error("Only synced queue items can be deleted; pending items are protected");
    }
    if (!ownedBy(item, identity)) {
        throw new Error("This queue item belongs to another account and cannot be deleted");
    }
}
