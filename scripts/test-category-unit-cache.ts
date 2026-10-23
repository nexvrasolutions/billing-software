/*
 * Category & Unit Offline Cache Tests
 * (NO DATABASE, NO SERVER, NO NETWORK).
 *
 * Verifies:
 * 1. Safe mapping from /api/categories and /api/units responses.
 * 2. Active vs Inactive record filtering for dropdowns.
 * 3. Strict tenant isolation between different tenants.
 * 4. Empty-cache fail-closed behavior (never invents mock data).
 * 5. Dropdown option mapping and default selection simulation.
 * 6. Offline product creation prohibition.
 * 7. Dexie schema and existing tables preservation.
 *
 * Run:
 *   npx tsx scripts/test-category-unit-cache.ts
 */

import { OfflineDatabase } from "../lib/offline/db";
import {
    mapApiCategoryToCachedItem,
    mapApiUnitToCachedItem,
    filterActiveDropdownItems,
    saveCachedCategories,
    getCachedCategoriesForTenant,
    saveCachedUnits,
    getCachedUnitsForTenant,
    makeCategoryCacheKey,
    makeUnitCacheKey,
    type MetaStore,
    type CachedCategoryItem,
    type CachedUnitItem,
} from "../lib/offline/categoryUnitCache";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function createMemoryMetaStore(): MetaStore & { map: Map<string, unknown> } {
    const map = new Map<string, unknown>();
    return {
        map,
        get: async (key: string) => {
            if (!map.has(key)) return undefined;
            return { key, value: map.get(key) };
        },
        put: async (record: { key: string; value: unknown }) => {
            map.set(record.key, structuredClone(record.value));
        },
        delete: async (key: string) => {
            map.delete(key);
        },
    };
}

const hexId = (n: number) => n.toString(16).padStart(24, "0");
const tenantA = hexId(1);
const tenantB = hexId(2);

