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

    // Operation IDs that must be SYNCED before this item can be processed.
    dependsOn?: string[];
}

export interface MetaRecord {
    key: string;
    value: unknown;
}

export interface CachedProductRecord {
    // Unique key in table: `${tenantId}:${productId}` for multi-tenant safety
    id: string;

    // Original product ID from server (e.g. MongoDB _id or SKU), or local client UUID if pending
    productId: string;

    // Tenant boundary: queries are strictly filtered by this
    tenantId: string;

    name: string;
    SKU: string;
    barcode?: string;
    categoryId?: string;
    unitId?: string;

    sellingPrice: number;
    stockQuantity?: number;

    status: "active" | "inactive";

    taxRate?: number;
    hsnCode?: string;

    // ISO timestamp when this record was cached
    cachedAt: string;

    // Offline product creation sync status (PENDING, SYNCED, or NEEDS_ATTENTION)
    syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";

    // Operation ID of the corresponding SyncQueueItem
    operationId?: string;

    // Error message if sync failed and needs attention
    errorMessage?: string;

    // Opening stock recorded at creation time
    initialStock?: number;
    openingStockOperationId?: string;
}

export interface CachedCustomerRecord {
    // Unique key in table: `${tenantId}:${customerId}` for multi-tenant safety
    id: string;

    // Original customer ID from server (e.g. MongoDB _id), or local client UUID if pending (e.g. `cust_${uuid}`)
    customerId: string;

    // Tenant boundary: queries are strictly filtered by this
    tenantId: string;

    name: string;
    phone?: string;
    email?: string;
    address?: string;

    status: "active" | "inactive";

    // ISO timestamp when this record was cached
    cachedAt: string;

    // Offline customer creation sync status (PENDING, SYNCED, or NEEDS_ATTENTION)
    syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";

    // Operation ID of the corresponding SyncQueueItem
    operationId?: string;

    // Error message if sync failed and needs attention
    errorMessage?: string;
}

export interface CachedSupplierRecord {
    // Unique key in table: `${tenantId}:${supplierId}` for multi-tenant safety
    id: string;

    // Original supplier ID from server (e.g. MongoDB _id), or local client UUID if pending (e.g. `sup_${uuid}`)
    supplierId: string;

    // Tenant boundary: queries are strictly filtered by this
    tenantId: string;

    // Assigned sequential supplier code (e.g. "SUP-0001") or temporary code ("SUP-TEMP-...")
    supplierCode?: string;

    name: string;
    contactPerson?: string;
    phone?: string;
    altPhone?: string;
    email?: string;
    website?: string;
    address?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;

    gstin?: string;
    pan?: string;

    paymentType?: "cash" | "credit";
    creditDays?: number;
    creditLimit?: number;

    category?: string;
    notes?: string;

    status: "active" | "inactive" | "blocked";

    // ISO timestamp when this record was cached
    cachedAt: string;

    // Offline supplier creation/update sync status (PENDING, SYNCED, or NEEDS_ATTENTION)
    syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";

    // Operation ID of the corresponding SyncQueueItem
    operationId?: string;

    // Error message if sync failed and needs attention
    errorMessage?: string;
}

export interface CachedPurchaseItem {
    productId: string;
    quantity: number;
    unitPrice: number;
    discountRate?: number;
    taxRate?: number;
    productSnapshot?: {
        name?: string;
        SKU?: string;
        unit?: string;
    };
}

export interface CachedPurchaseRecord {
    // Unique key in table: `${tenantId}:${purchaseId}` for multi-tenant safety
    id: string;

    // Local client ID (e.g. `pur_${uuid}`) if pending, or server MongoDB _id once synced
    purchaseId: string;

    // Tenant boundary: queries are strictly filtered by this
    tenantId: string;

    // Operation ID of the corresponding SyncQueueItem (unique per purchase creation)
    operationId: string;

    // Purchase number (e.g. "PO-...")
    purchaseNo: string;

    // Supplier ID (server ObjectId or temporary "sup_..." ID)
    supplierId: string;

