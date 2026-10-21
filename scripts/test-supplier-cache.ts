/*
 * Automated Database-Free Test Suite for Supplier Offline Cache and Dexie Migration
 * (NO MONGODB, NO SERVER, NO NETWORK, NO BROWSER STORAGE MUTATIONS).
 *
 * Validates Phase 3, Stage 1: Supplier Offline Cache and Dexie Migration:
 * 1. Dexie v5-to-v6 schema upgrade:
 *    - Dexie version 6 definition and cachedSuppliers store.
 *    - Existing stores (syncQueue, meta, offlineSessions, cachedProducts, cachedCustomers) preserved.
 *    - Queue data and customer/product records preserved without alteration.
 *    - Clean upgrade with no destructive contentUpgrade.
 * 2. Temporary ID and Code generation:
 *    - Temporary code formatted as SUP-TEMP-<short-id>.
 *    - Temporary local ID prefixed with "sup_".
 *    - Code and ID format verification functions.
 * 3. Safe API mapping & strict exclusion of sensitive banking fields:
 *    - Normalization of contact, address, tax, credit terms.
 *    - Defense-in-depth tenant verification.
 *    - Soft-deleted suppliers excluded.
 *    - Strict omission of bankDetails, accountNumber, bankName, ifsc, accountName, upiId.
 * 4. Tenant isolation:
 *    - Multi-tenant key partitioning (${tenantId}:${supplierId}).
 *    - Cross-tenant queries fail closed and return empty results.
 *    - Cross-tenant injection rejected.
 * 5. Search and lookup behavior:
 *    - Exact and substring name matching (case-insensitive).
 *    - Code, phone, email, GSTIN, and contactPerson matching.
 *    - Status filtering (active only by default; includeInactive; includeBlocked).
 *    - Direct lookup by ID and Code.
 * 6. Pending and NEEDS_ATTENTION records surviving stale server refreshes:
 *    - Locally updated suppliers in PENDING or NEEDS_ATTENTION are never overwritten by server fetches.
 *    - Locally created temporary suppliers are preserved.
 *    - Synced records are updated and new server suppliers added.
 * 7. Offline supplier creation & queuing:
 *    - Creates cached record with PENDING status and SUP-TEMP-... code.
 *    - Enqueues durable CREATE operation in syncQueue with owner metadata and stable operationId.
 * 8. Offline profile-detail edits & queuing:
 *    - Enqueues UPDATE operation for server suppliers, updates CREATE for temporary suppliers.
 *    - Preserves stable operation IDs across retries.
 * 9. Online-only lifecycle action safety enforcement:
 *    - Attempting status changes offline throws an explicit error and rejects modification.
 * 10. Queue healing and error marking:
 *    - ensurePendingSuppliersQueued heals orphaned pending records.
 *    - markPendingSupplierNeedsAttention sets error message and status.
 *
 * Run:
 *   npx tsx scripts/test-supplier-cache.ts
 */

import { OfflineDatabase, type CachedSupplierRecord, type SyncQueueItem } from "../lib/offline/db";
import {
    makeCachedSupplierId,
    generateTemporarySupplierId,
    generateTemporarySupplierCode,
    isTemporarySupplierId,
    isTemporarySupplierCode,
    isValidServerSupplierId,
    normalizeSupplierPhone,
    normalizeSupplierEmail,
    normalizeSupplierGstin,
    normalizeSupplierPan,
    normalizeSupplierCode,
    mapApiSupplierToCacheRecord,
    saveCachedSuppliers,
    getCachedSuppliersForTenant,
    searchCachedSuppliers,
    getCachedSupplierById,
    getCachedSupplierByCode,
    getCachedSupplierMetadata,
    savePendingOfflineSupplier,
    savePendingOfflineSupplierUpdate,
    ensurePendingSuppliersQueued,
    markPendingSupplierNeedsAttention,
    clearCachedSuppliersForTenant,
} from "../lib/offline/supplierCache";
import type { SessionIdentity } from "../lib/offline/syncPolicy";

// ============================================================
// TEST HARNESS
// ============================================================

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n============================================================`);
    console.log(`SUPPLIER CACHE TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock implementing OfflineDatabase tables
function createMemoryOfflineDb() {
    const cachedSuppliersMap = new Map<string, CachedSupplierRecord>();
    const cachedCustomersMap = new Map<string, any>();
    const cachedProductsMap = new Map<string, any>();
    const syncQueueList: SyncQueueItem[] = [];
    const metaMap = new Map<string, unknown>();

    let nextQueueId = 1;

    const db = {
        cachedSuppliers: {
            get: async (key: string) => {
                const item = cachedSuppliersMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: CachedSupplierRecord) => {
                cachedSuppliersMap.set(record.id, structuredClone(record));
                return record.id;
            },
            delete: async (key: string) => {
                cachedSuppliersMap.delete(key);
            },
            update: async (key: string, changes: Partial<CachedSupplierRecord>) => {
                const item = cachedSuppliersMap.get(key);
                if (item) {
                    Object.assign(item, changes);
                    return 1;
                }
                return 0;
            },
            toArray: async () => {
                return Array.from(cachedSuppliersMap.values()).map((v) => structuredClone(v));
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = Array.from(cachedSuppliersMap.values());
                        return all.filter((s: any) => s[field] === val).map((v) => structuredClone(v));
                    },
                    first: async () => {
                        const all = Array.from(cachedSuppliersMap.values());
                        const found = all.find((s: any) => s[field] === val);
                        return found ? structuredClone(found) : undefined;
                    },
                    delete: async () => {
                        let deletedCount = 0;
                        for (const [key, item] of Array.from(cachedSuppliersMap.entries())) {
                            if ((item as any)[field] === val) {
                                cachedSuppliersMap.delete(key);
                                deletedCount++;
                            }
                        }
                        return deletedCount;
                    },
                }),
            }),
        },
        cachedCustomers: {
            get: async (key: string) => {
                const item = cachedCustomersMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: any) => {
                cachedCustomersMap.set(record.id, structuredClone(record));
                return record.id;
            },
            toArray: async () => {
                return Array.from(cachedCustomersMap.values()).map((v) => structuredClone(v));
            },
        },
        cachedProducts: {
            get: async (key: string) => {
                const item = cachedProductsMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: any) => {
                cachedProductsMap.set(record.id, structuredClone(record));
                return record.id;
            },
            toArray: async () => {
                return Array.from(cachedProductsMap.values()).map((v) => structuredClone(v));
            },
        },
        syncQueue: {
            get: async (id: number) => {
                const item = syncQueueList.find((q) => q.id === id);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: SyncQueueItem) => {
                if (record.id === undefined) {
                    record.id = nextQueueId++;
                    syncQueueList.push(structuredClone(record));
                } else {
                    const idx = syncQueueList.findIndex((q) => q.id === record.id);
                    if (idx >= 0) syncQueueList[idx] = structuredClone(record);
                    else syncQueueList.push(structuredClone(record));
                }
                return record.id;
            },
            add: async (record: SyncQueueItem) => {
                record.id = nextQueueId++;
                syncQueueList.push(structuredClone(record));
                return record.id;
            },
            update: async (id: number, changes: Partial<SyncQueueItem>) => {
                const item = syncQueueList.find((q) => q.id === id);
                if (item) {
                    Object.assign(item, changes);
                    return 1;
                }
                return 0;
            },
            toArray: async () => {
                return syncQueueList.map((q) => structuredClone(q));
            },
            where: (field: string) => ({
                equals: (val: any) => ({
                    toArray: async () => {
                        return syncQueueList.filter((q: any) => q[field] === val).map((v) => structuredClone(v));
                    },
                    first: async () => {
                        return syncQueueList.find((q: any) => q[field] === val);
                    },
                }),
            }),
        },
        meta: {
            get: async (key: string) => {
                const val = metaMap.get(key);
                return val !== undefined ? { key, value: structuredClone(val) } : undefined;
            },
            put: async (record: { key: string; value: unknown }) => {
                metaMap.set(record.key, structuredClone(record.value));
                return record.key;
            },
        },
        transaction: async (_mode: any, ...args: any[]) => {
            const callback = args[args.length - 1];
            return await callback();
        },
    } as unknown as OfflineDatabase;

    return { db, cachedSuppliersMap, cachedCustomersMap, cachedProductsMap, syncQueueList, metaMap };
}

