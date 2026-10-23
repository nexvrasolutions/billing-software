/*
 * Offline Purchase Cache
 *
 * Implements Step 2.2: purchase offline cache and local storage foundation.
 *
 * Responsibilities:
 * 1. Safe mapping from purchase input to local cached purchase records.
 * 2. Strict tenant isolation: cached records are partitioned by tenantId (${tenantId}:${purchaseId}).
 *    Cross-tenant queries fail closed and return empty results.
 * 3. Offline purchase creation with temporary local IDs ("pur_...") and stable operation IDs for idempotent sync.
 * 4. Atomic dual-write: writes to cachedPurchases and syncQueue within a single Dexie transaction.
 * 5. Dependency detection: automatically tracks pending temporary supplier IDs ("sup_...") and
 *    temporary product IDs ("prod_...") in the sync queue item's dependsOn array.
 * 6. Reconciliation: idempotent updates of local records upon confirmed server sync.
 */

import {
    offlineDB,
    LAST_IDENTITY_KEY,
    type CachedPurchaseRecord,
    type CachedPurchaseItem,
    type OfflineDatabase,
} from "./db";
import type { SessionIdentity, LocalSyncStatus } from "./syncPolicy";
import {
    offlinePurchasePayloadSchema,
    calculatePurchaseTotals,
    isTemporarySupplierId,
    isTemporaryProductId,
    type OfflinePurchasePayloadInput,
} from "../validations/purchase";
import { makeCachedSupplierId } from "./supplierCache";
import { makeCachedProductId } from "./productCatalogueCache";

export type { CachedPurchaseRecord, CachedPurchaseItem };

export interface SavePendingOfflinePurchaseOptions {
    db?: OfflineDatabase;
    operationId?: string;
    localId?: string;
    owner?: SessionIdentity;
    dependsOn?: string[];
}

export interface SavePendingOfflinePurchaseResult {
    purchase: CachedPurchaseRecord;
    operationId: string;
    localId: string;
    alreadyExists: boolean;
}

export interface GetCachedPurchasesOptions {
    syncStatus?: LocalSyncStatus;
    includeCancelled?: boolean;
}

export interface ReconcileConfirmedPurchaseParams {
    operationId: string;
    tenantId: string;
    serverPurchaseId: string;
    serverPurchaseNo?: string;
}

/**
 * Generate a unique compound ID for the Dexie purchase table.
 * Combining tenantId with the purchase ID prevents cross-tenant collisions.
 */
export function makeCachedPurchaseId(tenantId: string, rawPurchaseId: string): string {
    return `${tenantId.trim()}:${rawPurchaseId.trim()}`;
}

/**
 * Generate a temporary client-side purchase ID (prefixed with "pur_").
 */
export function generateTemporaryPurchaseId(): string {
    return `pur_${crypto.randomUUID()}`;
}

/**
 * Validate whether an identifier is an offline temporary purchase ID (starting with "pur_").
 */
export function isTemporaryPurchaseId(id: unknown): boolean {
    return typeof id === "string" && id.trim().startsWith("pur_");
}

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

/**
 * Validate whether a string is a valid MongoDB ObjectId (24 hex characters).
 */
export function isValidServerPurchaseId(id: unknown): boolean {
    return typeof id === "string" && OBJECT_ID_REGEX.test(id.trim());
}

/**
 * Save an offline purchase locally into cachedPurchases and enqueue a CREATE operation
 * into syncQueue within a single atomic Dexie transaction.
 *
 * Enforces:
 * 1. Strict tenant boundary.
 * 2. Payload validation using offlinePurchasePayloadSchema.
 * 3. Stable, non-empty operation ID across retries.
 * 4. Idempotency: re-submitting with the same operation ID returns existing record.
 * 5. Cross-tenant defense: same operation ID in another tenant is rejected.
 * 6. Automatic dependency tracking: dependsOn array captures pending supplier or product operations.
 * 7. Transaction atomicity: if either table write fails, both roll back.
 */
