/*
 * Offline Product Catalogue Cache
 *
 * Implements Stage 2: offline product catalogue caching.
 *
 * Responsibilities:
 * 1. Safe mapping from authenticated /api/products response to local cache records.
 *    Only authorized product fields are cached; secrets, sensitive cost data,
 *    and customer information are excluded.
 * 2. Strict tenant isolation: cached records are partitioned by tenantId.
 *    Cross-tenant access fails closed and returns empty results.
 * 3. Inactive product filtering for POS selection while preserving archived
 *    products for catalogue management screens.
 * 4. Mapping cached records to POS item DTOs supporting barcode, SKU, and name lookup.
 * 5. Safe, transactional Dexie updates and graceful handling of empty or missing cache.
 */

import { offlineDB, type CachedProductRecord, type OfflineDatabase } from "./db";

export type { CachedProductRecord };

export interface PosItemDto {
    variantId: string;
    name: string;
    sku: string;
    barcode?: string;
    unitCode: string;
    allowsFraction: boolean;
    trackSerial: boolean;
    pricePaise: number;
    taxRate?: string;
    taxLabel: string;
    isTaxConfigured?: boolean;
    hsnCode?: string;
    inStock: string;
    syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";
}

export interface CatalogueCacheMetadata {
    count: number;
    activeCount: number;
    lastCachedAt: string | null;
}

/**
 * Generate a unique compound ID for the Dexie table.
 * Combining tenantId with the product's server ID prevents collisions
 * across tenants even on shared local devices or in mock testing.
 */
export function makeCachedProductId(tenantId: string, rawProductId: string): string {
    return `${tenantId}:${rawProductId}`;
}

/**
 * Safely map a single product from /api/products to a CachedProductRecord.
 *
 * Excludes any customer data, passwords, tokens, or unneeded sensitive fields.
 * Validates that if the product has a tenantId, it matches the authorized tenant.
 * Returns null if the item is invalid, unidentifiable, or belongs to another tenant.
 */
export function mapApiProductToCacheRecord(
    raw: unknown,
    authorizedTenantId: string,
    cachedAt?: string
): CachedProductRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Record<string, unknown>;

    const tenantId = authorizedTenantId.trim();
    if (!tenantId) return null;

    // Defense-in-depth: if product object specifies tenantId, confirm it matches
    if (p.tenantId !== undefined && p.tenantId !== null) {
        const productTenantId = String(p.tenantId).trim();
        if (productTenantId && productTenantId !== tenantId) {
            return null;
        }
    }

    const rawId = String(p._id || p.id || p.SKU || "").trim();
    if (!rawId) return null;

    const name = String(p.name ?? "").trim();
    if (!name) return null;

    const sku = String(p.SKU ?? "").trim().toUpperCase();
    if (!sku) return null;

    const barcode = p.barcode && String(p.barcode).trim() ? String(p.barcode).trim().toUpperCase() : undefined;
    const categoryId = p.categoryId ? String(p.categoryId).trim() : undefined;
    const unitId = p.unitId ? String(p.unitId).trim() : undefined;

    const sellingPrice =
        typeof p.sellingPrice === "number" && Number.isFinite(p.sellingPrice) && p.sellingPrice >= 0
            ? p.sellingPrice
            : 0;

    const rawStock =
        typeof p.stockQuantity === "number" && Number.isFinite(p.stockQuantity)
            ? p.stockQuantity
            : typeof p.stock === "number" && Number.isFinite(p.stock)
            ? p.stock
            : 0;
    const stockQuantity = Math.max(0, rawStock);

    const status: "active" | "inactive" = p.status === "inactive" ? "inactive" : "active";

    const taxRate =
        typeof p.taxRate === "number" && Number.isFinite(p.taxRate) && p.taxRate >= 0 && p.taxRate <= 100
            ? p.taxRate
            : undefined;

    const hsnCode =
        typeof p.hsnCode === "string" && p.hsnCode.trim() !== ""
            ? p.hsnCode.trim()
            : undefined;

    const timestamp = cachedAt ?? new Date().toISOString();

    return {
        id: makeCachedProductId(tenantId, rawId),
        productId: rawId,
        tenantId,
        name,
        SKU: sku,
        ...(barcode ? { barcode } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(unitId ? { unitId } : {}),
        sellingPrice,
        stockQuantity,
        status,
        ...(taxRate !== undefined ? { taxRate } : {}),
        ...(hsnCode ? { hsnCode } : {}),
        cachedAt: timestamp,
    };
}

/**
 * Safely map an array of raw API products into validated, tenant-isolated cache records.
 * Drops nulls, duplicates, and mismatched records.
 */