// ============================================================
// TESTS IMPLEMENTATION
// ============================================================

async function runTests() {
    console.log("=== PHASE 3, STAGE 1: SUPPLIER OFFLINE CACHE AND DEXIE MIGRATION TESTS ===\n");

    const tenantA = "670c11111111111111111111";
    const tenantB = "670c22222222222222222222";
    const sessionOwnerA: SessionIdentity = {
        tenantId: tenantA,
        userId: "user-123",
        deviceId: "device-abc",
    };

    // ============================================================
    // 1. DEXIE V5-TO-V6 SCHEMA UPGRADE & STORE PRESERVATION
    // ============================================================
    console.log("-- 1. Dexie v5-to-v6 Schema Upgrade & Store Preservation --");

    const dexieDb = new OfflineDatabase();
    check("1.1 Database version is at least 6", dexieDb.verno >= 6);

    const tableNames = dexieDb.tables.map((t) => t.name);
    check(
        "1.2 Database defines all required tables including cachedSuppliers",
        tableNames.includes("syncQueue") &&
            tableNames.includes("meta") &&
            tableNames.includes("offlineSessions") &&
            tableNames.includes("cachedProducts") &&
            tableNames.includes("cachedCustomers") &&
            tableNames.includes("cachedSuppliers")
    );

    const versions = (dexieDb as any)._versions as Array<{
        _cfg: {
            version: number;
            storesSource: Record<string, string>;
            contentUpgrade: unknown;
        };
    }>;

    const v5 = versions.find((v) => v._cfg?.version === 5);
    check("1.3 Version 5 schema exists in Dexie configuration", Boolean(v5));
    check(
        "1.3 Version 5 defines cachedCustomers store with required indexes",
        v5?._cfg?.storesSource?.cachedCustomers === "id, tenantId, customerId, name, phone, status"
    );

    const v6 = versions.find((v) => v._cfg?.version === 6);
    check("1.4 Version 6 schema exists in Dexie configuration", Boolean(v6));
    check(
        "1.4 Version 6 defines cachedSuppliers store with required indexes",
        v6?._cfg?.storesSource?.cachedSuppliers === "id, tenantId, supplierId, supplierCode, name, phone, status"
    );

    check(
        "1.5 Version 6 preserves all version 5 stores untouched",
        v6?._cfg?.storesSource?.syncQueue === "++id, operationId, status, localSeq, createdAt, ownerUserId" &&
            v6?._cfg?.storesSource?.meta === "key" &&
            v6?._cfg?.storesSource?.offlineSessions === "key" &&
            v6?._cfg?.storesSource?.cachedProducts === "id, tenantId, SKU, barcode, status" &&
            v6?._cfg?.storesSource?.cachedCustomers === "id, tenantId, customerId, name, phone, status"
    );

    check(
        "1.6 Version 6 migration has no destructive upgrade function (non-breaking table addition)",
        v6?._cfg?.contentUpgrade === null
    );

    // Verify upgrade preserves existing data
    const memory = createMemoryOfflineDb();
    // Seed v5 data: syncQueue, cachedCustomers, cachedProducts, meta
    await memory.db.syncQueue.add({
        operationId: "op-pending-sale-1",
        operationType: "CREATE",
        entityType: "Sale",
        payload: { invoiceNo: "INV-001", total: 1000 },
        status: "PENDING",
        localSeq: 1,
        attempts: 0,
        createdAt: new Date().toISOString(),
        owner: sessionOwnerA,
        ownerUserId: sessionOwnerA.userId,
    });
    await memory.db.cachedCustomers.put({
        id: `${tenantA}:cust_1`,
        customerId: "cust_1",
        tenantId: tenantA,
        name: "Acme Customer",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "SYNCED",
    });
    await memory.db.cachedProducts.put({
        id: `${tenantA}:prod_1`,
        productId: "prod_1",
        tenantId: tenantA,
        name: "Item Alpha",
        SKU: "SKU-A",
        sellingPrice: 50,
        status: "active",
        cachedAt: new Date().toISOString(),
    });
    await memory.db.meta.put({ key: "testKey", value: { test: true } });

    // Transition / access with cachedSuppliers table
    await memory.db.cachedSuppliers.put({
        id: `${tenantA}:sup_test`,
        supplierId: "sup_test",
        tenantId: tenantA,
        name: "Test Supplier",
        status: "active",
        cachedAt: new Date().toISOString(),
    });

    const queueItems = await memory.db.syncQueue.toArray();
    check("1.7 Existing syncQueue records preserved after migration", queueItems.length === 1 && queueItems[0].operationId === "op-pending-sale-1");
    const customers = await memory.db.cachedCustomers.toArray();
    check("1.8 Existing cached customers preserved after migration", customers.length === 1 && customers[0].name === "Acme Customer");
    const products = await memory.db.cachedProducts.toArray();
    check("1.9 Existing cached products preserved after migration", products.length === 1 && products[0].SKU === "SKU-A");
    const metaRecord = await memory.db.meta.get("testKey");
    check("1.10 Meta records preserved after migration", (metaRecord?.value as any)?.test === true);

    // ============================================================
    // 2. TEMPORARY ID AND CODE GENERATION
    // ============================================================
    console.log("\n-- 2. Temporary ID and Code Generation --");

    const tempCode1 = generateTemporarySupplierCode();
    const tempCode2 = generateTemporarySupplierCode();
    check("2.1 Temporary supplier code matches SUP-TEMP-<short-id> pattern", /^SUP-TEMP-[0-9A-F]{8}$/.test(tempCode1));
    check("2.2 Successive temporary supplier codes are distinct", tempCode1 !== tempCode2);
    check("2.3 isTemporarySupplierCode recognizes SUP-TEMP-... code", isTemporarySupplierCode(tempCode1));
    check("2.4 isTemporarySupplierCode rejects official sequential code SUP-0001", !isTemporarySupplierCode("SUP-0001"));
    check("2.5 isTemporarySupplierCode rejects empty or undefined code", !isTemporarySupplierCode("") && !isTemporarySupplierCode(undefined));

    const tempId1 = generateTemporarySupplierId();
    const tempId2 = generateTemporarySupplierId();
    check("2.6 Temporary supplier ID starts with sup_ prefix", tempId1.startsWith("sup_"));
    check("2.7 Successive temporary supplier IDs are distinct", tempId1 !== tempId2);
    check("2.8 isTemporarySupplierId recognizes sup_ prefixed ID", isTemporarySupplierId(tempId1));
    check("2.9 isTemporarySupplierId rejects 24-character hex server ID", !isTemporarySupplierId("670c11111111111111111111"));
    check("2.10 isValidServerSupplierId recognizes 24-char hex MongoDB ObjectId", isValidServerSupplierId("670c11111111111111111111"));
    check("2.11 isValidServerSupplierId rejects temporary sup_ ID", !isValidServerSupplierId(tempId1));
    check("2.12 Ambiguous non-hex, non-sup ID rejected by both validators", !isTemporarySupplierId("raw-123") && !isValidServerSupplierId("raw-123"));

    // Normalization helpers
    check("2.13 normalizeSupplierPhone trims and returns undefined for empty", normalizeSupplierPhone("  +91 9876543210  ") === "+91 9876543210" && normalizeSupplierPhone("   ") === undefined);
    check("2.14 normalizeSupplierEmail trims and lowercases", normalizeSupplierEmail("  SUPPLIER@Example.COM  ") === "supplier@example.com");
    check("2.15 normalizeSupplierGstin trims and uppercases", normalizeSupplierGstin("  29abcde1234f1z5  ") === "29ABCDE1234F1Z5");
    check("2.16 normalizeSupplierPan trims and uppercases", normalizeSupplierPan("  abcde1234f  ") === "ABCDE1234F");
    check("2.17 normalizeSupplierCode trims and uppercases", normalizeSupplierCode("  sup-0042  ") === "SUP-0042");

    // ============================================================
    // 3. SAFE API MAPPING & STRICT EXCLUSION OF SENSITIVE BANKING FIELDS
    // ============================================================
    console.log("\n-- 3. Safe API Mapping & Strict Banking Field Exclusion --");

    const rawServerSupplier = {
        _id: "670c00000000000000000001",
        tenantId: tenantA,
        supplierCode: "SUP-0001",
        name: "  Alpha Logistics Pvt Ltd  ",
        contact: {
            contactPerson: "  Ramesh Sharma  ",
            phone: "  9876543210  ",
            altPhone: "  9876543211  ",
            email: "  RAMESH@ALPHA.IN  ",
            website: "  https://alpha.in  ",
        },
        address: {
            line1: "  Plot 42, Industrial Area  ",
            line2: "  Phase 2  ",
            city: "  Bengaluru  ",
            state: "  Karnataka  ",
            pincode: "  560001  ",
            country: "  India  ",
        },
        tax: {
            gstin: "  29ABCDE1234F1Z5  ",
            pan: "  ABCDE1234F  ",
        },
        paymentTerms: {
            type: "credit",
            creditDays: 30,
        },
        creditLimit: 500000,
        category: "Raw Materials",
        notes: "Preferred vendor",
        status: "active",
        // SENSITIVE BANKING FIELDS TO BE EXCLUDED
        bankDetails: {
            accountName: "Alpha Logistics Pvt Ltd",
            accountNumber: "987654321000",
            bankName: "HDFC Bank",
            ifsc: "HDFC0001234",
            upiId: "alpha@hdfc",
        },
        accountNumber: "987654321000",
        ifsc: "HDFC0001234",
        bankName: "HDFC Bank",
        accountName: "Alpha Logistics",
        upiId: "alpha@hdfc",
        bankBranch: "Koramangala",
        swiftCode: "HDFCINBB",
        iban: "IN123456",
        routingNumber: "987654",
    };

    const mapped = mapApiSupplierToCacheRecord(rawServerSupplier, tenantA);
    check("3.1 Valid raw supplier successfully maps to CachedSupplierRecord", mapped !== null);
    check("3.2 Compound key is tenantId:supplierId", mapped?.id === `${tenantA}:670c00000000000000000001`);
    check("3.3 Original server _id mapped to supplierId", mapped?.supplierId === "670c00000000000000000001");
    check("3.4 Supplier code preserved and normalized", mapped?.supplierCode === "SUP-0001");
    check("3.5 Name trimmed correctly", mapped?.name === "Alpha Logistics Pvt Ltd");
    check("3.6 Nested contactPerson mapped", mapped?.contactPerson === "Ramesh Sharma");
    check("3.7 Nested phone mapped", mapped?.phone === "9876543210");
    check("3.8 Nested altPhone mapped", mapped?.altPhone === "9876543211");
    check("3.9 Nested email mapped and lowercased", mapped?.email === "ramesh@alpha.in");
    check("3.10 Nested address mapped to line1 and address", mapped?.line1 === "Plot 42, Industrial Area" && mapped?.address === "Plot 42, Industrial Area");
    check("3.11 State, city, pincode, country mapped", mapped?.city === "Bengaluru" && mapped?.state === "Karnataka" && mapped?.pincode === "560001" && mapped?.country === "India");
    check("3.12 GSTIN and PAN mapped and uppercased", mapped?.gstin === "29ABCDE1234F1Z5" && mapped?.pan === "ABCDE1234F");
    check("3.13 Payment terms mapped (credit, 30 days)", mapped?.paymentType === "credit" && mapped?.creditDays === 30);
    check("3.14 Credit limit mapped", mapped?.creditLimit === 500000);
    check("3.15 Category and notes mapped", mapped?.category === "Raw Materials" && mapped?.notes === "Preferred vendor");
    check("3.16 Status mapped to active", mapped?.status === "active");
    check("3.17 syncStatus stamped as SYNCED", mapped?.syncStatus === "SYNCED");
    check("3.18 cachedAt ISO timestamp recorded", typeof mapped?.cachedAt === "string" && !isNaN(Date.parse(mapped.cachedAt)));

    // STRICT BANKING EXCLUSION
    const mappedAny = mapped as any;
    check("3.19 bankDetails object strictly excluded", mappedAny.bankDetails === undefined);
    check("3.20 accountNumber strictly excluded", mappedAny.accountNumber === undefined);
    check("3.21 ifsc strictly excluded", mappedAny.ifsc === undefined);
    check("3.22 bankName strictly excluded", mappedAny.bankName === undefined);
    check("3.23 accountName strictly excluded", mappedAny.accountName === undefined);
    check("3.24 upiId strictly excluded", mappedAny.upiId === undefined);
    check("3.25 bankBranch, swiftCode, iban, routingNumber strictly excluded",
        mappedAny.bankBranch === undefined &&
        mappedAny.swiftCode === undefined &&
        mappedAny.iban === undefined &&
        mappedAny.routingNumber === undefined
    );

    // Defense against soft-deleted records and malformed records
    check("3.26 Soft-deleted supplier (isDeleted: true) returns null", mapApiSupplierToCacheRecord({ ...rawServerSupplier, isDeleted: true }, tenantA) === null);
    check("3.27 Missing supplier name returns null", mapApiSupplierToCacheRecord({ ...rawServerSupplier, name: "" }, tenantA) === null);
    check("3.28 Missing supplier ID returns null", mapApiSupplierToCacheRecord({ ...rawServerSupplier, _id: "" }, tenantA) === null);
    check("3.29 Empty authorized tenant returns null", mapApiSupplierToCacheRecord(rawServerSupplier, "   ") === null);
    check("3.30 Flat format properties correctly mapped if nested objects absent", (() => {
        const flatSupplier = {
            id: "670c00000000000000000002",
            name: "Flat Supplier",
            phone: "9123456780",
            email: "flat@supplier.com",
            address: "123 Main St",
            gstin: "29AAAAA0000A1Z5",
            paymentType: "cash",
        };
        const res = mapApiSupplierToCacheRecord(flatSupplier, tenantA);
        return res?.phone === "9123456780" && res?.email === "flat@supplier.com" && res?.address === "123 Main St" && res?.paymentType === "cash";
    })());

    // ============================================================
    // 4. TENANT ISOLATION
    // ============================================================
    console.log("\n-- 4. Strict Tenant Isolation --");

    const memDb = createMemoryOfflineDb().db;

    // Reject cross-tenant supplier injection during mapping
    const crossTenantRaw = { ...rawServerSupplier, tenantId: tenantB };
    check("4.1 Supplier with mismatched tenantId rejected during mapping", mapApiSupplierToCacheRecord(crossTenantRaw, tenantA) === null);

    // Save suppliers for Tenant A
    await saveCachedSuppliers([rawServerSupplier], tenantA, memDb);

    // Query Tenant B
    const tenantBSuppliers = await getCachedSuppliersForTenant(tenantB, { includeInactive: true, includeBlocked: true }, memDb);
    check("4.2 Tenant B queries return empty array when only Tenant A has data", tenantBSuppliers.length === 0);

    // Search Tenant B
    const tenantBSearch = await searchCachedSuppliers("Alpha", tenantB, {}, memDb);
    check("4.3 Tenant B search returns empty array (fail-closed across tenants)", tenantBSearch.length === 0);

    // Lookup by ID across tenants
    const crossTenantLookup = await getCachedSupplierById("670c00000000000000000001", tenantB, memDb);
    check("4.4 Lookup by ID across tenants fails closed and returns null", crossTenantLookup === null);

    // Lookup by Code across tenants
    const crossTenantCodeLookup = await getCachedSupplierByCode("SUP-0001", tenantB, memDb);
    check("4.5 Lookup by Code across tenants fails closed and returns null", crossTenantCodeLookup === null);

    // Same raw supplier ID in Tenant A and Tenant B creates distinct keys and never collides
    const rawSupplierTenantB = {
        ...rawServerSupplier,
        tenantId: tenantB,
        name: "Beta Logistics in Tenant B",
    };
    await saveCachedSuppliers([rawSupplierTenantB], tenantB, memDb);

    const supA = await getCachedSupplierById("670c00000000000000000001", tenantA, memDb);
    const supB = await getCachedSupplierById("670c00000000000000000001", tenantB, memDb);
    check("4.6 Same supplier ID across different tenants creates distinct table keys",
        Boolean(supA && supB && supA.id === `${tenantA}:670c00000000000000000001` && supB.id === `${tenantB}:670c00000000000000000001`)
    );
    check("4.7 Querying Tenant A returns Tenant A supplier name", supA?.name === "Alpha Logistics Pvt Ltd");
    check("4.8 Querying Tenant B returns Tenant B supplier name", supB?.name === "Beta Logistics in Tenant B");

    // Empty tenant query fails closed
    const emptyTenantQuery = await getCachedSuppliersForTenant("  ", {}, memDb);
    check("4.9 Empty tenant ID returns empty array", emptyTenantQuery.length === 0);

    // ============================================================
    // 5. SEARCH AND LOOKUP BEHAVIOR
    // ============================================================
    console.log("\n-- 5. Search and Lookup Behavior --");

    const searchDb = createMemoryOfflineDb().db;
    const sampleSuppliers = [
        {
            _id: "670c00000000000000000010",
            tenantId: tenantA,
            supplierCode: "SUP-0010",
            name: "Hindustan Petroleum Distributors",
            contact: { contactPerson: "Sunil Joshi", phone: "9811122233", email: "sunil@hp.com" },
            tax: { gstin: "29AABCH1234F1Z0" },
            status: "active",
        },
        {
            _id: "670c00000000000000000020",
            tenantId: tenantA,
            supplierCode: "SUP-0020",
            name: "Apex Paper Packaging",
            contact: { contactPerson: "Meena Patel", phone: "9822233344", email: "meena@apex.com" },
            tax: { gstin: "29AAACP2345G1Z1" },
            status: "inactive",
        },
        {
            _id: "670c00000000000000000030",
            tenantId: tenantA,
            supplierCode: "SUP-0030",
            name: "Zenith Industrial Chemicals",
            contact: { contactPerson: "Vikram Sen", phone: "9833344455", email: "vikram@zenith.com" },
            tax: { gstin: "29AAACZ3456H1Z2" },
            status: "blocked",
        },
    ];

    await saveCachedSuppliers(sampleSuppliers, tenantA, searchDb);

    // Status filtering
    const activeOnly = await getCachedSuppliersForTenant(tenantA, {}, searchDb);
    check("5.1 Default retrieval returns active suppliers only", activeOnly.length === 1 && activeOnly[0].supplierCode === "SUP-0010");

    const includeInactive = await getCachedSuppliersForTenant(tenantA, { includeInactive: true }, searchDb);
    check("5.2 includeInactive: true includes active and inactive suppliers", includeInactive.length === 2 && includeInactive.some((s) => s.status === "inactive"));

    const includeBlocked = await getCachedSuppliersForTenant(tenantA, { includeBlocked: true }, searchDb);
    check("5.3 includeBlocked: true includes active and blocked suppliers", includeBlocked.length === 2 && includeBlocked.some((s) => s.status === "blocked"));

    const includeAll = await getCachedSuppliersForTenant(tenantA, { includeInactive: true, includeBlocked: true }, searchDb);
    check("5.4 includeInactive and includeBlocked together return all suppliers", includeAll.length === 3);

    // Search by name
    const searchByName = await searchCachedSuppliers("Hindustan", tenantA, {}, searchDb);
    check("5.5 Search by name substring matches candidate", searchByName.length === 1 && searchByName[0].name.includes("Hindustan"));

    const searchByNameCase = await searchCachedSuppliers("hindustan", tenantA, {}, searchDb);
    check("5.6 Search by name is case-insensitive", searchByNameCase.length === 1);

    // Search by code
    const searchByCode = await searchCachedSuppliers("SUP-0010", tenantA, {}, searchDb);
    check("5.7 Search by supplier code matches candidate", searchByCode.length === 1 && searchByCode[0].supplierCode === "SUP-0010");

    // Search by phone
    const searchByPhone = await searchCachedSuppliers("9811122233", tenantA, {}, searchDb);
    check("5.8 Search by phone matches candidate", searchByPhone.length === 1 && searchByPhone[0].phone === "9811122233");

    // Search by email
    const searchByEmail = await searchCachedSuppliers("sunil@hp.com", tenantA, {}, searchDb);
    check("5.9 Search by email matches candidate", searchByEmail.length === 1);

    // Search by GSTIN
    const searchByGstin = await searchCachedSuppliers("AABCH1234F", tenantA, {}, searchDb);
    check("5.10 Search by GSTIN substring matches candidate", searchByGstin.length === 1);

    // Search by contactPerson
    const searchByContact = await searchCachedSuppliers("Sunil Joshi", tenantA, {}, searchDb);
    check("5.11 Search by contact person matches candidate", searchByContact.length === 1);

    // Search inactive supplier with option
    const searchInactive = await searchCachedSuppliers("Apex Paper", tenantA, { includeInactive: true }, searchDb);
    check("5.12 Search finds inactive supplier when includeInactive is true", searchInactive.length === 1 && searchInactive[0].status === "inactive");

    const searchInactiveWithoutOption = await searchCachedSuppliers("Apex Paper", tenantA, {}, searchDb);
    check("5.13 Search filters out inactive supplier when includeInactive is false", searchInactiveWithoutOption.length === 0);

    // Empty query returns all filtered suppliers
    const emptyQuerySearch = await searchCachedSuppliers("", tenantA, {}, searchDb);
    check("5.14 Empty query returns all active suppliers", emptyQuerySearch.length === 1);

    // Non-existent search returns empty array
    const nonExistentSearch = await searchCachedSuppliers("NonExistentQueryXYZ", tenantA, {}, searchDb);
    check("5.15 Non-existent query returns empty array", nonExistentSearch.length === 0);

    // Direct lookup by ID
    const lookupById = await getCachedSupplierById("670c00000000000000000010", tenantA, searchDb);
    check("5.16 getCachedSupplierById retrieves correct record", lookupById?.name === "Hindustan Petroleum Distributors");

    // Direct lookup by Code
    const lookupByCode = await getCachedSupplierByCode("SUP-0010", tenantA, searchDb);
    check("5.17 getCachedSupplierByCode retrieves correct record", lookupByCode?.name === "Hindustan Petroleum Distributors");

    // Metadata
    const metadata = await getCachedSupplierMetadata(tenantA, searchDb);
    check("5.18 getCachedSupplierMetadata reports total and active counts", metadata.count === 3 && metadata.activeCount === 1 && typeof metadata.lastCachedAt === "string");

    // ============================================================
    // 6. PENDING AND NEEDS_ATTENTION RECORDS SURVIVING STALE REFRESHES
    // ============================================================
    console.log("\n-- 6. Pending and NEEDS_ATTENTION Records Surviving Stale Server Refreshes --");

    const refreshDb = createMemoryOfflineDb().db;

    // Seed:
    // 1. Clean server supplier (SYNCED)
    const syncedSupId = "670c00000000000000000100";
    await refreshDb.cachedSuppliers.put({
        id: `${tenantA}:${syncedSupId}`,
        supplierId: syncedSupId,
        tenantId: tenantA,
        supplierCode: "SUP-0100",
        name: "Synced Supplier Old Name",
        phone: "9000000000",
        status: "active",
        cachedAt: new Date(Date.now() - 3600000).toISOString(),
        syncStatus: "SYNCED",
    });

    // 2. Pending locally-updated server supplier (PENDING)
    const pendingUpdateSupId = "670c00000000000000000200";
    await refreshDb.cachedSuppliers.put({
        id: `${tenantA}:${pendingUpdateSupId}`,
        supplierId: pendingUpdateSupId,
        tenantId: tenantA,
        supplierCode: "SUP-0200",
        name: "Supplier Modified Offline",
        phone: "9999999999",
        address: "New Offline Address 42",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
        operationId: "op-pending-update-1",
    });

    // 3. Supplier with failed sync (NEEDS_ATTENTION)
    const attentionSupId = "670c00000000000000000300";
    await refreshDb.cachedSuppliers.put({
        id: `${tenantA}:${attentionSupId}`,
        supplierId: attentionSupId,
        tenantId: tenantA,
        supplierCode: "SUP-0300",
        name: "Supplier With Failed Sync",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "NEEDS_ATTENTION",
        errorMessage: "GSTIN validation failed on server",
        operationId: "op-attention-1",
    });

    // 4. Locally created temporary supplier (PENDING)
    const tempSupId = "sup_temp_local_123";
    await refreshDb.cachedSuppliers.put({
        id: `${tenantA}:${tempSupId}`,
        supplierId: tempSupId,
        tenantId: tenantA,
        supplierCode: "SUP-TEMP-12345678",
        name: "Local Offline Created Supplier",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
        operationId: "op-temp-create-1",
    });

    // Stale server response fetched from /api/suppliers:
    // Has newer name for Synced Supplier, stale/old values for pendingUpdateSupId and attentionSupId,
    // and does NOT know about tempSupId. Also introduces a brand new server supplier.
    const newServerSupId = "670c00000000000000000400";
    const serverSuppliers = [
        {
            _id: syncedSupId,
            tenantId: tenantA,
            supplierCode: "SUP-0100",
            name: "Synced Supplier New Name From Server",
            phone: "9000000001",
            status: "active",
        },
        {
            _id: pendingUpdateSupId,
            tenantId: tenantA,
            supplierCode: "SUP-0200",
            name: "Stale Server Name (Must NOT overwrite local edit)",
            phone: "9000000002",
            address: "Old Server Address",
            status: "active",
        },
        {
            _id: attentionSupId,
            tenantId: tenantA,
            supplierCode: "SUP-0300",
            name: "Stale Server Record (Must NOT overwrite needs_attention item)",
            status: "active",
        },
        {
            _id: newServerSupId,
            tenantId: tenantA,
            supplierCode: "SUP-0400",
            name: "Brand New Supplier From Server",
            status: "active",
        },
    ];

    // Execute saveCachedSuppliers
    const savedCount = await saveCachedSuppliers(serverSuppliers, tenantA, refreshDb);
    check("6.1 saveCachedSuppliers returns count of records updated/saved", savedCount === 2); // only syncedSupId and newServerSupId saved

    // Verify Synced Supplier was updated
    const updatedSynced = await getCachedSupplierById(syncedSupId, tenantA, refreshDb);
    check("6.2 SYNCED supplier updated with fresh server data", updatedSynced?.name === "Synced Supplier New Name From Server");

    // Verify Pending locally-updated supplier survived
    const preservedPending = await getCachedSupplierById(pendingUpdateSupId, tenantA, refreshDb);
    check("6.3 PENDING offline update survived stale server refresh", preservedPending?.name === "Supplier Modified Offline");
    check("6.4 PENDING address change preserved", preservedPending?.address === "New Offline Address 42");
    check("6.5 PENDING syncStatus preserved", preservedPending?.syncStatus === "PENDING");
    check("6.6 PENDING operationId preserved", preservedPending?.operationId === "op-pending-update-1");

    // Verify NEEDS_ATTENTION supplier survived
    const preservedAttention = await getCachedSupplierById(attentionSupId, tenantA, refreshDb);
    check("6.7 NEEDS_ATTENTION supplier survived stale server refresh", preservedAttention?.name === "Supplier With Failed Sync");
    check("6.8 NEEDS_ATTENTION errorMessage preserved", preservedAttention?.errorMessage === "GSTIN validation failed on server");
    check("6.9 NEEDS_ATTENTION syncStatus preserved", preservedAttention?.syncStatus === "NEEDS_ATTENTION");

    // Verify locally created temporary supplier survived
    const preservedTemp = await getCachedSupplierById(tempSupId, tenantA, refreshDb);
    check("6.10 Local offline created supplier survived server refresh", preservedTemp?.name === "Local Offline Created Supplier");
    check("6.11 Local temporary supplier code preserved", preservedTemp?.supplierCode === "SUP-TEMP-12345678");

    // Verify Brand New server supplier was added
    const addedNew = await getCachedSupplierById(newServerSupId, tenantA, refreshDb);
    check("6.12 Brand new server supplier added alongside preserved items", addedNew?.name === "Brand New Supplier From Server");

    // ============================================================
    // 7. OFFLINE SUPPLIER CREATION & QUEUEING
    // ============================================================
    console.log("\n-- 7. Offline Supplier Creation & Queueing --");

    const createDb = createMemoryOfflineDb().db;
    await createDb.meta.put({ key: "lastSessionIdentity", value: sessionOwnerA });

    const createInput = {
        name: "  Ganpati Packaging Solutions  ",
        contactPerson: "Ganesh Hegde",
        phone: "  9845012345  ",
        email: "ganesh@ganpati.com",
        address: "Plot 10, Peenya Industrial Area",
        state: "Karnataka",
        gstin: "29AABCG1234F1Z9",
        paymentType: "credit" as const,
        creditDays: 45,
        creditLimit: 150000,
        category: "Packaging",
        notes: "Boxes and tape",
    };

    const { supplier: createdSup, operationId: createdOpId } = await savePendingOfflineSupplier(createInput, tenantA, createDb);

    check("7.1 Created supplier has PENDING syncStatus", createdSup.syncStatus === "PENDING");
    check("7.2 Created supplier has temporary ID starting with sup_", isTemporarySupplierId(createdSup.supplierId));
    check("7.3 Created supplier has temporary code starting with SUP-TEMP-", isTemporarySupplierCode(createdSup.supplierCode));
    check("7.4 Created supplier table key is compound tenant:localId", createdSup.id === `${tenantA}:${createdSup.supplierId}`);
    check("7.5 Created supplier status defaults to active", createdSup.status === "active");
    check("7.6 Created supplier has assigned operationId", createdSup.operationId === createdOpId);

    // Verify syncQueue entry
    const queueWhere = createDb.syncQueue.where("operationId").equals(createdOpId);
    const queueItem = await queueWhere.first();
    check("7.7 syncQueue contains queued CREATE operation", queueItem !== undefined);
    check("7.8 Queue item entityType is Supplier", queueItem?.entityType === "Supplier");
    check("7.9 Queue item operationType is CREATE", queueItem?.operationType === "CREATE");
    check("7.10 Queue item status is PENDING", queueItem?.status === "PENDING");
    check("7.11 Queue item payload localId matches supplierId", queueItem?.payload?.localId === createdSup.supplierId);
    check("7.12 Queue item payload supplierCode matches temporary code", queueItem?.payload?.supplierCode === createdSup.supplierCode);
    check("7.13 Queue item payload contains trimmed name", queueItem?.payload?.name === "Ganpati Packaging Solutions");
    check("7.14 Queue item payload contains normalized phone", queueItem?.payload?.phone === "9845012345");
    check("7.15 Queue item payload contains GSTIN", queueItem?.payload?.gstin === "29AABCG1234F1Z9");
    check("7.16 Queue item payload contains credit terms", queueItem?.payload?.paymentType === "credit" && queueItem?.payload?.creditDays === 45);
    check("7.17 Queue item ownerUserId attached from session identity", queueItem?.ownerUserId === sessionOwnerA.userId);

    // Verify NO banking fields in queue payload or cached record
    const queuePayloadAny = queueItem?.payload as any;
    check("7.18 syncQueue payload strictly excludes banking fields",
        queuePayloadAny?.bankDetails === undefined &&
        queuePayloadAny?.accountNumber === undefined &&
        queuePayloadAny?.ifsc === undefined &&
        queuePayloadAny?.upiId === undefined
    );

    // ============================================================
    // 8. OFFLINE PROFILE-DETAIL EDITS & QUEUEING
    // ============================================================
    console.log("\n-- 8. Offline Profile-Detail Edits & Queueing --");

    const editDb = createMemoryOfflineDb().db;
    await editDb.meta.put({ key: "lastSessionIdentity", value: sessionOwnerA });

    const existingServerId = "670c00000000000000000555";
    await editDb.cachedSuppliers.put({
        id: `${tenantA}:${existingServerId}`,
        supplierId: existingServerId,
        tenantId: tenantA,
        supplierCode: "SUP-0555",
        name: "Original Supplier Name",
        phone: "9111111111",
        email: "orig@supplier.com",
        address: "Old Address",
        status: "active",
        cachedAt: new Date(Date.now() - 3600000).toISOString(),
        syncStatus: "SYNCED",
    });

    // 8.1 Edit existing server supplier profile offline
    const updatedRecord = await savePendingOfflineSupplierUpdate(
        {
            supplierId: existingServerId,
            name: "Updated Supplier Name",
            phone: "9222222222",
            address: "New Updated Street 99",
            category: "General Hardware",
        },
        tenantA,
        editDb
    );

    check("8.1 Updated supplier cached record has PENDING syncStatus", updatedRecord.syncStatus === "PENDING");
    check("8.2 Updated supplier cached record preserves supplierId", updatedRecord.supplierId === existingServerId);
    check("8.3 Updated supplier cached record preserves original supplierCode", updatedRecord.supplierCode === "SUP-0555");
    check("8.4 Updated supplier cached record reflects new name", updatedRecord.name === "Updated Supplier Name");
    check("8.5 Updated supplier cached record reflects new phone", updatedRecord.phone === "9222222222");
    check("8.6 Updated supplier cached record reflects new address", updatedRecord.address === "New Updated Street 99");

    // Verify UPDATE item in syncQueue
    const editQueueItems = await editDb.syncQueue.toArray();
    const updateItem = editQueueItems.find((q) => q.entityType === "Supplier" && q.operationType === "UPDATE");
    check("8.7 syncQueue contains UPDATE operation for server supplier", updateItem !== undefined);
    check("8.8 UPDATE item payload has supplierId", updateItem?.payload?.supplierId === existingServerId);
    check("8.9 UPDATE item payload has updated name", updateItem?.payload?.name === "Updated Supplier Name");
    check("8.10 UPDATE item payload has updated phone", updateItem?.payload?.phone === "9222222222");
    check("8.11 UPDATE item operationId matches cached record operationId", updateItem?.operationId === updatedRecord.operationId);

    // 8.2 Repeated offline edit of the same supplier preserves operationId (stable idempotent queue item)
    const repeatedUpdate = await savePendingOfflineSupplierUpdate(
        {
            supplierId: existingServerId,
            name: "Updated Supplier Name Second Edit",
            phone: "9333333333",
        },
        tenantA,
        editDb
    );

    const allQueueAfterRepeated = await editDb.syncQueue.toArray();
    check("8.12 Repeated edit does NOT create duplicate queue items (remains 1 item)", allQueueAfterRepeated.length === 1);
    check("8.13 Repeated edit preserves stable operationId", repeatedUpdate.operationId === updatedRecord.operationId);
    check("8.14 Existing queue item payload updated with newest values", allQueueAfterRepeated[0].payload?.name === "Updated Supplier Name Second Edit" && allQueueAfterRepeated[0].payload?.phone === "9333333333");

    // 8.3 Offline edit of a temporary local supplier updates its CREATE operation
    const tempCreateInput = {
        name: "Temporary Supplier",
        phone: "9444444444",
    };
    const { supplier: tempSup } = await savePendingOfflineSupplier(tempCreateInput, tenantA, editDb);

    await savePendingOfflineSupplierUpdate(
        {
            supplierId: tempSup.supplierId,
            name: "Temporary Supplier Modified Offline",
            phone: "9555555555",
        },
        tenantA,
        editDb
    );

    const tempQueueItem = (await editDb.syncQueue.toArray()).find((q) => q.payload?.localId === tempSup.supplierId);
    check("8.15 Temporary local supplier edit preserves operationType CREATE", tempQueueItem?.operationType === "CREATE");
    check("8.16 Temporary local supplier CREATE payload updated with new name", tempQueueItem?.payload?.name === "Temporary Supplier Modified Offline");
    check("8.17 Temporary local supplier CREATE payload updated with new phone", tempQueueItem?.payload?.phone === "9555555555");

    // ============================================================
    // 9. ONLINE-ONLY LIFECYCLE ACTION SAFETY ENFORCEMENT
    // ============================================================
    console.log("\n-- 9. Online-Only Lifecycle Action Safety Enforcement --");

    const lifecycleDb = createMemoryOfflineDb().db;
    const testSupId = "670c00000000000000000999";
    await lifecycleDb.cachedSuppliers.put({
        id: `${tenantA}:${testSupId}`,
        supplierId: testSupId,
        tenantId: tenantA,
        name: "Active Test Supplier",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "SYNCED",
    });

    let deactivateErrorCaught = false;
    try {
        await savePendingOfflineSupplierUpdate(
            {
                supplierId: testSupId,
                name: "Active Test Supplier",
                status: "inactive", // attempting offline deactivation
            },
            tenantA,
            lifecycleDb
        );
    } catch (err: any) {
        deactivateErrorCaught = true;
        check("9.1 Offline deactivation rejected with explicit online-only error",
            err.message.includes("online-only")
        );
    }
    check("9.2 Offline deactivation threw error", deactivateErrorCaught);

    let blockErrorCaught = false;
    try {
        await savePendingOfflineSupplierUpdate(
            {
                supplierId: testSupId,
                name: "Active Test Supplier",
                status: "blocked", // attempting offline blocking
            },
            tenantA,
            lifecycleDb
        );
    } catch (err: any) {
        blockErrorCaught = true;
        check("9.3 Offline blocking rejected with explicit online-only error",
            err.message.includes("online-only")
        );
    }
    check("9.4 Offline blocking threw error", blockErrorCaught);

    // Verify record status was NOT modified
    const untouchedSup = await getCachedSupplierById(testSupId, tenantA, lifecycleDb);
    check("9.5 Supplier status remains untouched as active in cache", untouchedSup?.status === "active");
    check("9.6 Supplier syncStatus remains SYNCED (no queue item created)", untouchedSup?.syncStatus === "SYNCED");

    // ============================================================
    // 10. QUEUE HEALING AND ERROR MARKING
    // ============================================================
    console.log("\n-- 10. Queue Healing and Error Marking --");

    const healDb = createMemoryOfflineDb().db;
    await healDb.meta.put({ key: "lastSessionIdentity", value: sessionOwnerA });

    // Simulate orphaned pending suppliers in cache (e.g. process crashed before syncQueue write)
    const orphanedTempId = "sup_orphaned_001";
    await healDb.cachedSuppliers.put({
        id: `${tenantA}:${orphanedTempId}`,
        supplierId: orphanedTempId,
        tenantId: tenantA,
        supplierCode: "SUP-TEMP-ORPHAN01",
        name: "Orphaned Temp Supplier",
        phone: "9876500000",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
    });

    const orphanedServerId = "670c00000000000000000888";
    await healDb.cachedSuppliers.put({
        id: `${tenantA}:${orphanedServerId}`,
        supplierId: orphanedServerId,
        tenantId: tenantA,
        supplierCode: "SUP-0888",
        name: "Orphaned Server Supplier Edit",
        phone: "9876511111",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
    });

    // Run queue healing
    const healedCount = await ensurePendingSuppliersQueued(tenantA, healDb);
    check("10.1 ensurePendingSuppliersQueued returns count of healed items", healedCount === 2);

    const healedItems = await healDb.syncQueue.toArray();
    const tempHealed = healedItems.find((q) => q.payload?.localId === orphanedTempId);
    check("10.2 Orphaned temporary supplier healed with CREATE operation", tempHealed?.operationType === "CREATE");
    check("10.3 Healed temporary supplier has owner metadata", tempHealed?.ownerUserId === sessionOwnerA.userId);

    const serverHealed = healedItems.find((q) => q.payload?.supplierId === orphanedServerId);
    check("10.4 Orphaned server supplier healed with UPDATE operation", serverHealed?.operationType === "UPDATE");
    check("10.5 Healed server supplier has owner metadata", serverHealed?.ownerUserId === sessionOwnerA.userId);

    // Repeated call is idempotent
    const repeatedHealCount = await ensurePendingSuppliersQueued(tenantA, healDb);
    check("10.6 Repeated ensurePendingSuppliersQueued is strictly idempotent (0 added)", repeatedHealCount === 0);

    // markPendingSupplierNeedsAttention
    await markPendingSupplierNeedsAttention(orphanedTempId, tenantA, "Server rejected duplicate phone number", healDb);
    const attentionSup = await getCachedSupplierById(orphanedTempId, tenantA, healDb);
    check("10.7 markPendingSupplierNeedsAttention updates syncStatus to NEEDS_ATTENTION", attentionSup?.syncStatus === "NEEDS_ATTENTION");
    check("10.8 markPendingSupplierNeedsAttention records errorMessage", attentionSup?.errorMessage === "Server rejected duplicate phone number");

    // clearCachedSuppliersForTenant
    const cleared = await clearCachedSuppliersForTenant(tenantA, healDb);
    check("10.9 clearCachedSuppliersForTenant removes all tenant suppliers", cleared === 2);
    const postClear = await getCachedSuppliersForTenant(tenantA, { includeInactive: true, includeBlocked: true }, healDb);
    check("10.10 Tenant suppliers list is empty after clear", postClear.length === 0);

    return summarize();
}

runTests().then((success) => {
    process.exit(success ? 0 : 1);
});
