
/*
 * Browser side of the offline session (see offlineSession.ts): IndexedDB
 * storage, offline sign-out and the pending server logout. Nothing here
 * authorizes a server request: the server session cookie and the server's
 * own checks do that.
 */

import { clearRuntimeCaches } from "./cacheCleanup";
import { emptySummary, summarizeQueue, type QueueSummary } from "./queueStatus";
import { LAST_IDENTITY_KEY, offlineDB } from "./db";
import {
    activateOfflineSession,
    checkOfflineWorkAllowed,
    checkOfflineProductCreationAllowed,
    deleteOfflineSession,
    getOfflineSessionState,
    recordOfflineActivity,
    type OfflineIdentity,
    type OfflineSessionState,
    type OfflineSessionStore,
} from "./offlineSession";

const PENDING_LOGOUT_KEY = "pendingServerLogout";

/** Longest wait for the pending server logout; a timeout keeps the flag. */
export const PENDING_LOGOUT_TIMEOUT_MS = 5_000;

const store: OfflineSessionStore = {
    get: (key) => offlineDB.offlineSessions.get(key),
    put: async (record) => { await offlineDB.offlineSessions.put(record); },
    delete: (key) => offlineDB.offlineSessions.delete(key),
};

// ---------------------------------------------------------- identity

function toIdentity(value: unknown): OfflineIdentity | null {
    const v = value as Partial<OfflineIdentity> | null;
    return v && typeof v.tenantId === "string" && typeof v.userId === "string" && typeof v.deviceId === "string"
        ? { tenantId: v.tenantId, userId: v.userId, deviceId: v.deviceId }
        : null;
}

/** The account that last signed in online on this device (a label only). */
export async function readRememberedIdentity(): Promise<OfflineIdentity | null> {
    return toIdentity((await offlineDB.meta.get(LAST_IDENTITY_KEY))?.value ?? null);
}

// ---------------------------------------------------------- queries

/** Queued items of this account that are not yet synced (never modified here). */
export async function countUnsyncedItems(identity: OfflineIdentity): Promise<number> {
    return (await getQueueSummary(identity)).unsynced;
}

/** Status breakdown of this account's queued items (read-only). */
export async function getQueueSummary(identity: OfflineIdentity): Promise<QueueSummary> {
    const items = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    return summarizeQueue(items.filter((item) =>
        item.owner?.tenantId === identity.tenantId &&
        item.owner?.deviceId === identity.deviceId
    ));
}

export interface OfflineAccessOverview {
    identity: OfflineIdentity | null;
    state: OfflineSessionState;
    /** Offline work is allowed right now (valid, unexpired, sales.create). */
    allowed: boolean;
    unsyncedItems: number;
    /** This account's items by status. */
    queue: QueueSummary;
    pendingServerLogout: boolean;
}

export const defaultOfflineSessionStore = store;

export interface OfflineRestorationResult {
    ok: boolean;
    identity?: OfflineIdentity;
    overview?: OfflineAccessOverview;
    reason?: string;
}

/** Everything the dashboard needs to show the offline session. */
export async function getOfflineAccessOverview(
    customStore: OfflineSessionStore = store,
    customNow?: number,
    customIdentity?: OfflineIdentity | null
): Promise<OfflineAccessOverview> {
    const identity = customIdentity !== undefined ? customIdentity : await readRememberedIdentity();
    const pendingServerLogout = await hasPendingServerLogout().catch(() => false);
    if (!identity) {
        return { identity: null, state: { status: "none" }, allowed: false, unsyncedItems: 0, queue: emptySummary(), pendingServerLogout };
    }
    const now = typeof customNow === "number" ? customNow : Date.now();
    const state = await getOfflineSessionState(customStore, identity, now);
    const allowed = !pendingServerLogout && (await checkOfflineWorkAllowed(customStore, identity, now)).ok;
    // Offline use raises the clock high-water mark (never the expiry).
    if (state.status === "available" && allowed) await recordOfflineActivity(customStore, identity, now).catch(() => false);
    const queue = await getQueueSummary(identity).catch(() => emptySummary());
    return { identity, state, allowed, unsyncedItems: queue.unsynced, queue, pendingServerLogout };
}

/**
 * Attempt to restore an existing locally persisted offline session when the server is unreachable.
 * Validates the saved authorization's expiry, tenant, user, device binding, clock checks,
 * and sales.create permission using the existing security rules.
 * Never renews authorization expiry (only advances clock high-water mark).
 */
export async function restoreOfflineSession(options?: {
    store?: OfflineSessionStore;
    now?: number;
    identity?: OfflineIdentity | null;
}): Promise<OfflineRestorationResult> {
    const activeStore = options?.store ?? store;
    const now = typeof options?.now === "number" ? options.now : Date.now();

    const pendingLogout = await hasPendingServerLogout().catch(() => false);
    if (pendingLogout) {
        return {
            ok: false,
            reason: "A sign-out was requested on this device. Sign in online to continue.",
        };
    }

    const identity = options?.identity !== undefined ? options.identity : await readRememberedIdentity();
    if (!identity) {
        return {
            ok: false,
            reason: "Offline access is not available for this account on this device; sign in online first",
        };
    }

    const allowedCheck = await checkOfflineWorkAllowed(activeStore, identity, now);
    if (!allowedCheck.ok) {
        const overview = await getOfflineAccessOverview(activeStore, now, identity).catch(() => undefined);
        return {
            ok: false,
            identity,
            overview,
            reason: allowedCheck.reason,
        };
    }

    // Offline activity raises the clock high-water mark (never the expiry)
    await recordOfflineActivity(activeStore, identity, now).catch(() => false);
    const overview = await getOfflineAccessOverview(activeStore, now, identity).catch(() => undefined);

    return {
        ok: true,
        identity,
        overview,
    };
}

