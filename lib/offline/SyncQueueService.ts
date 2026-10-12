import { offlineDB, SyncQueueItem } from "./db";
import { getIdentityForQueueing } from "./sessionIdentity";
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
}) {
    const owner = await getIdentityForQueueing();
    const now = new Date().toISOString();

    const queueItem: SyncQueueItem = {
        operationId: newOperationId(),
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

/** Put an item back without counting an attempt (e.g. wrong session). */
export async function releaseItem(id: number, status: "PENDING" | "FAILED") {
    await offlineDB.syncQueue.update(id, { status, syncingSince: undefined });
}

export async function deleteSyncQueueItem(
    operationId: string
) {
    const item =
        await getSyncQueueItem(operationId);

    if (!item) {
        throw new Error(
            "Sync queue item not found"
        );
    }

    await offlineDB.syncQueue.delete(
        item.id!
    );
}
