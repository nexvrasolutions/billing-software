import { offlineDB, type SyncQueueItem } from "./db";
import { fetchSessionIdentity, rememberSessionIdentity } from "./sessionIdentity";
import {
    markAttemptFailed,
    markSynced,
    markSyncing,
    releaseItem,
} from "./SyncQueueService";
import {
    decideAfterOutcome,
    interpretResponse,
    isOwnedBy,
    isStaleSyncing,
    selectSyncable,
    unreachableOutcome,
    type SessionIdentity,
    type SyncOutcome,
} from "./syncPolicy";
import { summarizeQueue, type QueueSummary } from "./queueStatus";
import {
    resolvePendingProductId,
    markPendingProductNeedsAttention,
} from "./productCatalogueCache";
import {
    resolvePendingCustomerId,
    markPendingCustomerNeedsAttention,
    ensurePendingCustomersQueued,
} from "./customerCache";

const SYNC_LOCK_NAME = "billing-offline-sync";

/**
 * Longest wait for one upload or process request. A timeout is
 * "unreachable": no attempt is counted and the item is left as it was. If
 * the server still finished the request, the next sync re-sends the same
 * operation ID and the server answers "already exists" / "already synced".
 */
export const SYNC_REQUEST_TIMEOUT_MS = 20_000;

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
    /** This account's queue after the run (only when the run started). */
    remaining?: QueueSummary;
}

/** Read-only summary of the items owned by this account. */
async function remainingFor(identity: SessionIdentity): Promise<QueueSummary> {
    const items = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    return summarizeQueue(items.filter((item) => isOwnedBy(item, identity)));
}

