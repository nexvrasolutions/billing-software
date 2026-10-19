import { offlineDB, SyncQueueItem } from "./db";
import { assertQueueItemDeletable } from "./pendingGuard";
import { fetchSessionIdentity, getIdentityForQueueing } from "./sessionIdentity";
import { newOperationId, type SessionIdentity } from "./syncPolicy";

/**
 * Queue an operation for later sync. The operation ID is a secure random
 * UUID generated here, and the item is stamped with the signed-in account;
 * callers cannot choose either.
 */
export async function addToSyncQueue(item: {
    operationType: "CREATE";
    entityType: SyncQueueItem["entityType"];
    payload: Record<string, unknown>;
    localSeq?: number;
    dependsOn?: string[];
    operationId?: string;
}) {
    const owner = await getIdentityForQueueing();
    const now = new Date().toISOString();

    const queueItem: SyncQueueItem = {
        operationId: item.operationId || newOperationId(),
        operationType: item.operationType,
        entityType: item.entityType,
        payload: item.payload,
        localSeq: item.localSeq ?? Date.now(),
        status: "PENDING",
        attempts: 0,
        createdAt: now,
        nextAttemptAt: now,
        owner,
        ownerUserId: owner.userId,
        ...(item.dependsOn && item.dependsOn.length > 0 ? { dependsOn: item.dependsOn } : {}),
    };

    const id = await offlineDB.syncQueue.add(queueItem);

    return {
        id,
        operationId: queueItem.operationId,
    };
}

/** All queue items of one account (any status), oldest first. */
export async function getQueueItemsForOwner(identity: SessionIdentity) {
    const items = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    return items
        .filter((item) =>
            item.owner?.tenantId === identity.tenantId && item.owner?.deviceId === identity.deviceId
        )
        .sort((a, b) => a.localSeq - b.localSeq);
}

export async function getSyncQueueItem(
    operationId: string
) {
    return offlineDB.syncQueue
        .where("operationId")
        .equals(operationId)
        .first();
}

export async function markSyncing(id: number) {
    const now = new Date().toISOString();
    await offlineDB.syncQueue.update(id, {
        status: "SYNCING",
        syncingSince: now,
        lastAttemptAt: now,
    });
}

export async function markSynced(id: number) {
    await offlineDB.syncQueue.update(id, {
        status: "SYNCED",
        errorMessage: undefined,
        nextAttemptAt: undefined,
        syncingSince: undefined,
    });
}

/** Record a failed attempt with its new status and next attempt time. */
export async function markAttemptFailed(
    id: number,
    attempts: number,
    status: "FAILED" | "NEEDS_ATTENTION",
    errorMessage: string,
    nextAttemptAt?: string
) {
    await offlineDB.syncQueue.update(id, {
        status,
        attempts,
        errorMessage,
        nextAttemptAt,
        syncingSince: undefined,
        lastAttemptAt: new Date().toISOString(),
    });
}

/**
 * Put an item back without counting an attempt (e.g. wrong session or a
 * refused Origin). With `restore`, lastAttemptAt also returns to the value it
 * had before markSyncing, so the item ends up exactly as it was.
 */
export async function releaseItem(
    id: number,
    status: "PENDING" | "FAILED",
    restore?: { lastAttemptAt?: string }
) {
    await offlineDB.syncQueue.update(id, {
        status,
        syncingSince: undefined,
        ...(restore ? { lastAttemptAt: restore.lastAttemptAt } : {}),
    });
}

/**
 * Delete a queue item. Pending work is protected: only a SYNCED item owned
 * by the account currently signed in (confirmed with the server, without
 * renewing the offline authorization) can be deleted. Anything else throws
 * and nothing is removed.
 */
export async function deleteSyncQueueItem(
    operationId: string
) {
    const item =
        await getSyncQueueItem(operationId);

    const identity = item ? await fetchSessionIdentity() : null;

    assertQueueItemDeletable(item, identity);

    await offlineDB.syncQueue.delete(
        item!.id!
    );
}