export async function savePendingOfflinePurchase(
    input: unknown,
    tenantId: string,
    options: SavePendingOfflinePurchaseOptions = {}
): Promise<SavePendingOfflinePurchaseResult> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) {
        throw new Error("Tenant ID is required to save an offline purchase");
    }

    const assignedOpId = (options.operationId || crypto.randomUUID()).trim();
    if (!assignedOpId) {
        throw new Error("Operation ID cannot be empty");
    }

    const assignedLocalId = (options.localId || generateTemporaryPurchaseId()).trim();
    if (!assignedLocalId) {
        throw new Error("Local purchase ID cannot be empty");
    }

    // 1. Validate payload against offline purchase schema
    const validation = offlinePurchasePayloadSchema.safeParse(input);
    if (!validation.success) {
        const firstErr = validation.error.issues[0]?.message || "Invalid offline purchase data";
        throw new Error(`Offline purchase validation failed: ${firstErr}`);
    }
    const data: OfflinePurchasePayloadInput = validation.data;

    const db = options.db || offlineDB;

    // 2. Compute authoritative totals
    const totals = calculatePurchaseTotals(data.items, data.shippingCost);
    const paidAmount = data.paidAmount ?? 0;
    const dueAmount = Math.max(0, totals.grandTotal - paidAmount);
    const paymentStatus: "unpaid" | "partial" | "paid" =
        data.paymentStatus ?? (paidAmount === 0 ? "unpaid" : paidAmount >= totals.grandTotal ? "paid" : "partial");

    // 3. Track dependencies on pending temporary supplier / product operations
    const dependsOnSet = new Set<string>();
    if (options.dependsOn && Array.isArray(options.dependsOn)) {
        for (const dep of options.dependsOn) {
            if (typeof dep === "string" && dep.trim()) {
                dependsOnSet.add(dep.trim());
            }
        }
    }

    // Auto-detect supplier dependency if supplier is temporary
    if (isTemporarySupplierId(data.supplierId)) {
        try {
            const cachedSup = await db.cachedSuppliers?.get(makeCachedSupplierId(cleanTenantId, data.supplierId));
            if (cachedSup?.operationId && cachedSup.syncStatus !== "SYNCED") {
                dependsOnSet.add(cachedSup.operationId);
            }
        } catch {}
    }

    // Auto-detect product dependencies if any item is temporary
    for (const item of data.items) {
        if (isTemporaryProductId(item.productId)) {
            try {
                const cachedProd = await db.cachedProducts?.get(makeCachedProductId(cleanTenantId, item.productId));
                if (cachedProd?.operationId && cachedProd.syncStatus !== "SYNCED") {
                    dependsOnSet.add(cachedProd.operationId);
                }
            } catch {}
        }
    }

    // 4. Resolve session ownership
    let owner: SessionIdentity | undefined = options.owner;
    if (!owner && db.meta?.get) {
        try {
            const remembered = await db.meta.get(LAST_IDENTITY_KEY);
            if (remembered?.value && typeof remembered.value === "object") {
                const idRecord = remembered.value as SessionIdentity;
                if (idRecord.tenantId === cleanTenantId) {
                    owner = idRecord;
                }
            }
        } catch {}
    }
    if (!owner) {
        owner = { tenantId: cleanTenantId, userId: "", deviceId: "" };
    }

    const nowIso = new Date().toISOString();
    const purchaseKey = makeCachedPurchaseId(cleanTenantId, assignedLocalId);

    const record: CachedPurchaseRecord = {
        id: purchaseKey,
        purchaseId: assignedLocalId,
        tenantId: cleanTenantId,
        operationId: assignedOpId,
        purchaseNo: data.purchaseNo,
        supplierId: data.supplierId,
        supplierCode: data.supplierCode,
        supplierSnapshot: data.supplierSnapshot,
        purchaseDate: data.purchaseDate ? new Date(data.purchaseDate).toISOString() : nowIso,
        supplierInvoiceNo: data.supplierInvoiceNo,
        supplierInvoiceDate: data.supplierInvoiceDate ? new Date(data.supplierInvoiceDate).toISOString() : undefined,
        dueDate: data.dueDate ? new Date(data.dueDate).toISOString() : undefined,
        warehouse: data.warehouse,
        items: data.items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discountRate: it.discountRate ?? 0,
            taxRate: it.taxRate ?? 0,
            productSnapshot: it.productSnapshot,
        })),
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        shippingCost: totals.shippingCost,
        grandTotal: totals.grandTotal,
        paidAmount,
        dueAmount,
        paymentStatus,
        status: "received",
        notes: data.notes,
        localSeq: Date.now(),
        cachedAt: nowIso,
        syncStatus: "PENDING",
    };

    // 5. Dual-write inside an atomic Dexie transaction
    return await db.transaction("rw", db.cachedPurchases, db.syncQueue, async () => {
        // Idempotency pre-check on syncQueue
        const queueWhere = db.syncQueue.where("operationId").equals(assignedOpId);
        const existingQueueItem = typeof queueWhere.first === "function"
            ? await queueWhere.first()
            : (await queueWhere.toArray())[0];

        if (existingQueueItem) {
            const queuePayload = existingQueueItem.payload as Record<string, unknown> | undefined;
            const existingTenant = existingQueueItem.owner?.tenantId || queuePayload?.tenantId;
            if (existingTenant && String(existingTenant).trim() !== cleanTenantId) {
                throw new Error(`Cross-tenant operation ID conflict: operation '${assignedOpId}' belongs to another tenant`);
            }

            // Tenant matches: idempotent return
            const purchaseWhere = db.cachedPurchases.where("operationId").equals(assignedOpId);
            const existingCached = (await db.cachedPurchases.get(purchaseKey))
                || (typeof purchaseWhere.first === "function"
                    ? await purchaseWhere.first()
                    : (await purchaseWhere.toArray())[0]);

            if (existingCached && existingCached.tenantId === cleanTenantId) {
                return {
                    purchase: existingCached,
                    operationId: assignedOpId,
                    localId: existingCached.purchaseId,
                    alreadyExists: true,
                };
            }
        }

        // Defense-in-depth: check if target key already exists for another tenant
        const targetExisting = await db.cachedPurchases.get(purchaseKey);
        if (targetExisting && targetExisting.tenantId !== cleanTenantId) {
            throw new Error(`Cross-tenant key collision on purchase '${purchaseKey}'`);
        }

        // Write cached purchase record
        await db.cachedPurchases.put(record);

        // Enqueue sync operation
        const dependsOnArray = Array.from(dependsOnSet);
        const queuePayload: Record<string, unknown> = {
            ...data,
            localId: assignedLocalId,
            operationId: assignedOpId,
            subtotal: totals.subtotal,
            discountTotal: totals.discountTotal,
            taxTotal: totals.taxTotal,
            shippingCost: totals.shippingCost,
            grandTotal: totals.grandTotal,
            dueAmount,
            paidAmount,
            paymentStatus,
        };

        await db.syncQueue.add({
            operationId: assignedOpId,
            operationType: "CREATE",
            entityType: "Purchase",
            payload: queuePayload,
            localSeq: record.localSeq || Date.now(),
            status: "PENDING",
            attempts: 0,
            createdAt: nowIso,
            nextAttemptAt: nowIso,
            owner,
            ownerUserId: owner?.userId,
            ...(dependsOnArray.length > 0 ? { dependsOn: dependsOnArray } : {}),
        });

        return {
            purchase: record,
            operationId: assignedOpId,
            localId: assignedLocalId,
            alreadyExists: false,
        };
    });
}

