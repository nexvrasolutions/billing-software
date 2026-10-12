import Dexie, { Table } from "dexie";

import type { LocalSyncStatus, SessionIdentity } from "./syncPolicy";
import type { OfflineSessionRecord } from "./offlineSession";

export interface SyncQueueItem {
    id?: number;

    // Random UUID generated on the device (crypto.randomUUID()).
    operationId: string;

    operationType: "CREATE" | "UPDATE" | "DELETE";

    entityType:
    | "Sale"
    | "Purchase"
    | "SalesReturn"
    | "PurchaseReturn"
    | "Payment"
    | "StockAdjustment"
    | "Customer"
    | "Supplier"
    | "Product";

    payload: Record<string, unknown>;

    status: LocalSyncStatus;

    localSeq: number;

    attempts: number;

    createdAt: string;

    lastAttemptAt?: string;

    errorMessage?: string;

    // Account that queued the operation. Only that same account's session
    // may upload it. Missing on items queued before version 2.
    owner?: SessionIdentity;

    // Owner ID flattened for indexing.
    ownerUserId?: string;

    // Set on items from before ownership tracking: never synced automatically.
    legacyUnowned?: boolean;

    // Earliest time for the next automatic attempt (backoff).
    nextAttemptAt?: string;

    // When the item entered SYNCING (to detect interrupted syncs).
    syncingSince?: string;
}

export interface MetaRecord {
    key: string;
    value: unknown;
}

// Key of the last server-confirmed identity in the meta table.
export const LAST_IDENTITY_KEY = "lastSessionIdentity";

export class OfflineDatabase extends Dexie {
    syncQueue!: Table<SyncQueueItem, number>;
    meta!: Table<MetaRecord, string>;
    offlineSessions!: Table<OfflineSessionRecord, string>;

    constructor() {
        super("billing_offline_db");

        this.version(1).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt",
        });

        // Version 2: ownership, backoff and a small key/value table.
        this.version(2)
            .stores({
                syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
                meta: "key",
            })
            .upgrade(async (tx) => {
                // Items queued before ownership tracking cannot be safely
                // attributed to anyone. Keep them, but never auto-sync them.
                await tx.table("syncQueue").toCollection().modify((item: SyncQueueItem) => {
                    if (!item.owner && item.status !== "SYNCED") {
                        item.legacyUnowned = true;
                        item.status = "NEEDS_ATTENTION";
                        item.errorMessage =
                            "Queued before account tracking; review it before syncing";
                    }
                });
            });

        // Version 3: PIN-protected offline sessions (one per tenant + user +
        // device). Only a new table: existing tables and queued operations
        // are kept exactly as they are (no upgrade function).
        this.version(3).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
            meta: "key",
            offlineSessions: "key",
        });
    }
}

export const offlineDB = new OfflineDatabase();