async function postJson(path: string, body: unknown): Promise<{ outcome: SyncOutcome; data: any }> {
    try {
        const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
        });
        const data = await response.json().catch(() => ({}));
        return { outcome: interpretResponse(response.status, data), data };
    } catch {
        // No answer from the server (no connection, interrupted request,
        // timeout): not counted as an attempt; the item is left as it was.
        return { outcome: unreachableOutcome(), data: {} };
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

async function syncOne(item: SyncQueueItem, identity: SessionIdentity): Promise<SyncItemResult | "STOP" | "UNREACHABLE"> {
    const id = item.id!;
    await markSyncing(id);

    // 1. Upload (idempotent: a repeat upload of the same item is accepted).
    let { outcome, data: uploadData } = await postJson("/api/sync-operations", {
        operationId: item.operationId,
        operationType: item.operationType,
        entityType: item.entityType,
        payload: item.payload,
        owner: identity,
    });

    let processData: any = uploadData;

    // 2. Ask the server to apply it.
    if (outcome.kind === "success") {
        const res = await postJson("/api/sync-operations/process", { operationId: item.operationId });
        outcome = res.outcome;
        processData = res.data;
    }

    const decision = decideAfterOutcome(outcome, item.attempts, new Date());

    if (decision.action === "synced") {
        await markSynced(id);

        // If this was a Product, resolve its local client ID to the server MongoDB ObjectId
        if (item.entityType === "Product" && item.payload?.localId) {
            const serverId = processData?.result?._id || processData?.entityId || processData?.product?._id;
            if (serverId) {
                await resolvePendingProductId(
                    String(item.payload.localId),
                    String(serverId),
                    identity.tenantId
                );
            }
        }

        // If this was a Customer, resolve its local client ID to the server MongoDB ObjectId
        if (item.entityType === "Customer" && item.payload?.localId) {
            const serverId = processData?.result?._id || processData?.entityId || processData?.customer?._id;
            if (serverId) {
                await resolvePendingCustomerId(
                    String(item.payload.localId),
                    String(serverId),
                    identity.tenantId
                );
            }
        }

        // If this was a Sale, reconcile the server permanent invoice number and server sale ID locally
        if (item.entityType === "Sale") {
            const serverSaleId = processData?.sale?.id || processData?.result?._id;
            const permanentInvoiceNo = processData?.sale?.invoiceNo || processData?.result?.invoiceNo;
            if (permanentInvoiceNo) {
                await offlineDB.syncQueue.update(id, {
                    payload: {
                        ...item.payload,
                        serverSaleId: String(serverSaleId || ""),
                        permanentInvoiceNo: String(permanentInvoiceNo),
                        invoiceNo: String(permanentInvoiceNo),
                        syncedAt: new Date().toISOString(),
                    },
                });
            }
        }

        return { operationId: item.operationId, status: "SYNCED", attempts: item.attempts + 1 };
    }

    if (decision.action === "restore") {
        // Wrong or missing session, a refused Origin, or no answer from the
        // server: keep the item untouched for its owner (no attempt counted,
        // status and lastAttemptAt restored to what they were before this
        // run; attempts, payload and nextAttemptAt are never changed here).
        await releaseItem(id, item.status === "FAILED" ? "FAILED" : "PENDING", { lastAttemptAt: item.lastAttemptAt });
        return decision.stopReason === "session" ? "STOP" : "UNREACHABLE";
    }

    await markAttemptFailed(id, decision.attempts, decision.status, decision.message, decision.nextAttemptAt);

    // If a Product failed permanently (e.g. NEEDS_ATTENTION), cascade to cached product and dependent sales
    if (item.entityType === "Product" && decision.status === "NEEDS_ATTENTION") {
        if (item.payload?.localId) {
            await markPendingProductNeedsAttention(
                String(item.payload.localId),
                identity.tenantId,
                decision.message
            );
        }

        // Cascade NEEDS_ATTENTION to dependent sales in syncQueue
        const dependents = await offlineDB.syncQueue
            .filter((q) => Boolean(q.dependsOn && q.dependsOn.includes(item.operationId)))
            .toArray();

        for (const dep of dependents) {
            if (dep.id !== undefined && dep.status !== "SYNCED") {
                await markAttemptFailed(
                    dep.id,
                    dep.attempts,
                    "NEEDS_ATTENTION",
                    `Dependent product creation failed: ${decision.message}. Resolve the product conflict to sync this sale.`
                );
            }
        }
    }

    // If a Customer failed permanently (e.g. NEEDS_ATTENTION), cascade to cached customer and dependent sales
    if (item.entityType === "Customer" && decision.status === "NEEDS_ATTENTION") {
        if (item.payload?.localId) {
            await markPendingCustomerNeedsAttention(
                String(item.payload.localId),
                identity.tenantId,
                decision.message
            );
        }

        // Cascade NEEDS_ATTENTION to dependent sales in syncQueue
        const dependents = await offlineDB.syncQueue
            .filter((q) => Boolean(q.dependsOn && q.dependsOn.includes(item.operationId)))
            .toArray();

        for (const dep of dependents) {
            if (dep.id !== undefined && dep.status !== "SYNCED") {
                await markAttemptFailed(
                    dep.id,
                    dep.attempts,
                    "NEEDS_ATTENTION",
                    `Dependent customer creation failed: ${decision.message}. Resolve the customer conflict to sync this sale.`
                );
            }
        }
    }

    return { operationId: item.operationId, status: decision.status, attempts: decision.attempts, error: decision.message };
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
    await ensurePendingCustomersQueued(identity.tenantId, offlineDB, identity);

    const userCandidates = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    const allQueue = await offlineDB.syncQueue.toArray();
    const unownedForTenant = allQueue.filter((item) => {
        if (item.status !== "PENDING" && item.status !== "FAILED") return false;
        if (item.ownerUserId === identity.userId) return false;
        return item.owner?.tenantId === identity.tenantId && (!item.ownerUserId || !item.owner?.userId);
    });

    for (const item of unownedForTenant) {
        if (item.id !== undefined) {
            await offlineDB.syncQueue.update(item.id, {
                owner: identity,
                ownerUserId: identity.userId,
            });
            item.owner = identity;
            item.ownerUserId = identity.userId;
            userCandidates.push(item);
        }
    }

    const candidates = userCandidates;
    const due = selectSyncable(candidates, identity, new Date());
    const results: SyncItemResult[] = [];

    for (const item of due) {
        // Defense in depth: never upload an item under an identity that
        // does not own it (selectSyncable already filters by owner).
        if (!isOwnedBy(item, identity)) continue;

        const result = await syncOne(item, identity);
        if (result === "STOP") {
            return { ran: true, reason: "session changed or ended during sync", results, remaining: await remainingFor(identity) };
        }
        if (result === "UNREACHABLE") {
            // Without the server the remaining items cannot be sent either.
            return { ran: true, reason: "server unreachable during sync", results, remaining: await remainingFor(identity) };
        }
        results.push(result);
    }

    return { ran: true, results, remaining: await remainingFor(identity) };
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