/**
 * Retrieve cached purchases for a tenant, strictly isolated by tenantId.
 */
export async function getCachedPurchasesForTenant(
    tenantId: string,
    options: GetCachedPurchasesOptions = {},
    db: OfflineDatabase = offlineDB
): Promise<CachedPurchaseRecord[]> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) return [];

    const records = await db.cachedPurchases
        .where("tenantId")
        .equals(cleanTenantId)
        .toArray();

    const filtered = records.filter((p) => {
        if (p.tenantId !== cleanTenantId) return false;
        if (options.syncStatus && p.syncStatus !== options.syncStatus) return false;
        if (!options.includeCancelled && p.status === "cancelled") return false;
        return true;
    });

    return filtered.sort((a, b) => new Date(b.cachedAt).getTime() - new Date(a.cachedAt).getTime());
}

/**
 * Maps a raw purchase record from the server API into a local CachedPurchaseRecord.
 */
export function mapApiPurchaseToCacheRecord(
    raw: unknown,
    tenantId: string,
    cachedAt?: string
): CachedPurchaseRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Record<string, unknown>;

    const rawId = String(p._id || p.purchaseId || p.id || "").trim();
    if (!rawId) return null;

    const purchaseNo = String(p.purchaseNo || "").trim();
    if (!purchaseNo) return null;

    const supplierId = String(p.supplierId || (p.supplier as Record<string, unknown>)?._id || "").trim();
    const supplierCode = String(
        (p.supplierSnapshot as Record<string, unknown>)?.supplierCode ||
        p.supplierCode ||
        ""
    ).trim() || undefined;

    const supplierSnapshot = p.supplierSnapshot && typeof p.supplierSnapshot === "object"
        ? (p.supplierSnapshot as { name?: string; supplierCode?: string; phone?: string; gstin?: string })
        : undefined;

    const purchaseDate = p.purchaseDate ? new Date(p.purchaseDate as string).toISOString() : (cachedAt || new Date().toISOString());
    const supplierInvoiceNo = String(p.supplierInvoiceNo || "").trim() || undefined;
    const supplierInvoiceDate = p.supplierInvoiceDate ? new Date(p.supplierInvoiceDate as string).toISOString() : undefined;
    const dueDate = p.dueDate ? new Date(p.dueDate as string).toISOString() : undefined;

    const rawWarehouse = p.warehouse as Record<string, unknown> | undefined;
    const warehouse = {
        name: String(rawWarehouse?.name || "Main Store").trim(),
        location: rawWarehouse?.location ? String(rawWarehouse.location).trim() : undefined,
    };

    const rawItems = Array.isArray(p.items) ? p.items : [];
    const items: CachedPurchaseItem[] = rawItems.map((itemRaw: unknown) => {
        const item = (itemRaw && typeof itemRaw === "object" ? itemRaw : {}) as Record<string, unknown>;
        const snap = item.productSnapshot as Record<string, unknown> | undefined;
        return {
            productId: String(item.productId || "").trim(),
            quantity: Number(item.quantity) || 0,
            unitPrice: Number(item.unitPrice) || 0,
            discountRate: item.discountRate !== undefined ? Number(item.discountRate) : undefined,
            taxRate: item.taxRate !== undefined ? Number(item.taxRate) : undefined,
            productSnapshot: snap ? {
                name: snap.name ? String(snap.name) : undefined,
                SKU: snap.SKU ? String(snap.SKU) : undefined,
                unit: snap.unit ? String(snap.unit) : undefined,
            } : undefined,
        };
    });

    const subtotal = p.subtotal !== undefined ? Number(p.subtotal) : undefined;
    const discountTotal = p.discountTotal !== undefined ? Number(p.discountTotal) : undefined;
    const taxTotal = p.taxTotal !== undefined ? Number(p.taxTotal) : undefined;
    const shippingCost = p.shippingCost !== undefined ? Number(p.shippingCost) : undefined;

    const grandTotal = Number(p.grandTotal) || 0;
    const paidAmount = Number(p.paidAmount) || 0;
    const dueAmount = p.dueAmount !== undefined ? Number(p.dueAmount) : Math.max(0, grandTotal - paidAmount);

    let paymentStatus: "unpaid" | "partial" | "paid" = "unpaid";
    if (p.paymentStatus === "paid" || p.paymentStatus === "partial" || p.paymentStatus === "unpaid") {
        paymentStatus = p.paymentStatus;
    } else {
        paymentStatus = paidAmount === 0 ? "unpaid" : paidAmount >= grandTotal ? "paid" : "partial";
    }

    let status: "draft" | "ordered" | "received" | "cancelled" = "received";
    if (p.status === "draft" || p.status === "ordered" || p.status === "received" || p.status === "cancelled") {
        status = p.status;
    }

    const notes = p.notes ? String(p.notes).trim() : undefined;
    const operationId = String(p.operationId || "").trim();

    return {
        id: makeCachedPurchaseId(tenantId, rawId),
        purchaseId: rawId,
        serverPurchaseId: rawId,
        tenantId,
        operationId: operationId || `op-server-${rawId}`,
        purchaseNo,
        supplierId,
        ...(supplierCode ? { supplierCode } : {}),
        ...(supplierSnapshot ? { supplierSnapshot } : {}),
        purchaseDate,
        ...(supplierInvoiceNo ? { supplierInvoiceNo } : {}),
        ...(supplierInvoiceDate ? { supplierInvoiceDate } : {}),
        ...(dueDate ? { dueDate } : {}),
        warehouse,
        items,
        ...(subtotal !== undefined ? { subtotal } : {}),
        ...(discountTotal !== undefined ? { discountTotal } : {}),
        ...(taxTotal !== undefined ? { taxTotal } : {}),
        ...(shippingCost !== undefined ? { shippingCost } : {}),
        grandTotal,
        paidAmount,
        dueAmount,
        paymentStatus,
        status,
        ...(notes ? { notes } : {}),
        cachedAt: cachedAt || new Date().toISOString(),
        syncStatus: "SYNCED",
    };
}