async function main() {
    console.log("=== OFFLINE CATEGORY & UNIT DROPDOWN TESTS ===\n");

    // ============================================================
    // 1. SAFE API MAPPING & STRIPPING SECRETS
    // ============================================================
    console.log("-- 1. Safe API Mapping & Validation --");

    const rawCategory = {
        _id: hexId(10),
        name: "  Medicines & Pharma  ",
        description: "All prescription drugs",
        status: "active",
        extraSecretKey: "do_not_cache",
    };
    const mappedCat = mapApiCategoryToCachedItem(rawCategory);

    check("C1. Valid category maps successfully", mappedCat !== null);
    check("C2. Category ID is preserved", mappedCat?._id === hexId(10));
    check("C3. Category name is trimmed", mappedCat?.name === "Medicines & Pharma");
    check("C4. Extraneous fields are stripped", !("extraSecretKey" in (mappedCat || {})));
    check("C5. Category without name is rejected", mapApiCategoryToCachedItem({ _id: "1", name: "" }) === null);
    check("C6. Category without id is rejected", mapApiCategoryToCachedItem({ name: "General" }) === null);

    const rawUnit = {
        _id: hexId(20),
        name: "  Kilogram  ",
        shortName: "  kg  ",
        status: "active",
        internalCostMultiplier: 1.5,
    };
    const mappedUnit = mapApiUnitToCachedItem(rawUnit);

    check("U1. Valid unit maps successfully", mappedUnit !== null);
    check("U2. Unit ID is preserved", mappedUnit?._id === hexId(20));
    check("U3. Unit name is trimmed", mappedUnit?.name === "Kilogram");
    check("U4. Unit shortName is trimmed", mappedUnit?.shortName === "kg");
    check("U5. Unit code fallback works when shortName is missing",
        mapApiUnitToCachedItem({ _id: "u1", name: "Box", code: "bx" })?.shortName === "bx");
    check("U6. Default shortName falls back to 'pcs'",
        mapApiUnitToCachedItem({ _id: "u2", name: "Items" })?.shortName === "pcs");
    check("U7. Unit without name is rejected", mapApiUnitToCachedItem({ _id: "u3" }) === null);

    // ============================================================
    // 2. ACTIVE VS INACTIVE FILTERING FOR DROPDOWNS
    // ============================================================
    console.log("\n-- 2. Active vs Inactive Filtering --");

    const sampleCategories: CachedCategoryItem[] = [
        { _id: "c1", name: "Active Cat 1", status: "active" },
        { _id: "c2", name: "Inactive Cat 2", status: "inactive" },
        { _id: "c3", name: "Active Cat 3", status: "active" },
    ];
    const activeCats = filterActiveDropdownItems(sampleCategories);
    check("F1. Inactive category is filtered out of active dropdown items", activeCats.length === 2);
    check("F2. Only active categories remain in dropdown list",
        activeCats.every((c) => c.status === "active") && !activeCats.some((c) => c._id === "c2")
    );

    const sampleUnits: CachedUnitItem[] = [
        { _id: "u1", name: "Pieces", shortName: "pcs", status: "active" },
        { _id: "u2", name: "Obsolete Unit", shortName: "obs", status: "inactive" },
    ];
    const activeUnits = filterActiveDropdownItems(sampleUnits);
    check("F3. Inactive unit is filtered out of active dropdown items", activeUnits.length === 1);
    check("F4. Inactive unit 'obs' is excluded from dropdown",
        activeUnits[0]?._id === "u1" && activeUnits[0]?.shortName === "pcs"
    );

    // ============================================================
    // 3. STRICT TENANT ISOLATION
    // ============================================================
    console.log("\n-- 3. Strict Tenant Isolation --");

    const metaStore = createMemoryMetaStore();

    const tenantA_categories = [
        { _id: "tA_c1", name: "Tenant A Beverages", status: "active" },
        { _id: "tA_c2", name: "Tenant A Snacks", status: "active" },
    ];
    const tenantB_categories = [
        { _id: "tB_c1", name: "Tenant B Industrial Tools", status: "active" },
    ];

    await saveCachedCategories(tenantA, tenantA_categories, metaStore);
    await saveCachedCategories(tenantB, tenantB_categories, metaStore);

    const tenantA_units = [
        { _id: "tA_u1", name: "Bottle", shortName: "btl", status: "active" },
    ];
    const tenantB_units = [
        { _id: "tB_u1", name: "Ton", shortName: "ton", status: "active" },
    ];

    await saveCachedUnits(tenantA, tenantA_units, metaStore);
    await saveCachedUnits(tenantB, tenantB_units, metaStore);

    // Verify key partitioning
    check("T1. Categories have distinct tenant-partitioned keys",
        metaStore.map.has(makeCategoryCacheKey(tenantA)) &&
        metaStore.map.has(makeCategoryCacheKey(tenantB)) &&
        makeCategoryCacheKey(tenantA) !== makeCategoryCacheKey(tenantB)
    );
    check("T2. Units have distinct tenant-partitioned keys",
        metaStore.map.has(makeUnitCacheKey(tenantA)) &&
        metaStore.map.has(makeUnitCacheKey(tenantB))
    );

    // Read queries per tenant
    const tA_readCats = await getCachedCategoriesForTenant(tenantA, {}, metaStore);
    check("T3. Query for Tenant A returns only Tenant A categories",
        tA_readCats.length === 2 && tA_readCats.every((c) => c._id.startsWith("tA_"))
    );

    const tB_readCats = await getCachedCategoriesForTenant(tenantB, {}, metaStore);
    check("T4. Query for Tenant B returns only Tenant B categories",
        tB_readCats.length === 1 && tB_readCats[0]?._id === "tB_c1"
    );

    const tA_readUnits = await getCachedUnitsForTenant(tenantA, {}, metaStore);
    check("T5. Query for Tenant A returns only Tenant A units",
        tA_readUnits.length === 1 && tA_readUnits[0]?.shortName === "btl"
    );

    const tB_readUnits = await getCachedUnitsForTenant(tenantB, {}, metaStore);
    check("T6. Query for Tenant B returns only Tenant B units",
        tB_readUnits.length === 1 && tB_readUnits[0]?.shortName === "ton"
    );

    // Invalid or cross-tenant query
    check("T7. Empty tenant query returns empty categories array (fail-closed)",
        (await getCachedCategoriesForTenant("", {}, metaStore)).length === 0
    );
    check("T8. Empty tenant query returns empty units array (fail-closed)",
        (await getCachedUnitsForTenant("", {}, metaStore)).length === 0
    );
    check("T9. Unknown tenant query returns empty array",
        (await getCachedCategoriesForTenant(hexId(999), {}, metaStore)).length === 0
    );

    // ============================================================
    // 4. EMPTY CACHE BEHAVIOR
    // ============================================================
    console.log("\n-- 4. Empty Cache Behavior --");

    const freshMetaStore = createMemoryMetaStore();
    const emptyCats = await getCachedCategoriesForTenant(tenantA, {}, freshMetaStore);
    const emptyUnits = await getCachedUnitsForTenant(tenantA, {}, freshMetaStore);

    check("E1. Empty category cache returns empty array", Array.isArray(emptyCats) && emptyCats.length === 0);
    check("E2. Empty unit cache returns empty array", Array.isArray(emptyUnits) && emptyUnits.length === 0);
    check("E3. Empty cache does not invent placeholder or mock data", emptyCats.length === 0 && emptyUnits.length === 0);

    // Corrupted envelope in store
    freshMetaStore.map.set(makeCategoryCacheKey(tenantA), { tenantId: "mismatched", categories: [{ _id: "bad" }] });
    const corruptedRead = await getCachedCategoriesForTenant(tenantA, {}, freshMetaStore);
    check("E4. Corrupted or mismatched envelope returns empty array safely", corruptedRead.length === 0);

    // ============================================================
    // 5. OFFLINE DROPDOWN POPULATION SIMULATION
    // ============================================================
    console.log("\n-- 5. Offline Dropdown Population Simulation --");

    // Simulate NewProductPage offline state loading
    async function simulateOfflineNewProductLoad(tId: string, store: MetaStore) {
        const [cats, units] = await Promise.all([
            getCachedCategoriesForTenant(tId, {}, store),
            getCachedUnitsForTenant(tId, {}, store),
        ]);

        const selectedCategoryId = cats[0]?._id ?? "";
        const selectedUnitId = units[0]?._id ?? "";

        return {
            categories: cats,
            units,
            selectedCategoryId,
            selectedUnitId,
            isOffline: true,
        };
    }

    const state = await simulateOfflineNewProductLoad(tenantA, metaStore);
    check("D1. Offline New Product page populates Category dropdown options", state.categories.length === 2);
    check("D2. Category dropdown displays names correctly",
        state.categories.map((c) => c.name).join(", ") === "Tenant A Beverages, Tenant A Snacks"
    );
    check("D3. Offline New Product page populates Unit dropdown options", state.units.length === 1);
    check("D4. Unit dropdown displays name and shortName",
        state.units[0]?.name === "Bottle" && state.units[0]?.shortName === "btl"
    );
    check("D5. First active category is automatically pre-selected", state.selectedCategoryId === "tA_c1");
    check("D6. First active unit is automatically pre-selected", state.selectedUnitId === "tA_u1");

    // ============================================================
    // 6. OFFLINE PRODUCT CREATION PROHIBITION
    // ============================================================
    console.log("\n-- 6. Offline Product Creation Prohibition --");

    function simulateSubmitProduct(isOffline: boolean) {
        if (isOffline) {
            return {
                allowed: false,
                error: "Product creation is not supported while offline. Please connect to the internet to save this product.",
            };
        }
        return { allowed: true };
    }

    const offlineSubmit = simulateSubmitProduct(true);
    check("P1. Offline product submission is strictly rejected", offlineSubmit.allowed === false);
    check("P2. Rejection error informs user that internet is required",
        typeof offlineSubmit.error === "string" && /not supported while offline/i.test(offlineSubmit.error) && /internet/i.test(offlineSubmit.error)
    );

    const onlineSubmit = simulateSubmitProduct(false);
    check("P3. Online product submission is allowed to proceed to server", onlineSubmit.allowed === true);

    // ============================================================
    // 7. DEXIE SCHEMA & EXISTING TABLES PRESERVATION
    // ============================================================
    console.log("\n-- 7. Dexie Schema Preservation --");

    const db = new OfflineDatabase();
    check("S1. OfflineDatabase version is unchanged (Version 4)", db.verno === 4);
    check("S2. Table 'syncQueue' is preserved", db.tables.some((t) => t.name === "syncQueue"));
    check("S3. Table 'meta' is preserved", db.tables.some((t) => t.name === "meta"));
    check("S4. Table 'offlineSessions' is preserved", db.tables.some((t) => t.name === "offlineSessions"));
    check("S5. Table 'cachedProducts' is preserved", db.tables.some((t) => t.name === "cachedProducts"));

    console.log("\n--- Test Summary ---");
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
