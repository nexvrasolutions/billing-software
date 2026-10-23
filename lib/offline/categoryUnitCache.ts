/*
 * Offline Category and Unit Cache
 *
 * Implements tenant-scoped offline caching for categories and units:
 * 1. Safe mapping from authenticated /api/categories and /api/units responses.
 * 2. Strict tenant isolation: cached records are partitioned by tenantId.
 * 3. Active-record filtering: inactive records are excluded from product creation dropdowns.
 * 4. Safe storage in existing Dexie meta store without requiring a schema migration or version bump.
 * 5. Safe handling of empty or missing cache (fail-closed).
 */

import { offlineDB, type OfflineDatabase } from "./db";

export interface CachedCategoryItem {
    _id: string;
    name: string;
    description?: string;
    status: "active" | "inactive";
}

export interface CachedCategoryEnvelope {
    tenantId: string;
    cachedAt: string;
    categories: CachedCategoryItem[];
}

export interface CachedUnitItem {
    _id: string;
    name: string;
    shortName: string;
    status: "active" | "inactive";
}

export interface CachedUnitEnvelope {
    tenantId: string;
    cachedAt: string;
    units: CachedUnitItem[];
}

export interface MetaStore {
    get(key: string): Promise<{ key: string; value: unknown } | undefined>;
    put(record: { key: string; value: unknown }): Promise<string | void>;
    delete(key: string): Promise<void>;
}

export function makeCategoryCacheKey(tenantId: string): string {
    return `cachedCategories:${tenantId.trim()}`;
}

export function makeUnitCacheKey(tenantId: string): string {
    return `cachedUnits:${tenantId.trim()}`;
}

/**
 * Safely map a single category from /api/categories to a CachedCategoryItem.
 * Returns null if the item is invalid or unidentifiable.
 */
export function mapApiCategoryToCachedItem(raw: unknown): CachedCategoryItem | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const id = String(r._id || r.id || "").trim();
    const name = String(r.name || "").trim();
    if (!id || !name) return null;

    return {
        _id: id,
        name,
        ...(r.description ? { description: String(r.description).trim() } : {}),
        status: r.status === "inactive" ? "inactive" : "active",
    };
}

/**
 * Safely map a single unit from /api/units to a CachedUnitItem.
 * Returns null if the item is invalid or unidentifiable.
 */
export function mapApiUnitToCachedItem(raw: unknown): CachedUnitItem | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const id = String(r._id || r.id || "").trim();
    const name = String(r.name || "").trim();
    if (!id || !name) return null;

    const shortName = String(r.shortName || r.code || "pcs").trim();

    return {
        _id: id,
        name,
        shortName: shortName || "pcs",
        status: r.status === "inactive" ? "inactive" : "active",
    };
}

/**
 * Filter out inactive categories or units for dropdown display.
 */
export function filterActiveDropdownItems<T extends { status: "active" | "inactive" }>(items: T[]): T[] {
    return items.filter((item) => item.status !== "inactive");
}

/**
 * Safely save categories for a tenant.
 */
export async function saveCachedCategories(
    tenantId: string,
    rawCategories: unknown[],
    customMetaStore?: MetaStore
): Promise<number> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId || !Array.isArray(rawCategories)) return 0;

    const categories = rawCategories
        .map(mapApiCategoryToCachedItem)
        .filter((c): c is CachedCategoryItem => c !== null);

    const envelope: CachedCategoryEnvelope = {
        tenantId: cleanTenantId,
        cachedAt: new Date().toISOString(),
        categories,
    };

    const store = customMetaStore ?? offlineDB.meta;
    try {
        await store.put({
            key: makeCategoryCacheKey(cleanTenantId),
            value: envelope,
        });
        return categories.length;
    } catch (err) {
        console.warn("Failed to save cached categories:", err);
        return 0;
    }
}

/**
 * Retrieve cached categories for a tenant.
 * By default returns only active categories for dropdown presentation.
 */
export async function getCachedCategoriesForTenant(
    tenantId: string,
    options: { includeInactive?: boolean } = {},
    customMetaStore?: MetaStore
): Promise<CachedCategoryItem[]> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId) return [];

    const store = customMetaStore ?? offlineDB.meta;
    try {
        const record = await store.get(makeCategoryCacheKey(cleanTenantId));
        if (!record || !record.value || typeof record.value !== "object") return [];

        const envelope = record.value as Partial<CachedCategoryEnvelope>;
        if (envelope.tenantId !== cleanTenantId || !Array.isArray(envelope.categories)) {
            return [];
        }

        if (options.includeInactive) {
            return envelope.categories;
        }

        return filterActiveDropdownItems(envelope.categories);
    } catch (err) {
        console.warn("Failed to load cached categories:", err);
        return [];
    }
}

/**
 * Safely save units for a tenant.
 */
export async function saveCachedUnits(
    tenantId: string,
    rawUnits: unknown[],
    customMetaStore?: MetaStore
): Promise<number> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId || !Array.isArray(rawUnits)) return 0;

    const units = rawUnits
        .map(mapApiUnitToCachedItem)
        .filter((u): u is CachedUnitItem => u !== null);

    const envelope: CachedUnitEnvelope = {
        tenantId: cleanTenantId,
        cachedAt: new Date().toISOString(),
        units,
    };

    const store = customMetaStore ?? offlineDB.meta;
    try {
        await store.put({
            key: makeUnitCacheKey(cleanTenantId),
            value: envelope,
        });
        return units.length;
    } catch (err) {
        console.warn("Failed to save cached units:", err);
        return 0;
    }
}

/**
 * Retrieve cached units for a tenant.
 * By default returns only active units for dropdown presentation.
 */
export async function getCachedUnitsForTenant(
    tenantId: string,
    options: { includeInactive?: boolean } = {},
    customMetaStore?: MetaStore
): Promise<CachedUnitItem[]> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId) return [];

    const store = customMetaStore ?? offlineDB.meta;
    try {
        const record = await store.get(makeUnitCacheKey(cleanTenantId));
        if (!record || !record.value || typeof record.value !== "object") return [];

        const envelope = record.value as Partial<CachedUnitEnvelope>;
        if (envelope.tenantId !== cleanTenantId || !Array.isArray(envelope.units)) {
            return [];
        }

        if (options.includeInactive) {
            return envelope.units;
        }

        return filterActiveDropdownItems(envelope.units);
    } catch (err) {
        console.warn("Failed to load cached units:", err);
        return [];
    }
}