/**
 * Persist an array of purchases fetched from /api/purchases into IndexedDB.
 * Preserves pending offline records so local creations are never overwritten by server fetches.
 */
export async function saveCachedPurchases(
    purchases: unknown[],
    authorizedTenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = authorizedTenantId.trim();
    if (!cleanTenantId || !Array.isArray(purchases)) return 0;

    const nowIso = new Date().toISOString();
    const mappedRecords: CachedPurchaseRecord[] = [];

    for (const item of purchases) {
        const record = mapApiPurchaseToCacheRecord(item, cleanTenantId, nowIso);
        if (record) {
            mappedRecords.push(record);
        }
    }

    return await db.transaction("rw", db.cachedPurchases, async () => {
        // Collect existing pending, syncing, needs_attention, or failed offline records to preserve them
        const existingRecords = await db.cachedPurchases
            .where("tenantId")
            .equals(cleanTenantId)
            .toArray();

        const preservedKeys = new Set<string>();
        for (const existing of existingRecords) {
            if (existing.syncStatus !== "SYNCED") {
                preservedKeys.add(existing.id);
            }
        }

        let savedCount = 0;
        for (const record of mappedRecords) {
            if (!preservedKeys.has(record.id)) {
                await db.cachedPurchases.put(record);
                savedCount++;
            }
        }

        return savedCount;
    });
}