export function mapApiProductsToCacheRecords(
    rawProducts: unknown[],
    authorizedTenantId: string,
    cachedAt?: string
): CachedProductRecord[] {
    if (!Array.isArray(rawProducts) || !authorizedTenantId?.trim()) return [];

    const tenantId = authorizedTenantId.trim();
    const timestamp = cachedAt ?? new Date().toISOString();
    const records: CachedProductRecord[] = [];
    const seenIds = new Set<string>();

    for (const raw of rawProducts) {
        const record = mapApiProductToCacheRecord(raw, tenantId, timestamp);
        if (record && !seenIds.has(record.id)) {
            seenIds.add(record.id);
            records.push(record);
        }
    }

    return records;
}

/**
 * Convert a CachedProductRecord to a POS Item DTO.
 * Supports barcode, SKU, and name matching in the POS screen.
 */
export function mapCachedProductToPosItem(record: CachedProductRecord): PosItemDto {
    const isTaxConfigured =
        typeof record.taxRate === "number" &&
        Number.isFinite(record.taxRate) &&
        record.taxRate >= 0 &&
        record.taxRate <= 100;
    const taxRateStr = isTaxConfigured ? String(record.taxRate) : undefined;
    const taxLabel = isTaxConfigured
        ? record.taxRate! > 0
            ? `GST ${record.taxRate}%`
            : "GST 0%"
        : "Tax Unspecified";

    return {
        variantId: record.productId,
        name: record.name,
        sku: record.SKU,
        barcode: record.barcode,
        unitCode: "pcs",
        allowsFraction: false,
        trackSerial: false,
        pricePaise: Math.round(record.sellingPrice * 100),
        ...(taxRateStr !== undefined ? { taxRate: taxRateStr } : {}),
        taxLabel,
        isTaxConfigured,
        ...(record.hsnCode ? { hsnCode: record.hsnCode } : {}),
        inStock: String(record.stockQuantity ?? 0),
        syncStatus: record.syncStatus ?? "SYNCED",
    };
}

/**
 * Convert a live API product to a POS Item DTO.
 */
export function mapApiProductToPosItem(p: {
    _id?: string;
    id?: string;
    name: string;
    SKU: string;
    barcode?: string;
    sellingPrice: number;
    stockQuantity?: number;
    stock?: number;
    status?: string;
    taxRate?: number;
    hsnCode?: string;
}): PosItemDto {
    const isTaxConfigured =
        typeof p.taxRate === "number" &&
        Number.isFinite(p.taxRate) &&
        p.taxRate >= 0 &&
        p.taxRate <= 100;
    const taxRateStr = isTaxConfigured ? String(p.taxRate) : undefined;
    const taxLabel = isTaxConfigured
        ? p.taxRate! > 0
            ? `GST ${p.taxRate}%`
            : "GST 0%"
        : "Tax Unspecified";

    return {
        variantId: p._id || p.id || p.SKU,
        name: p.name,
        sku: p.SKU,
        barcode: p.barcode && String(p.barcode).trim() ? String(p.barcode).trim().toUpperCase() : undefined,
        unitCode: "pcs",
        allowsFraction: false,
        trackSerial: false,
        pricePaise: Math.round((p.sellingPrice ?? 0) * 100),
        ...(taxRateStr !== undefined ? { taxRate: taxRateStr } : {}),
        taxLabel,
        isTaxConfigured,
        ...(p.hsnCode ? { hsnCode: String(p.hsnCode).trim() } : {}),
        inStock: String(p.stockQuantity ?? p.stock ?? 10),
        syncStatus: "SYNCED",
    };
}

/**
 * Filter out inactive products.
 * Used for POS selection so cashiers cannot sell discontinued or inactive items.
 */
export function filterActivePosProducts<T extends { status?: string }>(items: T[]): T[] {
    return items.filter((item) => item.status !== "inactive");
}

/**
 * Update the offline product catalogue safely for a specific tenant in Dexie.
 *
 * Uses a single read-write transaction to remove stale records for this tenant
 * and write the newly mapped records. Other tenants' records and all other
 * Dexie stores (syncQueue, meta, offlineSessions) remain untouched.
 */
