import { offlineDB, type SyncQueueItem } from "./db";
import { fetchSessionIdentity, rememberSessionIdentity } from "./sessionIdentity";
import {
    markAttemptFailed,
    markSynced,
    markSyncing,
    releaseItem,
} from "./SyncQueueService";
import {
    interpretResponse,
    isOwnedBy,
    isStaleSyncing,
    selectSyncable,
    stateAfterFailure,
    type SessionIdentity,
    type SyncOutcome,
} from "./syncPolicy";

const SYNC_LOCK_NAME = "billing-offline-sync";

export interface SyncItemResult {
    operationId: string;
    status: "SYNCED" | "FAILED" | "NEEDS_ATTENTION" | "SKIPPED";
    attempts: number;
    error?: string;
}

export interface SyncRunResult {
    ran: boolean;
    reason?: string;
    results: SyncItemResult[];
}

async function postJson(path: string, body: unknown): Promise<SyncOutcome> {
    try {
        const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        return interpretResponse(response.status, data);
    } catch {
        // No connection or the request was interrupted: temporary.
        return { kind: "retryable", message: "Network error while syncing" };
    }
}

/** Put interrupted SYNCING items of this account back in the queue. */
async function recoverInterrupted(identity: SessionIdentity, holdsExclusiveLock: boolean) {
    const now = new Date();
    const syncing = await offlineDB.syncQueue.where("status").equals("SYNCING").toArray();

    for (const item of syncing) {
        if (item.id !== undefined && isOwnedBy(item, identity) && isStaleSyncing(item, now, holdsExclusiveLock)) {
            // The server side is idempotent, so re-sending is safe.
            await releaseItem(item.id, "FAILED");
        }
    }
}

async function syncOne(item: SyncQueueItem, identity: SessionIdentity): Promise<SyncItemResult | "STOP"> {
    const id = item.id!;
    await markSyncing(id);

    // 1. Upload (idempotent: a repeat upload of the same item is accepted).
    let outcome = await postJson("/api/sync-operations", {
        operationId: item.operationId,
        operationType: item.operationType,
        entityType: item.entityType,
        payload: item.payload,
        owner: identity,
    });

    // 2. Ask the server to apply it.
    if (outcome.kind === "success") {
        outcome = await postJson("/api/sync-operations/process", { operationId: item.operationId });
    }

    if (outcome.kind === "success") {
        await markSynced(id);
        return { operationId: item.operationId, status: "SYNCED", attempts: item.attempts + 1 };
    }

    if (outcome.kind === "stop") {
        // Wrong or missing session: keep the item untouched for its owner.
        await releaseItem(id, item.status === "FAILED" ? "FAILED" : "PENDING");
        return "STOP";
    }

    const attempts = item.attempts + 1;
    const next = stateAfterFailure(outcome, attempts, new Date());
    await markAttemptFailed(id, attempts, next.status, outcome.message, next.nextAttemptAt);

    return { operationId: item.operationId, status: next.status, attempts, error: outcome.message };
}

async function runSync(holdsExclusiveLock: boolean): Promise<SyncRunResult> {
    // The authoritative identity is the server session, never local data.
    let identity: SessionIdentity | null;
    try {
        identity = await fetchSessionIdentity();
    } catch {
        // Network or server error: says nothing about the session.
        return { ran: false, reason: "server unreachable", results: [] };
    }

    if (!identity) {
        // The server rejected the session; the remembered identity was
        // forgotten by fetchSessionIdentity. Queued items are kept.
        return { ran: false, reason: "not signed in", results: [] };
    }

    await rememberSessionIdentity(identity);
    await recoverInterrupted(identity, holdsExclusiveLock);

    const candidates = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    const due = selectSyncable(candidates, identity, new Date());
    const results: SyncItemResult[] = [];

    for (const item of due) {
        const result = await syncOne(item, identity);
        if (result === "STOP") {
            return { ran: true, reason: "session changed or ended during sync", results };
        }
        results.push(result);
    }

    return { ran: true, results };
}

/**
 * Sync this account's queued operations. Only one tab syncs at a time
 * (Web Locks API); other tabs skip instead of sending duplicates.
 */
export async function syncPendingOperations(): Promise<SyncRunResult> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return { ran: false, reason: "offline", results: [] };
    }

    if (typeof navigator !== "undefined" && navigator.locks?.request) {
        return navigator.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) =>
            lock ? runSync(true) : { ran: false, reason: "another tab is syncing", results: [] }
        );
    }

    // Without Web Locks, only clearly stale SYNCING items are recovered.
    return runSync(false);
}