/**
 * Check whether offline product creation is allowed for the remembered account.
 */
export async function checkOfflineProductCreation(options?: {
    store?: OfflineSessionStore;
    now?: number;
    identity?: OfflineIdentity | null;
}): Promise<{ ok: true; identity: OfflineIdentity; canCost: boolean } | { ok: false; reason: string; identity?: OfflineIdentity }> {
    const activeStore = options?.store ?? store;
    const now = typeof options?.now === "number" ? options.now : Date.now();

    const pendingLogout = await hasPendingServerLogout().catch(() => false);
    if (pendingLogout) {
        return {
            ok: false,
            reason: "A sign-out was requested on this device. Sign in online to continue.",
        };
    }

    const identity = options?.identity !== undefined ? options.identity : await readRememberedIdentity();
    if (!identity) {
        return {
            ok: false,
            reason: "Offline access is not available for this account on this device; sign in online first",
        };
    }

    const allowedCheck = await checkOfflineProductCreationAllowed(activeStore, identity, now);
    if (!allowedCheck.ok) {
        return {
            ok: false,
            identity,
            reason: allowedCheck.reason,
        };
    }

    await recordOfflineActivity(activeStore, identity, now).catch(() => false);

    return {
        ok: true,
        identity,
        canCost: allowedCheck.canCost,
    };
}

/** Offline session state of one identity (e.g. for the account page). */
export function getOfflineStateFor(identity: OfflineIdentity): Promise<OfflineSessionState> {
    return getOfflineSessionState(store, identity, Date.now());
}

// ---------------------------------------------------------- actions

/**
 * Create or renew the offline session (72 hours from the SERVER time). Call
 * ONLY right after a successful server verification made by login, the
 * dashboard or the account page (see sessionConfirmation.ts). Throws
 * OfflineVerificationError when the server time is missing or the device
 * clock differs from it by more than five minutes.
 */
export async function activateOfflineAccess(input: {
    identity: OfflineIdentity;
    permissions: string[];
    displayName?: string;
    serverTime: number | null;
}) {
    return activateOfflineSession(store, { ...input, now: Date.now() });
}

/**
 * Throws (with a plain-language reason) unless offline work is allowed.
 * On success the clock high-water mark is raised; the expiry never changes.
 */
export async function assertOfflineWorkAllowed(identity: OfflineIdentity): Promise<void> {
    const now = Date.now();
    const result = await checkOfflineWorkAllowed(store, identity, now);
    if (!result.ok) throw new Error(result.reason);
    await recordOfflineActivity(store, identity, now);
}

/** Remove an identity's offline session (logout, revocation, temporary password). Queued work is kept. */
export async function removeOfflineAccess(identity: OfflineIdentity): Promise<void> {
    await deleteOfflineSession(store, identity);
}

// ---------------------------------------------------------- offline sign-out

export async function hasPendingServerLogout(): Promise<boolean> {
    return Boolean((await offlineDB.meta.get(PENDING_LOGOUT_KEY))?.value);
}

/**
 * Sign out while offline: remove this account's offline session and the
 * remembered identity on this device, and remember that the SERVER session
 * must still be ended when the device reconnects. Queued work is kept.
 */
export async function signOutOffline(): Promise<void> {
    const identity = await readRememberedIdentity();
    if (identity) await deleteOfflineSession(store, identity);
    // Page/data runtime caches only; the queue and the offline app shell stay.
    await clearRuntimeCaches(typeof caches !== "undefined" ? caches : undefined);
    await offlineDB.meta.put({ key: PENDING_LOGOUT_KEY, value: { since: new Date().toISOString() } });
    await offlineDB.meta.delete(LAST_IDENTITY_KEY);
}

/**
 * If an offline sign-out is pending, end the server session now.
 *   "none"        nothing pending
 *   "done"        the server confirmed the logout; the flag is cleared
 *   "unreachable" could not confirm it; the flag is kept for later
 * Until "done", the old session must not be used (callers stop).
 */
export async function settlePendingServerLogout(): Promise<"none" | "done" | "unreachable"> {
    if (!(await hasPendingServerLogout())) return "none";
    try {
        const response = await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            signal: AbortSignal.timeout(PENDING_LOGOUT_TIMEOUT_MS),
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data?.success) {
            await offlineDB.meta.delete(PENDING_LOGOUT_KEY);
            return "done";
        }
    } catch {
        // offline, unreachable or timed out: try again later
    }
    return "unreachable";
}

/** A new online sign-in replaced the old session cookie: nothing left to end. */
export async function clearPendingServerLogout(): Promise<void> {
    await offlineDB.meta.delete(PENDING_LOGOUT_KEY);
}
