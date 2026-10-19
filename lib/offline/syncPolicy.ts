
/*
 * Pure rules for the offline sync queue (no browser APIs, unit-testable).
 */

export interface SessionIdentity {
    tenantId: string;
    userId: string;
    /** Device document ID from the authenticated session. */
    deviceId: string;
}

export type LocalSyncStatus = "PENDING" | "SYNCING" | "SYNCED" | "FAILED" | "NEEDS_ATTENTION";

export interface QueueItemState {
    status: LocalSyncStatus;
    attempts: number;
    localSeq: number;
    nextAttemptAt?: string;
    syncingSince?: string;
    owner?: SessionIdentity;
    operationId?: string;
    entityType?: string;
    dependsOn?: string[];
}

/** Client-side attempt limit before an item needs attention. */
export const MAX_CLIENT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** A SYNCING item older than this is assumed to be from a crashed tab. */
export const STALE_SYNCING_MS = 2 * 60_000;

export function isOwnedBy(item: { owner?: SessionIdentity }, identity: SessionIdentity): boolean {
    return Boolean(
        item.owner &&
        item.owner.tenantId === identity.tenantId &&
        item.owner.userId === identity.userId &&
        item.owner.deviceId === identity.deviceId
    );
}

/** Items of THIS account that are due for a sync attempt, in queue order. */
export function selectSyncable<T extends QueueItemState>(items: T[], identity: SessionIdentity, now: Date): T[] {
    const candidateMap = new Map<string, T>();
    for (const item of items) {
        if (item.operationId) candidateMap.set(item.operationId, item);
    }

    return items
        .filter((item) => isOwnedBy(item, identity))
        .filter((item) => item.status === "PENDING" || item.status === "FAILED")
        .filter((item) => !item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= now.getTime())
        .filter((item) => {
            // If item has dependencies, check if all are SYNCED
            if (item.dependsOn && item.dependsOn.length > 0) {
                for (const depOpId of item.dependsOn) {
                    const dep = candidateMap.get(depOpId);
                    // If dependency is present and not SYNCED, skip this item for now
                    if (dep && dep.status !== "SYNCED") {
                        return false;
                    }
                }
            }
            return true;
        })
        .sort((a, b) => {
            // Process Product and Customer creations before dependent operations (e.g. Sales)
            const isPrerequisite = (type?: string) => type === "Product" || type === "Customer";
            if (isPrerequisite(a.entityType) && !isPrerequisite(b.entityType)) return -1;
            if (!isPrerequisite(a.entityType) && isPrerequisite(b.entityType)) return 1;
            return a.localSeq - b.localSeq;
        });
}

/**
 * Whether a SYNCING item was interrupted. With an exclusive sync lock held,
 * any SYNCING item must be left over from a crashed or closed tab.
 */
export function isStaleSyncing(item: QueueItemState, now: Date, holdsExclusiveLock: boolean): boolean {
    if (item.status !== "SYNCING") return false;
    if (holdsExclusiveLock) return true;
    const since = item.syncingSince ? new Date(item.syncingSince).getTime() : 0;
    return now.getTime() - since >= STALE_SYNCING_MS;
}

/** Exponential backoff with jitter: ~15s, 30s, 60s ... capped at 30 min. */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
    const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
    // +/- 20% jitter so many devices do not retry at the same moment.
    return Math.round(exponential * (0.8 + 0.4 * random()));
}

export type SyncOutcome =
    | { kind: "success" }
    | { kind: "retryable"; message: string; retryAfterSeconds?: number }
    | { kind: "permanent"; message: string }
    /** Stop the whole run without touching the item (wrong/no session). */
    | { kind: "stop"; message: string }
    /**
     * No answer from the server (network failure or timeout). Says nothing
     * about the operation: the item is left as it was, no attempt is
     * counted, and the run stops.
     */
    | { kind: "unreachable"; message: string };

/** Outcome of a request that got no answer from the server. */
export function unreachableOutcome(): Extract<SyncOutcome, { kind: "unreachable" }> {
    return { kind: "unreachable", message: "The server could not be reached while syncing" };
}

/** Interpret a server response from upload or process. */
export function interpretResponse(
    status: number,
    body: { success?: boolean; code?: string; retryable?: boolean; message?: string; retryAfterSeconds?: number }
): SyncOutcome {
    const message = body?.message || `Server responded with HTTP ${status}`;

    if (status >= 200 && status < 300 && body?.success !== false) {
        return { kind: "success" };
    }

    // Not signed in, the item belongs to another account, or the Origin
    // check refused the request (proxy.ts): leave the item alone. None of
    // these says anything about the sale, so no attempt is counted.
    if (status === 401 || body?.code === "OWNER_MISMATCH" || body?.code === "ORIGIN_REFUSED") {
        return { kind: "stop", message };
    }

    if (status === 409 && body?.code === "IN_PROGRESS") {
        return { kind: "retryable", message, retryAfterSeconds: body.retryAfterSeconds };
    }

    if (body?.retryable === false || status === 400 || status === 422 || body?.code === "OPERATION_ID_CONFLICT") {
        return { kind: "permanent", message };
    }

    // 404 (upload again), 409, 429, 5xx and anything unknown: temporary.
    return { kind: "retryable", message, retryAfterSeconds: body?.retryAfterSeconds };
}

/** Next local state after a failed attempt (attempts includes this one). */
export function stateAfterFailure(
    outcome: Exclude<SyncOutcome, { kind: "success" } | { kind: "stop" } | { kind: "unreachable" }>,
    attempts: number,
    now: Date,
    random: () => number = Math.random
): { status: "FAILED" | "NEEDS_ATTENTION"; nextAttemptAt?: string } {
    if (outcome.kind === "permanent" || attempts >= MAX_CLIENT_ATTEMPTS) {
        return { status: "NEEDS_ATTENTION" };
    }

    const delay = Math.max(backoffDelayMs(attempts, random), (outcome.retryAfterSeconds ?? 0) * 1000);
    return { status: "FAILED", nextAttemptAt: new Date(now.getTime() + delay).toISOString() };
}

/** What happens to a queue item after the outcome of one sync attempt. */
export type ItemDecision =
    | { action: "synced" }
    /** Put the item back exactly as it was (no attempt counted) and end the run. */
    | { action: "restore"; stopReason: "session" | "unreachable" }
    | {
        action: "failed";
        attempts: number;
        status: "FAILED" | "NEEDS_ATTENTION";
        nextAttemptAt?: string;
        message: string;
    };

/**
 * Decide the item's next local state. Only real server answers (retryable
 * or permanent) count as an attempt; a wrong/missing session and an
 * unreachable server leave the item untouched.
 */
export function decideAfterOutcome(
    outcome: SyncOutcome,
    previousAttempts: number,
    now: Date,
    random: () => number = Math.random
): ItemDecision {
    if (outcome.kind === "success") return { action: "synced" };
    if (outcome.kind === "stop") return { action: "restore", stopReason: "session" };
    if (outcome.kind === "unreachable") return { action: "restore", stopReason: "unreachable" };

    const attempts = previousAttempts + 1;
    const next = stateAfterFailure(outcome, attempts, now, random);
    return { action: "failed", attempts, ...next, message: outcome.message };
}

/** Cryptographically secure operation ID. */
export function newOperationId(): string {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
        throw new Error("Secure random IDs are not available in this browser");
    }
    return globalThis.crypto.randomUUID();
}