export async function saveCachedProducts(
    tenantId: string,
    rawProducts: unknown[],
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId) return 0;

    const records = mapApiProductsToCacheRecords(rawProducts, cleanTenantId);

    try {
        await db.transaction("rw", db.cachedProducts, async () => {
            // Preserve products created offline that are pending sync or need attention
            const pending = await db.cachedProducts
                .where("tenantId")
                .equals(cleanTenantId)
                .filter((p) => p.syncStatus === "PENDING" || p.syncStatus === "NEEDS_ATTENTION")
                .toArray();

            await db.cachedProducts.where("tenantId").equals(cleanTenantId).delete();

            const toPut = [...records];
            for (const p of pending) {
                // Keep pending product unless a server record with the exact same ID or SKU now exists
                const conflict = toPut.some(
                    (r) => r.productId === p.productId || (r.SKU && r.SKU.toUpperCase() === p.SKU.toUpperCase())
                );
                if (!conflict) {
                    toPut.push(p);
                }
            }

            if (toPut.length > 0) {
                await db.cachedProducts.bulkPut(toPut);
            }
        });
        return records.length;
    } catch (error) {
        console.warn("Failed to save cached products to offline database:", error);
        return 0;
    }
}

/**
 * Retrieve all cached products for a tenant.
 *
 * Returns both active and inactive products (e.g. for catalogue management).
 * Returns empty array if tenantId is missing, invalid, or no records exist.
 * Never exposes products belonging to other tenants.
 */
export async function getCachedProductsForTenant(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<CachedProductRecord[]> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId) return [];

    try {
        return await db.cachedProducts.where("tenantId").equals(cleanTenantId).toArray();
    } catch (error) {
        console.warn("Failed to load cached products from offline database:", error);
        return [];
    }
}

/**
 * Retrieve active cached products for a tenant mapped to POS item DTOs.
 *
 * Inactive/archived products are excluded.
 * Barcode, SKU, and name fields are populated for offline POS search.
 */
export async function getCachedPosCatalogue(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<PosItemDto[]> {
    const all = await getCachedProductsForTenant(tenantId, db);
    const active = filterActivePosProducts(all);
    return active.map(mapCachedProductToPosItem);
}

/**
 * Clear cached products for a specific tenant (e.g. on account removal or cache purge).
 * Does not touch other stores or other tenants.
 */
export async function clearCachedProductsForTenant(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId) return 0;

    try {
        return await db.cachedProducts.where("tenantId").equals(cleanTenantId).delete();
    } catch (error) {
        console.warn("Failed to clear cached products for tenant:", error);
        return 0;
    }
}

/**
 * Inspect metadata about the tenant's cached catalogue.
 */
