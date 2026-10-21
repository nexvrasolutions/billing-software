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
    makeCachedCustomerId,
    resolvePendingCustomerId,
    markPendingCustomerNeedsAttention,
    ensurePendingCustomersQueued,
} from "./customerCache";
import {
    makeCachedSupplierId,
    resolvePendingSupplierId,
    markPendingSupplierNeedsAttention,
    ensurePendingSuppliersQueued,
    isTemporarySupplierId,
} from "./supplierCache";
import { normalizeSupplierUpdatePayload } from "../validations/syncOperations";

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

    // Safety check for dependent Purchase: ensure supplier ID is valid server ID before uploading to server
    if (item.entityType === "Purchase") {
        const rawSupId = typeof item.payload?.supplierId === "string" ? item.payload.supplierId.trim() : "";
        if (rawSupId && isTemporarySupplierId(rawSupId)) {
            const cachedKey = makeCachedSupplierId(identity.tenantId, rawSupId);
            const cached = await offlineDB.cachedSuppliers.get(cachedKey);

            if (cached && cached.syncStatus === "NEEDS_ATTENTION") {
                await markAttemptFailed(
                    id,
                    item.attempts,
                    "NEEDS_ATTENTION",
                    `Dependent supplier creation requires attention: ${cached.errorMessage || "Validation or conflict error"}. Resolve supplier before syncing this purchase.`
                );
                return {
                    operationId: item.operationId,
                    status: "NEEDS_ATTENTION",
                    attempts: item.attempts + 1,
                    error: "Dependent supplier creation requires attention",
                };
            }

            if (!cached) {
                await markAttemptFailed(
                    id,
                    item.attempts,
                    "NEEDS_ATTENTION",
                    `Dependent temporary supplier ${rawSupId} not found in offline cache. Cannot safely sync purchase.`
                );
                return {
                    operationId: item.operationId,
                    status: "NEEDS_ATTENTION",
                    attempts: item.attempts + 1,
                    error: "Dependent supplier not found",
                };
            }

            // Supplier is still pending synchronization; defer purchase upload without counting an attempt
            await releaseItem(id, item.status === "FAILED" ? "FAILED" : "PENDING", { lastAttemptAt: item.lastAttemptAt });
            return { operationId: item.operationId, status: "SKIPPED", attempts: item.attempts };
        }
    }

    // 1. Upload (idempotent: a repeat upload of the same item is accepted).
    let uploadPayload = item.payload;
    if (
        item.entityType === "Supplier" &&
        item.operationType === "UPDATE" &&
        uploadPayload &&
        typeof uploadPayload === "object"
    ) {
        const normalized = normalizeSupplierUpdatePayload(uploadPayload as Record<string, unknown>);
        if (normalized !== uploadPayload) {
            uploadPayload = normalized;
            if (id !== undefined) {
                await offlineDB.syncQueue.update(id, { payload: normalized }).catch(() => {});
            }
        }
    }

    let { outcome, data: uploadData } = await postJson("/api/sync-operations", {
        operationId: item.operationId,
        operationType: item.operationType,
        entityType: item.entityType,
        payload: uploadPayload,
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

        // If this was a Customer CREATE, resolve its local client ID to the server MongoDB ObjectId
        if (item.entityType === "Customer" && item.payload?.localId && item.operationType !== "UPDATE") {
            const serverId = processData?.result?._id || processData?.entityId || processData?.customer?._id;
            if (serverId) {
                await resolvePendingCustomerId(
                    String(item.payload.localId),
                    String(serverId),
                    identity.tenantId
                );
            }
        }

        // If this was a Customer UPDATE, reconcile the local customer cache
        if (item.entityType === "Customer" && item.operationType === "UPDATE") {
            const targetCustomerId = String(item.payload?.customerId || item.payload?._id || "");
            if (targetCustomerId) {
                const cachedKey = makeCachedCustomerId(identity.tenantId, targetCustomerId);
                const cached = await offlineDB.cachedCustomers.get(cachedKey);

                if (cached && cached.tenantId === identity.tenantId) {
                    // Stale response protection:
                    // If the user made a newer edit while this operation was in flight,
                    // cached.operationId will be different from item.operationId.
                    const isNewerLocalEdit = cached.syncStatus === "PENDING" && Boolean(cached.operationId && cached.operationId !== item.operationId);
                    if (!isNewerLocalEdit) {
                        await offlineDB.cachedCustomers.update(cachedKey, {
                            syncStatus: "SYNCED",
                            errorMessage: undefined,
                            cachedAt: new Date().toISOString(),
                        });
                    }
                }
            }
        }

        // If this was a Supplier CREATE, resolve its local client ID and temp code to the server MongoDB ObjectId and official code
        if (item.entityType === "Supplier" && item.payload?.localId && item.operationType !== "UPDATE") {
            const serverId = processData?.result?._id || processData?.entityId || processData?.supplier?._id || processData?.result?.supplierId;
            const serverCode = processData?.result?.supplierCode || processData?.supplierCode;
            if (serverId) {
                await resolvePendingSupplierId(
                    String(item.payload.localId),
                    String(serverId),
                    String(serverCode || ""),
                    identity.tenantId,
                    offlineDB,
                    item.operationId
                );
            }
        }

        // If this was a Supplier UPDATE, reconcile the local supplier cache
        if (item.entityType === "Supplier" && item.operationType === "UPDATE") {
            const targetSupplierId = String(item.payload?.supplierId || item.payload?._id || "");
            if (targetSupplierId) {
                const cachedKey = makeCachedSupplierId(identity.tenantId, targetSupplierId);
                const cached = await offlineDB.cachedSuppliers.get(cachedKey);

                if (cached && cached.tenantId === identity.tenantId) {
                    // Stale response protection:
                    // If the user made a newer edit while this operation was in flight,
                    // cached.operationId will be different from item.operationId.
                    const isNewerLocalEdit = cached.syncStatus === "PENDING" && Boolean(cached.operationId && cached.operationId !== item.operationId);
                    if (!isNewerLocalEdit) {
                        await offlineDB.cachedSuppliers.update(cachedKey, {
                            syncStatus: "SYNCED",
                            errorMessage: undefined,
                            cachedAt: new Date().toISOString(),
                        });
                    }
                }
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
        const targetId = item.payload?.localId || item.payload?.customerId || item.payload?._id;
        if (targetId) {
            await markPendingCustomerNeedsAttention(
                String(targetId),
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

    // If a Supplier failed permanently (e.g. NEEDS_ATTENTION), cascade to cached supplier and dependent purchases
    if (item.entityType === "Supplier" && decision.status === "NEEDS_ATTENTION") {
        const targetId = item.payload?.localId || item.payload?.supplierId || item.payload?._id;
        if (targetId) {
            await markPendingSupplierNeedsAttention(
                String(targetId),
                identity.tenantId,
                decision.message
            );
        }

        // Cascade NEEDS_ATTENTION to dependent purchases in syncQueue
        const localSupId = String(item.payload?.localId || item.payload?.supplierId || "");
        const dependents = await offlineDB.syncQueue
            .filter((q) => {
                if (q.status === "SYNCED") return false;
                const matchesDependsOn = Boolean(q.dependsOn && q.dependsOn.includes(item.operationId));
                const matchesSupplierId = q.entityType === "Purchase" && Boolean(localSupId && q.payload?.supplierId === localSupId);
                return matchesDependsOn || matchesSupplierId;
            })
            .toArray();

        for (const dep of dependents) {
            if (dep.id !== undefined && dep.status !== "SYNCED") {
                await markAttemptFailed(
                    dep.id,
                    dep.attempts,
                    "NEEDS_ATTENTION",
                    `Dependent supplier creation failed: ${decision.message}. Resolve the supplier conflict to sync this purchase.`
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
    await ensurePendingSuppliersQueued(identity.tenantId, offlineDB, identity);

    const userCandidates = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    const allQueue = await offlineDB.syncQueue.toArray();
    const unownedForTenant = allQueue.filter((item) => {
        if (item.status !== "PENDING" && item.status !== "FAILED") return false;
        if (item.ownerUserId === identity.userId && item.owner?.deviceId === identity.deviceId) return false;
        const itemTenant = item.owner?.tenantId || (item.payload as any)?.tenantId;
        return itemTenant === identity.tenantId;
    });

    for (const item of unownedForTenant) {
        if (item.id !== undefined) {
            await offlineDB.syncQueue.update(item.id, {
                owner: identity,
                ownerUserId: identity.userId,
            });
            item.owner = identity;
            item.ownerUserId = identity.userId;
            if (!userCandidates.some((c) => c.id === item.id)) {
                userCandidates.push(item);
            }
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