/**
 * Retrieve a cached purchase by its purchaseId (server _id or localId) for the active tenant.
 */
export async function getCachedPurchaseById(
    purchaseId: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<CachedPurchaseRecord | null> {
    const cleanTenantId = tenantId.trim();
    const cleanPurchaseId = purchaseId.trim();
    if (!cleanTenantId || !cleanPurchaseId) return null;

    const key = makeCachedPurchaseId(cleanTenantId, cleanPurchaseId);
    const record = await db.cachedPurchases.get(key);
    if (!record || record.tenantId !== cleanTenantId) return null;
    return record;
}

/**
 * Retrieve a cached purchase by its operationId for the active tenant.
 */
export async function getCachedPurchaseByOperationId(
    operationId: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<CachedPurchaseRecord | null> {
    const cleanTenantId = tenantId.trim();
    const cleanOpId = operationId.trim();
    if (!cleanTenantId || !cleanOpId) return null;

    const records = await db.cachedPurchases
        .where("operationId")
        .equals(cleanOpId)
        .toArray();

    const match = records.find((r) => r.tenantId === cleanTenantId);
    return match || null;
}

/**
 * Reconcile a local cached purchase after a confirmed server sync.
 *
 * Updates:
 * - Assigns the confirmed server MongoDB _id as purchaseId and serverPurchaseId.
 * - Updates purchaseNo if assigned sequentially by server.
 * - Updates syncStatus to "SYNCED" and clears errorMessage.
 * - Re-indexes under `${tenantId}:${serverPurchaseId}` and removes the old temporary key.
 * - Idempotent: repeated calls with the same confirmed server ID leave state valid.
 */
export async function reconcileConfirmedPurchaseSync(
    params: ReconcileConfirmedPurchaseParams,
    db: OfflineDatabase = offlineDB
): Promise<{ reconciled: boolean; purchase?: CachedPurchaseRecord }> {
    const cleanTenantId = params.tenantId?.trim();
    const cleanOpId = params.operationId?.trim();
    const cleanServerId = params.serverPurchaseId?.trim();

    if (!cleanTenantId || !cleanOpId || !cleanServerId) {
        return { reconciled: false };
    }

    return await db.transaction("rw", db.cachedPurchases, async () => {
        const existing = await getCachedPurchaseByOperationId(cleanOpId, cleanTenantId, db);
        if (!existing || existing.tenantId !== cleanTenantId) {
            return { reconciled: false };
        }

        // Idempotency: already reconciled
        if (
            existing.syncStatus === "SYNCED" &&
            (existing.purchaseId === cleanServerId || existing.serverPurchaseId === cleanServerId)
        ) {
            return { reconciled: true, purchase: existing };
        }

        const oldKey = existing.id;
        const newKey = makeCachedPurchaseId(cleanTenantId, cleanServerId);
        const nowIso = new Date().toISOString();

        if (oldKey !== newKey) {
            await db.cachedPurchases.delete(oldKey);
        }

        const updated: CachedPurchaseRecord = {
            ...existing,
            id: newKey,
            purchaseId: cleanServerId,
            serverPurchaseId: cleanServerId,
            purchaseNo: params.serverPurchaseNo || existing.purchaseNo,
            syncStatus: "SYNCED",
            errorMessage: undefined,
            cachedAt: nowIso,
        };

        await db.cachedPurchases.put(updated);
        return { reconciled: true, purchase: updated };
    });
}

/**
 * Mark a cached purchase as FAILED or NEEDS_ATTENTION.
 * Never silently deletes records.
 */
export async function markCachedPurchaseFailed(
    params: {
        operationId: string;
        tenantId: string;
        status: "FAILED" | "NEEDS_ATTENTION";
        errorMessage?: string;
    },
    db: OfflineDatabase = offlineDB
): Promise<boolean> {
    const cleanTenantId = params.tenantId?.trim();
    const cleanOpId = params.operationId?.trim();
    if (!cleanTenantId || !cleanOpId) return false;

    return await db.transaction("rw", db.cachedPurchases, async () => {
        const existing = await getCachedPurchaseByOperationId(cleanOpId, cleanTenantId, db);
        if (!existing || existing.tenantId !== cleanTenantId) return false;

        await db.cachedPurchases.update(existing.id, {
            syncStatus: params.status,
            errorMessage:
                params.errorMessage ||
                (params.status === "NEEDS_ATTENTION" ? "Sync requires attention" : "Sync attempt failed"),
        });
        return true;
    });
}

/**
 * Clear cached purchases for a tenant (e.g. on account sign-out or cache purge).
 */
export async function clearCachedPurchasesForTenant(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) return 0;

    return await db.transaction("rw", db.cachedPurchases, async () => {
        const records = await db.cachedPurchases.where("tenantId").equals(cleanTenantId).toArray();
        for (const r of records) {
            await db.cachedPurchases.delete(r.id);
        }
        return records.length;
    });
}

/**
 * Ensure all locally cached purchases in PENDING status have a corresponding
 * item in the syncQueue. Used on sync runs or app initialization for self-healing.
 */
export async function ensurePendingPurchasesQueued(
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    owner?: SessionIdentity
): Promise<number> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId || !db.cachedPurchases || !db.syncQueue) return 0;

    return await db.transaction("rw", db.cachedPurchases, db.syncQueue, async () => {
        const pendingPurchases = await db.cachedPurchases
            .where("tenantId")
            .equals(cleanTenantId)
            .filter((p) => p.syncStatus === "PENDING")
            .toArray();

        let queuedCount = 0;
        const nowIso = new Date().toISOString();

        for (const purchase of pendingPurchases) {
            const opId = purchase.operationId || crypto.randomUUID();
            const queueWhere = db.syncQueue.where("operationId").equals(opId);
            const existingItem = typeof queueWhere.first === "function"
                ? await queueWhere.first()
                : (await queueWhere.toArray())[0];

            if (!existingItem) {
                const payload: Record<string, unknown> = {
                    purchaseNo: purchase.purchaseNo,
                    supplierId: purchase.supplierId,
                    warehouse: purchase.warehouse,
                    items: purchase.items,
                    purchaseDate: purchase.purchaseDate,
                    localId: purchase.purchaseId,
                    operationId: opId,
                    grandTotal: purchase.grandTotal,
                    subtotal: purchase.subtotal,
                    discountTotal: purchase.discountTotal,
                    taxTotal: purchase.taxTotal,
                    shippingCost: purchase.shippingCost,
                    paidAmount: purchase.paidAmount,
                    dueAmount: purchase.dueAmount,
                    paymentStatus: purchase.paymentStatus,
                    status: purchase.status,
                    ...(purchase.supplierCode ? { supplierCode: purchase.supplierCode } : {}),
                    ...(purchase.supplierSnapshot ? { supplierSnapshot: purchase.supplierSnapshot } : {}),
                    ...(purchase.supplierInvoiceNo ? { supplierInvoiceNo: purchase.supplierInvoiceNo } : {}),
                    ...(purchase.supplierInvoiceDate ? { supplierInvoiceDate: purchase.supplierInvoiceDate } : {}),
                    ...(purchase.dueDate ? { dueDate: purchase.dueDate } : {}),
                    ...(purchase.notes ? { notes: purchase.notes } : {}),
                };

                await db.syncQueue.add({
                    operationId: opId,
                    operationType: "CREATE",
                    entityType: "Purchase",
                    payload,
                    localSeq: purchase.localSeq || Date.now(),
                    status: "PENDING",
                    attempts: 0,
                    createdAt: purchase.cachedAt || nowIso,
                    nextAttemptAt: nowIso,
                    owner,
                    ownerUserId: owner?.userId,
                });
                queuedCount++;

                if (purchase.operationId !== opId) {
                    await db.cachedPurchases.update(purchase.id, { operationId: opId });
                }
            } else if (owner && (!existingItem.ownerUserId || !existingItem.owner)) {
                if (existingItem.id !== undefined && typeof db.syncQueue.update === "function") {
                    await db.syncQueue.update(existingItem.id, {
                        owner,
                        ownerUserId: owner.userId,
                    });
                }
            }
        }

        return queuedCount;
    });
}