export async function getCachedCatalogueMetadata(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<CatalogueCacheMetadata> {
    const records = await getCachedProductsForTenant(tenantId, db);
    if (records.length === 0) {
        return { count: 0, activeCount: 0, lastCachedAt: null };
    }

    const activeCount = records.filter((r) => r.status !== "inactive").length;
    const lastCachedAt = records[0]?.cachedAt ?? null;

    return {
        count: records.length,
        activeCount,
        lastCachedAt,
    };
}

/**
 * Safely save a locally created product in Dexie with PENDING sync status.
 * Rejects with an error if another product for this tenant already uses the same SKU or barcode.
 */
export async function savePendingOfflineProduct(
    input: {
        tenantId: string;
        productId: string;
        name: string;
        SKU: string;
        barcode?: string;
        categoryId?: string;
        unitId?: string;
        sellingPrice: number;
        stockQuantity?: number;
        taxRate?: number;
        hsnCode?: string;
        operationId: string;
    },
    db: OfflineDatabase = offlineDB
): Promise<CachedProductRecord> {
    const cleanTenantId = input.tenantId?.trim();
    if (!cleanTenantId) throw new Error("Tenant ID is required");

    const sku = input.SKU.trim().toUpperCase();
    if (!sku) throw new Error("SKU is required");

    const barcode = input.barcode?.trim() ? input.barcode.trim().toUpperCase() : undefined;

    return await db.transaction("rw", db.cachedProducts, async () => {
        const existing = await db.cachedProducts.where("tenantId").equals(cleanTenantId).toArray();

        // Local duplicate check
        const conflict = existing.find(
            (p) =>
                p.productId !== input.productId &&
                (p.SKU.toUpperCase() === sku || (barcode && p.barcode && p.barcode.trim().toUpperCase() === barcode))
        );

        if (conflict) {
            throw new Error(
                conflict.SKU.toUpperCase() === sku
                    ? `A product with SKU "${sku}" already exists locally.`
                    : `A product with barcode "${barcode}" already exists locally.`
            );
        }

        const now = new Date().toISOString();
        const record: CachedProductRecord = {
            id: makeCachedProductId(cleanTenantId, input.productId),
            productId: input.productId,
            tenantId: cleanTenantId,
            name: input.name.trim(),
            SKU: sku,
            ...(barcode ? { barcode } : {}),
            ...(input.categoryId ? { categoryId: input.categoryId.trim() } : {}),
            ...(input.unitId ? { unitId: input.unitId.trim() } : {}),
            sellingPrice: Math.max(0, input.sellingPrice),
            stockQuantity: Math.max(0, input.stockQuantity ?? 0),
            status: "active",
            ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
            ...(input.hsnCode?.trim() ? { hsnCode: input.hsnCode.trim() } : {}),
            cachedAt: now,
            syncStatus: "PENDING",
            operationId: input.operationId,
            initialStock: input.stockQuantity,
        };

        await db.cachedProducts.put(record);
        return record;
    });
}

/**
 * Resolve a temporary client product ID to the permanent server MongoDB ObjectId.
 * Updates cachedProducts and rewrites any queued sales that referenced the local ID.
 */
export async function resolvePendingProductId(
    localId: string,
    serverId: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<{ resolved: boolean; dependentSalesUpdated: number }> {
    const cleanTenantId = tenantId.trim();
    const cleanLocalId = localId.trim();
    const cleanServerId = serverId.trim();

    if (!cleanTenantId || !cleanLocalId || !cleanServerId) {
        return { resolved: false, dependentSalesUpdated: 0 };
    }

    return await db.transaction("rw", db.cachedProducts, db.syncQueue, async () => {
        // 1. Update cachedProducts
        const oldKey = makeCachedProductId(cleanTenantId, cleanLocalId);
        const existingRecord = await db.cachedProducts.get(oldKey);

        if (existingRecord) {
            await db.cachedProducts.delete(oldKey);
            const updatedRecord: CachedProductRecord = {
                ...existingRecord,
                id: makeCachedProductId(cleanTenantId, cleanServerId),
                productId: cleanServerId,
                syncStatus: "SYNCED",
                errorMessage: undefined,
                cachedAt: new Date().toISOString(),
            };
            await db.cachedProducts.put(updatedRecord);
        }

        // 2. Scan syncQueue for sales (or other operations) referencing localId
        let dependentSalesUpdated = 0;
        const allQueueItems = await db.syncQueue.toArray();

        for (const item of allQueueItems) {
            if (item.id === undefined) continue;

            let modified = false;
            const payload = item.payload ? { ...item.payload } : {};

            // Check if items array contains this productId
            if (Array.isArray(payload.items)) {
                const newItems = payload.items.map((line: any) => {
                    if (line && line.productId === cleanLocalId) {
                        modified = true;
                        return { ...line, productId: cleanServerId };
                    }
                    return line;
                });
                if (modified) {
                    payload.items = newItems;
                }
            }

            // Also check top-level productId (e.g. StockAdjustment)
            if (payload.productId === cleanLocalId) {
                payload.productId = cleanServerId;
                modified = true;
            }

            // Remove productOperationId from dependsOn if resolved
            let newDependsOn = item.dependsOn;
            if (existingRecord?.operationId && newDependsOn && newDependsOn.includes(existingRecord.operationId)) {
                newDependsOn = newDependsOn.filter((opId) => opId !== existingRecord.operationId);
                modified = true;
            }

            if (modified) {
                await db.syncQueue.update(item.id, {
                    payload,
                    dependsOn: newDependsOn && newDependsOn.length > 0 ? newDependsOn : undefined,
                });
                dependentSalesUpdated++;
            }
        }

        return { resolved: true, dependentSalesUpdated };
    });
}

/**
 * Mark a pending product as requiring attention after a permanent sync failure.
 */
export async function markPendingProductNeedsAttention(
    localId: string,
    tenantId: string,
    errorMessage: string,
    db: OfflineDatabase = offlineDB
): Promise<void> {
    const key = makeCachedProductId(tenantId.trim(), localId.trim());
    const record = await db.cachedProducts.get(key);
    if (record) {
        await db.cachedProducts.update(key, {
            syncStatus: "NEEDS_ATTENTION",
            errorMessage,
        });
    }
}

/**
 * Decrement stock in cached products for an offline sale so POS shows real-time quantity.
 */
export async function decrementCachedProductStock(
    productId: string,
    tenantId: string,
    quantity: number,
    db: OfflineDatabase = offlineDB
): Promise<number | null> {
    const cleanTenantId = tenantId.trim();
    const key = makeCachedProductId(cleanTenantId, productId.trim());

    return await db.transaction("rw", db.cachedProducts, async () => {
        const record = await db.cachedProducts.get(key);
        if (!record) return null;

        const currentStock = typeof record.stockQuantity === "number" ? record.stockQuantity : 0;
        const newStock = Math.max(0, currentStock - quantity);

        await db.cachedProducts.update(key, { stockQuantity: newStock });
        return newStock;
    });
}