    supplierCode?: string;
    supplierSnapshot?: {
        name?: string;
        supplierCode?: string;
        phone?: string;
        gstin?: string;
    };

    purchaseDate: string;
    supplierInvoiceNo?: string;
    supplierInvoiceDate?: string;
    dueDate?: string;

    warehouse: {
        name: string;
        location?: string;
    };

    items: CachedPurchaseItem[];

    subtotal?: number;
    discountTotal?: number;
    taxTotal?: number;
    shippingCost?: number;
    grandTotal: number;
    paidAmount: number;
    dueAmount?: number;
    paymentStatus?: "unpaid" | "partial" | "paid";

    status: "draft" | "ordered" | "received" | "cancelled";
    notes?: string;

    // Local sequence number for ordering
    localSeq?: number;

    // ISO timestamp when this record was cached/created locally
    cachedAt: string;

    // Offline purchase creation sync status (PENDING, SYNCING, SYNCED, FAILED, or NEEDS_ATTENTION)
    syncStatus: "PENDING" | "SYNCING" | "SYNCED" | "FAILED" | "NEEDS_ATTENTION";

    // Server-confirmed MongoDB _id once synced
    serverPurchaseId?: string;

    // Error message if sync failed and needs attention
    errorMessage?: string;
}

// Key of the last server-confirmed identity in the meta table.
export const LAST_IDENTITY_KEY = "lastSessionIdentity";

export class OfflineDatabase extends Dexie {
    syncQueue!: Table<SyncQueueItem, number>;
    meta!: Table<MetaRecord, string>;
    offlineSessions!: Table<OfflineSessionRecord, string>;
    cachedProducts!: Table<CachedProductRecord, string>;
    cachedCustomers!: Table<CachedCustomerRecord, string>;
    cachedSuppliers!: Table<CachedSupplierRecord, string>;
    cachedPurchases!: Table<CachedPurchaseRecord, string>;

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

        // Version 3: offline sessions (one per tenant + user +
        // device). Only a new table: existing tables and queued operations
        // are kept exactly as they are (no upgrade function).
        this.version(3).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
            meta: "key",
            offlineSessions: "key",
        });

        // Version 4: offline product catalogue cache (isolated by tenant).
        // Only a new table: existing tables and queued operations
        // are kept exactly as they are (no upgrade function).
        this.version(4).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
            meta: "key",
            offlineSessions: "key",
            cachedProducts: "id, tenantId, SKU, barcode, status",
        });

        // Version 5: offline customer cache (isolated by tenant).
        // Only a new table: existing tables and queued operations
        // are kept exactly as they are (no upgrade function).
        this.version(5).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
            meta: "key",
            offlineSessions: "key",
            cachedProducts: "id, tenantId, SKU, barcode, status",
            cachedCustomers: "id, tenantId, customerId, name, phone, status",
        });

        // Version 6: offline supplier cache (isolated by tenant).
        // Only a new table: existing tables and queued operations
        // are kept exactly as they are (no upgrade function).
        this.version(6).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
            meta: "key",
            offlineSessions: "key",
            cachedProducts: "id, tenantId, SKU, barcode, status",
            cachedCustomers: "id, tenantId, customerId, name, phone, status",
            cachedSuppliers: "id, tenantId, supplierId, supplierCode, name, phone, status",
        });

        // Version 7: offline purchase cache (isolated by tenant).
        // Only a new table: existing tables and queued operations
        // are kept exactly as they are (no upgrade function).
        this.version(7).stores({
            syncQueue: "++id, operationId, status, localSeq, createdAt, ownerUserId",
            meta: "key",
            offlineSessions: "key",
            cachedProducts: "id, tenantId, SKU, barcode, status",
            cachedCustomers: "id, tenantId, customerId, name, phone, status",
            cachedSuppliers: "id, tenantId, supplierId, supplierCode, name, phone, status",
            cachedPurchases: "id, tenantId, purchaseId, operationId, purchaseNo, supplierId, syncStatus, status",
        });
    }
}

export const offlineDB = new OfflineDatabase();

