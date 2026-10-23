/*
 * Automated Database-Free Test Suite for Purchase Offline Cache and Dexie Schema v7
 * (NO MONGODB, NO ATLAS, NO SERVER, NO NETWORK, NO BROWSER STORAGE MUTATIONS).
 *
 * Validates Step 2.2: Dexie Schema and Purchase Cache:
 * 1. Dexie Schema v7 declaration and table preservation:
 *    - Schema version 7 introduces cachedPurchases with correct indexes.
 *    - Preserves all 6 earlier tables (syncQueue, meta, offlineSessions, cachedProducts, cachedCustomers, cachedSuppliers).
 *    - Dexie OfflineDatabase class definition and table bindings.
 * 2. Helper functions and ID utilities:
 *    - makeCachedPurchaseId, generateTemporaryPurchaseId, isTemporaryPurchaseId, isValidServerPurchaseId.
 * 3. Atomic dual-write (savePendingOfflinePurchase):
 *    - Creates cached purchase record with PENDING status and valid financial calculations.
 *    - Enqueues durable CREATE operation in syncQueue with owner metadata and matching operationId.
 *    - Writes both records within an atomic Dexie transaction.
 * 4. Rollback safety:
 *    - If syncQueue write fails, cached purchase write is rolled back (0 orphaned records).
 *    - If cache write fails, syncQueue write is rolled back.
 * 5. Operation ID idempotency (same tenant):
 *    - Re-submitting with identical tenantId and operationId returns existing record with alreadyExists: true.
 *    - Does not create duplicate queue items or duplicate cache records.
 * 6. Cross-tenant isolation & collision defense:
 *    - Re-using operationId across different tenants is strictly rejected.
 *    - Tenant B queries never see or mutate Tenant A cached purchases.
 * 7. Offline payload validation rejection:
 *    - Rejects invalid financials, negative values, paidAmount > grandTotal.
 *    - Rejects invalid IDs (neither valid ObjectId nor temporary prefix).
 * 8. Temporary supplier & product dependency tracking:
 *    - Temporary supplier (sup_...) and product (prod_...) IDs preserved in cache & queue.
 *    - dependsOn array captures pending dependency operation IDs.
 * 9. Tenant-scoped retrieval:
 *    - Filtered by tenantId, sorted by cachedAt descending.
 *    - Filters by syncStatus and status (cancelled excluded by default).
 * 10. Failed sync marking without silent deletion:
 *    - markCachedPurchaseFailed updates syncStatus to FAILED / NEEDS_ATTENTION.
 *    - Record is preserved and retrievable.
 * 11. Server confirmation reconciliation:
 *    - Re-indexes record from temporary local ID (pur_...) to confirmed server ObjectId.
 *    - Updates syncStatus to SYNCED.
 *    - Idempotent on repeated calls.
 * 12. SyncQueue contract compatibility:
 *    - Conforms to existing SyncQueueItem format and queue status conventions.
 *
 * Run:
 *   npx tsx scripts/test-purchase-cache.ts
 */

import {
    OfflineDatabase,
    type CachedPurchaseRecord,
    type CachedSupplierRecord,
    type CachedProductRecord,
    type SyncQueueItem,
} from "../lib/offline/db";
import {
    makeCachedPurchaseId,
    generateTemporaryPurchaseId,
    isTemporaryPurchaseId,
    isValidServerPurchaseId,
    savePendingOfflinePurchase,
    getCachedPurchasesForTenant,
    getCachedPurchaseById,
    getCachedPurchaseByOperationId,
    reconcileConfirmedPurchaseSync,
    markCachedPurchaseFailed,
    clearCachedPurchasesForTenant,
} from "../lib/offline/purchaseCache";
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
    console.log(`PURCHASE CACHE TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock implementing OfflineDatabase tables with rollback support
function createMemoryOfflineDb() {
    let cachedPurchasesMap = new Map<string, CachedPurchaseRecord>();
    const cachedSuppliersMap = new Map<string, CachedSupplierRecord>();
    const cachedProductsMap = new Map<string, CachedProductRecord>();
    let syncQueueList: SyncQueueItem[] = [];
    const metaMap = new Map<string, unknown>();

    let nextQueueId = 1;

    // Simulation hooks for failure testing
    let failSyncQueueAdd = false;
    let failPurchasePut = false;

    const db = {
        cachedPurchases: {
            get: async (key: string) => {
                const item = cachedPurchasesMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: CachedPurchaseRecord) => {
                if (failPurchasePut) {
                    throw new Error("Simulated cachedPurchases.put failure");
                }
                cachedPurchasesMap.set(record.id, structuredClone(record));
                return record.id;
            },
            delete: async (key: string) => {
                cachedPurchasesMap.delete(key);
            },
            update: async (key: string, changes: Partial<CachedPurchaseRecord>) => {
                const item = cachedPurchasesMap.get(key);
                if (item) {
                    Object.assign(item, changes);
                    return 1;
                }
                return 0;
            },
            toArray: async () => {
                return Array.from(cachedPurchasesMap.values()).map((v) => structuredClone(v));
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = Array.from(cachedPurchasesMap.values());
                        return all.filter((s) => (s as unknown as Record<string, unknown>)[field] === val).map((v) => structuredClone(v));
                    },
                    first: async () => {
                        const all = Array.from(cachedPurchasesMap.values());
                        const found = all.find((s) => (s as unknown as Record<string, unknown>)[field] === val);
                        return found ? structuredClone(found) : undefined;
                    },
                    delete: async () => {
                        let count = 0;
                        for (const [k, v] of Array.from(cachedPurchasesMap.entries())) {
                            if ((v as unknown as Record<string, unknown>)[field] === val) {
                                cachedPurchasesMap.delete(k);
                                count++;
                            }
                        }
                        return count;
                    },
                }),
            }),
        },
        cachedSuppliers: {
            get: async (key: string) => {
                const item = cachedSuppliersMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: CachedSupplierRecord) => {
                cachedSuppliersMap.set(record.id, structuredClone(record));
                return record.id;
            },
        },
        cachedProducts: {
            get: async (key: string) => {
                const item = cachedProductsMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: CachedProductRecord) => {
                cachedProductsMap.set(record.id, structuredClone(record));
                return record.id;
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
                if (failSyncQueueAdd) {
                    throw new Error("Simulated syncQueue.add failure");
                }
                record.id = nextQueueId++;
                syncQueueList.push(structuredClone(record));
                return record.id;
            },
            toArray: async () => {
                return syncQueueList.map((q) => structuredClone(q));
            },
            where: (field: string) => ({
                equals: (val: unknown) => ({
                    toArray: async () => {
                        return syncQueueList.filter((q) => (q as unknown as Record<string, unknown>)[field] === val).map((v) => structuredClone(v));
                    },
                    first: async () => {
                        return syncQueueList.find((q) => (q as unknown as Record<string, unknown>)[field] === val);
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
        transaction: async (_mode: unknown, ...args: unknown[]) => {
            const callback = args[args.length - 1] as () => Promise<unknown>;
            // Take snapshots for transaction rollback
            const purchasesSnapshot = new Map(
                Array.from(cachedPurchasesMap.entries()).map(([k, v]) => [k, structuredClone(v)])
            );
            const queueSnapshot = syncQueueList.map((item) => structuredClone(item));
            const queueIdSnapshot = nextQueueId;

            try {
                return await callback();
            } catch (err) {
                // Roll back both tables on error
                cachedPurchasesMap = purchasesSnapshot;
                syncQueueList = queueSnapshot;
                nextQueueId = queueIdSnapshot;
                throw err;
            }
        },
    } as unknown as OfflineDatabase;

    return {
        db,
        getPurchasesMap: () => cachedPurchasesMap,
        getQueueList: () => syncQueueList,
        cachedSuppliersMap,
        cachedProductsMap,
        metaMap,
        setFailSyncQueueAdd: (val: boolean) => {
            failSyncQueueAdd = val;
        },
        setFailPurchasePut: (val: boolean) => {
            failPurchasePut = val;
        },
    };
}

// ============================================================
// TEST SUITES
// ============================================================

async function runAllTests() {
    console.log("=== BILLING SAAS: PURCHASE OFFLINE CACHE & DEXIE V7 TESTS ===\n");

    const tenantA = "670c11111111111111111111";
    const tenantB = "670c22222222222222222222";
    const serverSupplierId = "670c33333333333333333333";
    const serverProductId = "670c44444444444444444444";

    const sessionOwnerA: SessionIdentity = {
        tenantId: tenantA,
        userId: "user-alpha",
        deviceId: "device-alpha",
    };

    // ------------------------------------------------------------
    // SUITE 1: Dexie Schema Version 7 Declaration
    // ------------------------------------------------------------
    console.log("--- Suite 1: Dexie Schema v7 Declaration ---");
    {
        const realDb = new OfflineDatabase();
        check("OfflineDatabase instance initializes without errors", !!realDb);

        // Check Dexie tables collection
        const tableNames = realDb.tables.map((t) => t.name);
        check("Dexie has cachedPurchases table", tableNames.includes("cachedPurchases"));
        check("Dexie preserves syncQueue table", tableNames.includes("syncQueue"));
        check("Dexie preserves meta table", tableNames.includes("meta"));
        check("Dexie preserves offlineSessions table", tableNames.includes("offlineSessions"));
        check("Dexie preserves cachedProducts table", tableNames.includes("cachedProducts"));
        check("Dexie preserves cachedCustomers table", tableNames.includes("cachedCustomers"));
        check("Dexie preserves cachedSuppliers table", tableNames.includes("cachedSuppliers"));
        check("Total tables count is 7", tableNames.length === 7);

        // Check cachedPurchases schema indexes
        const purchasesTable = realDb.table("cachedPurchases");
        check("cachedPurchases schema exists", !!purchasesTable?.schema);
        check("cachedPurchases primary key is id", purchasesTable?.schema?.primKey?.name === "id");

        const indexedFields = purchasesTable?.schema?.indexes.map((idx) => idx.name) || [];
        check("cachedPurchases has tenantId index", indexedFields.includes("tenantId"));
        check("cachedPurchases has purchaseId index", indexedFields.includes("purchaseId"));
        check("cachedPurchases has operationId index", indexedFields.includes("operationId"));
        check("cachedPurchases has purchaseNo index", indexedFields.includes("purchaseNo"));
        check("cachedPurchases has supplierId index", indexedFields.includes("supplierId"));
        check("cachedPurchases has syncStatus index", indexedFields.includes("syncStatus"));
        check("cachedPurchases has status index", indexedFields.includes("status"));
    }

    // ------------------------------------------------------------
    // SUITE 2: Identifier Utilities
    // ------------------------------------------------------------
    console.log("\n--- Suite 2: Identifier Utilities ---");
    {
        const key = makeCachedPurchaseId("  tenant-1  ", "  pur_abc-123  ");
        check("makeCachedPurchaseId trims and joins with colon", key === "tenant-1:pur_abc-123");

        const tempId = generateTemporaryPurchaseId();
        check("generateTemporaryPurchaseId generates pur_ prefix", tempId.startsWith("pur_"));
        check("isTemporaryPurchaseId returns true for pur_...", isTemporaryPurchaseId(tempId));
        check("isTemporaryPurchaseId returns false for mongo ObjectId", !isTemporaryPurchaseId(serverSupplierId));
        check("isTemporaryPurchaseId returns false for empty or non-string", !isTemporaryPurchaseId("") && !isTemporaryPurchaseId(123));

        check("isValidServerPurchaseId returns true for 24-hex ObjectId", isValidServerPurchaseId("670c11111111111111111111"));
        check("isValidServerPurchaseId returns false for pur_...", !isValidServerPurchaseId(tempId));
        check("isValidServerPurchaseId returns false for invalid hex", !isValidServerPurchaseId("not-an-id-12345678901234"));
    }

    // ------------------------------------------------------------
    // SUITE 3: Valid Purchase Dual-Write (Cache & Queue)
    // ------------------------------------------------------------
    console.log("\n--- Suite 3: Valid Purchase Dual-Write ---");
    {
        const mock = createMemoryOfflineDb();
        const opId = "op-purchase-001";
        const localId = "pur_local-001";

        const input = {
            purchaseNo: "PO-2026-0001",
            supplierId: serverSupplierId,
            warehouse: { name: "Main Warehouse", location: "Dock A" },
            items: [
                {
                    productId: serverProductId,
                    quantity: 10,
                    unitPrice: 100,
                    discountRate: 10, // 10% discount -> subtotal 1000 - 100 = 900
                    taxRate: 18,       // 18% tax on 900 = 162 -> 1062
                },
            ],
            shippingCost: 50,
            paidAmount: 500,
        };

        const result = await savePendingOfflinePurchase(input, tenantA, {
            db: mock.db,
            operationId: opId,
            localId,
            owner: sessionOwnerA,
        });

        check("savePendingOfflinePurchase succeeds", !!result.purchase);
        check("Returned alreadyExists is false", result.alreadyExists === false);
        check("Returned operationId matches", result.operationId === opId);
        check("Returned localId matches", result.localId === localId);

        // Verify cachedPurchases record
        const purchasesMap = mock.getPurchasesMap();
        check("cachedPurchases has exactly 1 record", purchasesMap.size === 1);
        const record = purchasesMap.get(`${tenantA}:${localId}`);
        check("Record exists with compound key", !!record);
        check("Record tenantId matches", record?.tenantId === tenantA);
        check("Record operationId matches", record?.operationId === opId);
        check("Record syncStatus is PENDING", record?.syncStatus === "PENDING");
        check("Record status is received", record?.status === "received");
        check("Calculated grandTotal is 1112 (1062 + 50 shipping)", record?.grandTotal === 1112);
        check("Calculated dueAmount is 612 (1112 - 500)", record?.dueAmount === 612);
        check("Calculated paymentStatus is partial", record?.paymentStatus === "partial");

        // Verify syncQueue record
        const queueList = mock.getQueueList();
        check("syncQueue has exactly 1 item", queueList.length === 1);
        const qItem = queueList[0];
        check("Queue operationId matches", qItem.operationId === opId);
        check("Queue operationType is CREATE", qItem.operationType === "CREATE");
        check("Queue entityType is Purchase", qItem.entityType === "Purchase");
        check("Queue status is PENDING", qItem.status === "PENDING");
        check("Queue owner tenantId matches", qItem.owner?.tenantId === tenantA);
        check("Queue owner userId matches", qItem.owner?.userId === "user-alpha");
        check("Queue payload grandTotal matches authoritative calculation", (qItem.payload as Record<string, unknown>)?.grandTotal === 1112);
        check("Queue payload localId matches", (qItem.payload as Record<string, unknown>)?.localId === localId);
    }

    // ------------------------------------------------------------
    // SUITE 4: Transactional Rollback on Write Failure
    // ------------------------------------------------------------
    console.log("\n--- Suite 4: Transactional Rollback on Write Failure ---");
    {
        // 4a. Failure on syncQueue.add rolls back cachedPurchases
        const mockA = createMemoryOfflineDb();
        mockA.setFailSyncQueueAdd(true);

        const inputA = {
            purchaseNo: "PO-ROLLBACK-01",
            supplierId: serverSupplierId,
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 2, unitPrice: 50 }],
        };

        let threwQueueAdd = false;
        try {
            await savePendingOfflinePurchase(inputA, tenantA, {
                db: mockA.db,
                operationId: "op-rollback-queue",
            });
        } catch (err: unknown) {
            threwQueueAdd = true;
            check("Error is thrown on syncQueue failure", (err as Error).message.includes("syncQueue.add"));
        }
        check("savePendingOfflinePurchase threw", threwQueueAdd);
        check("cachedPurchases rolled back to 0 records", mockA.getPurchasesMap().size === 0);
        check("syncQueue rolled back to 0 records", mockA.getQueueList().length === 0);

        // 4b. Failure on cachedPurchases.put rolls back syncQueue
        const mockB = createMemoryOfflineDb();
        mockB.setFailPurchasePut(true);

        let threwPut = false;
        try {
            await savePendingOfflinePurchase(inputA, tenantA, {
                db: mockB.db,
                operationId: "op-rollback-put",
            });
        } catch (err: unknown) {
            threwPut = true;
            check("Error is thrown on cachedPurchases failure", (err as Error).message.includes("cachedPurchases.put"));
        }
        check("savePendingOfflinePurchase threw on put", threwPut);
        check("cachedPurchases has 0 records after rollback", mockB.getPurchasesMap().size === 0);
        check("syncQueue has 0 records after rollback", mockB.getQueueList().length === 0);
    }

    // ------------------------------------------------------------
    // SUITE 5: Operation ID Idempotency (Same Tenant)
    // ------------------------------------------------------------
    console.log("\n--- Suite 5: Operation ID Idempotency (Same Tenant) ---");
    {
        const mock = createMemoryOfflineDb();
        const opId = "op-idempotent-001";
        const input = {
            purchaseNo: "PO-IDEM-01",
            supplierId: serverSupplierId,
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 5, unitPrice: 20 }],
        };

        // First call
        const res1 = await savePendingOfflinePurchase(input, tenantA, {
            db: mock.db,
            operationId: opId,
            owner: sessionOwnerA,
        });
        check("First call returns alreadyExists: false", res1.alreadyExists === false);
        check("First call creates 1 purchase record", mock.getPurchasesMap().size === 1);
        check("First call creates 1 queue item", mock.getQueueList().length === 1);

        // Second call with identical tenant and operationId
        const res2 = await savePendingOfflinePurchase(input, tenantA, {
            db: mock.db,
            operationId: opId,
            owner: sessionOwnerA,
        });
        check("Second call returns alreadyExists: true", res2.alreadyExists === true);
        check("Second call returns same purchase record ID", res2.purchase.id === res1.purchase.id);
        check("Second call returns same localId", res2.localId === res1.localId);
        check("cachedPurchases still has exactly 1 record", mock.getPurchasesMap().size === 1);
        check("syncQueue still has exactly 1 item (no duplicate enqueued)", mock.getQueueList().length === 1);
    }

    // ------------------------------------------------------------
    // SUITE 6: Cross-Tenant Isolation & Collision Defense
    // ------------------------------------------------------------
    console.log("\n--- Suite 6: Cross-Tenant Isolation & Collision Defense ---");
    {
        const mock = createMemoryOfflineDb();
        const sharedOpId = "op-shared-attempt";

        // Tenant A creates purchase
        const resA = await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-TENANT-A",
                supplierId: serverSupplierId,
                warehouse: { name: "Tenant A Depot" },
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 100 }],
            },
            tenantA,
            { db: mock.db, operationId: sharedOpId, owner: sessionOwnerA }
        );
        check("Tenant A creates purchase successfully", !resA.alreadyExists);

        // Tenant B attempts to use the same operationId
        let threwCrossTenant = false;
        try {
            await savePendingOfflinePurchase(
                {
                    purchaseNo: "PO-TENANT-B",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Tenant B Depot" },
                    items: [{ productId: serverProductId, quantity: 2, unitPrice: 200 }],
                },
                tenantB,
                {
                    db: mock.db,
                    operationId: sharedOpId,
                    owner: { tenantId: tenantB, userId: "user-beta", deviceId: "device-beta" },
                }
            );
        } catch (err: unknown) {
            threwCrossTenant = true;
            check("Cross-tenant conflict is rejected", (err as Error).message.includes("Cross-tenant"));
        }
        check("Tenant B attempt threw cross-tenant error", threwCrossTenant);

        // Verify Tenant A's record was not overwritten or touched
        const recordA = await getCachedPurchaseByOperationId(sharedOpId, tenantA, mock.db);
        check("Tenant A record is untouched", recordA?.purchaseNo === "PO-TENANT-A");

        // Verify Tenant B cannot read Tenant A's record by any helper
        const bPurchases = await getCachedPurchasesForTenant(tenantB, {}, mock.db);
        check("getCachedPurchasesForTenant(tenantB) returns 0 records", bPurchases.length === 0);

        const bById = await getCachedPurchaseById(resA.localId, tenantB, mock.db);
        check("getCachedPurchaseById for Tenant B returns null", bById === null);

        const bByOpId = await getCachedPurchaseByOperationId(sharedOpId, tenantB, mock.db);
        check("getCachedPurchaseByOperationId for Tenant B returns null", bByOpId === null);
    }

    // ------------------------------------------------------------
    // SUITE 7: Payload Validation Rejection
    // ------------------------------------------------------------
    console.log("\n--- Suite 7: Payload Validation Rejection ---");
    {
        const mock = createMemoryOfflineDb();

        const testCases: { name: string; payload: Record<string, unknown>; expectedError: string }[] = [
            {
                name: "Empty items array",
                payload: {
                    purchaseNo: "PO-FAIL-1",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Main" },
                    items: [],
                },
                expectedError: "At least one purchase item is required",
            },
            {
                name: "Negative quantity",
                payload: {
                    purchaseNo: "PO-FAIL-2",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Main" },
                    items: [{ productId: serverProductId, quantity: -1, unitPrice: 10 }],
                },
                expectedError: "Quantity must be greater than zero",
            },
            {
                name: "Negative unit price",
                payload: {
                    purchaseNo: "PO-FAIL-3",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Main" },
                    items: [{ productId: serverProductId, quantity: 1, unitPrice: -50 }],
                },
                expectedError: "Unit price cannot be negative",
            },
            {
                name: "Paid amount exceeds grand total",
                payload: {
                    purchaseNo: "PO-FAIL-4",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Main" },
                    items: [{ productId: serverProductId, quantity: 1, unitPrice: 100 }],
                    paidAmount: 200,
                },
                expectedError: "Paid amount cannot exceed grand total",
            },
            {
                name: "Invalid supplierId format (not ObjectId and not sup_...)",
                payload: {
                    purchaseNo: "PO-FAIL-5",
                    supplierId: "invalid-supplier-id",
                    warehouse: { name: "Main" },
                    items: [{ productId: serverProductId, quantity: 1, unitPrice: 100 }],
                },
                expectedError: "Invalid supplier ID",
            },
            {
                name: "Invalid productId format (not ObjectId and not prod_...)",
                payload: {
                    purchaseNo: "PO-FAIL-6",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Main" },
                    items: [{ productId: "invalid-product-id", quantity: 1, unitPrice: 100 }],
                },
                expectedError: "Invalid product ID",
            },
        ];

        for (const tc of testCases) {
            let threw = false;
            try {
                await savePendingOfflinePurchase(tc.payload, tenantA, { db: mock.db });
            } catch (err: unknown) {
                threw = true;
                check(`Validation rejected: ${tc.name}`, (err as Error).message.includes(tc.expectedError));
            }
            if (!threw) {
                check(`Validation rejected: ${tc.name}`, false, "Did not throw");
            }
        }

        // Empty tenant ID check
        let threwTenant = false;
        try {
            await savePendingOfflinePurchase(
                {
                    purchaseNo: "PO-NO-TENANT",
                    supplierId: serverSupplierId,
                    warehouse: { name: "Main" },
                    items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
                },
                "   ",
                { db: mock.db }
            );
        } catch (err: unknown) {
            threwTenant = true;
            check("Empty tenant ID is rejected", (err as Error).message.includes("Tenant ID is required"));
        }
        check("Empty tenant ID threw", threwTenant);
    }

    // ------------------------------------------------------------
    // SUITE 8: Temporary Supplier and Product Dependency Tracking
    // ------------------------------------------------------------
    console.log("\n--- Suite 8: Temporary Supplier & Product Dependency Tracking ---");
    {
        const mock = createMemoryOfflineDb();

        const tempSupId = "sup_temp-999";
        const tempSupOpId = "op-create-sup-999";
        // Pre-populate cachedSuppliers with a pending supplier
        await mock.cachedSuppliersMap.set(`${tenantA}:${tempSupId}`, {
            id: `${tenantA}:${tempSupId}`,
            supplierId: tempSupId,
            tenantId: tenantA,
            supplierCode: "SUP-TEMP-999",
            name: "Local Temporary Supplier",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "PENDING",
            operationId: tempSupOpId,
        });

        const tempProdId = "prod_temp-888";
        const tempProdOpId = "op-create-prod-888";
        // Pre-populate cachedProducts with a pending product
        await mock.cachedProductsMap.set(`${tenantA}:${tempProdId}`, {
            id: `${tenantA}:${tempProdId}`,
            productId: tempProdId,
            tenantId: tenantA,
            SKU: "SKU-TEMP-888",
            name: "Local Temporary Product",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "PENDING",
            operationId: tempProdOpId,
        } as CachedProductRecord);

        const input = {
            purchaseNo: "PO-TEMP-DEPS",
            supplierId: tempSupId,
            supplierCode: "SUP-TEMP-999",
            supplierSnapshot: { name: "Local Temporary Supplier" },
            warehouse: { name: "Temporary Holding" },
            items: [
                {
                    productId: tempProdId,
                    quantity: 4,
                    unitPrice: 25,
                    productSnapshot: { name: "Local Temporary Product", SKU: "SKU-TEMP-888" },
                },
            ],
        };

        const res = await savePendingOfflinePurchase(input, tenantA, {
            db: mock.db,
            operationId: "op-purchase-deps",
            owner: sessionOwnerA,
        });

        check("Purchase with temporary supplier & product saves", !!res.purchase);
        check("Temporary supplier ID preserved in record", res.purchase.supplierId === tempSupId);
        check("Temporary product ID preserved in item", res.purchase.items[0].productId === tempProdId);

        // Verify queue item dependsOn array captured both pending dependencies
        const qItem = mock.getQueueList().find((q) => q.operationId === "op-purchase-deps");
        check("Queue item exists", !!qItem);
        check("dependsOn includes supplier operationId", qItem?.dependsOn?.includes(tempSupOpId) === true);
        check("dependsOn includes product operationId", qItem?.dependsOn?.includes(tempProdOpId) === true);
        check("dependsOn has 2 dependencies", qItem?.dependsOn?.length === 2);
    }

    // ------------------------------------------------------------
    // SUITE 9: Tenant-Scoped Retrieval & Status Filtering
    // ------------------------------------------------------------
    console.log("\n--- Suite 9: Tenant-Scoped Retrieval & Status Filtering ---");
    {
        const mock = createMemoryOfflineDb();

        // Save 3 purchases for Tenant A with different dates and statuses
        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-A-1",
                supplierId: serverSupplierId,
                warehouse: { name: "W1" },
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            },
            tenantA,
            { db: mock.db, operationId: "op-a-1", localId: "pur_a-1" }
        );

        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-A-2",
                supplierId: serverSupplierId,
                warehouse: { name: "W1" },
                items: [{ productId: serverProductId, quantity: 2, unitPrice: 10 }],
            },
            tenantA,
            { db: mock.db, operationId: "op-a-2", localId: "pur_a-2" }
        );

        // Mark second purchase as cancelled directly for test
        const p2 = mock.getPurchasesMap().get(`${tenantA}:pur_a-2`);
        if (p2) p2.status = "cancelled";

        // Save 1 purchase for Tenant B
        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-B-1",
                supplierId: serverSupplierId,
                warehouse: { name: "W2" },
                items: [{ productId: serverProductId, quantity: 3, unitPrice: 10 }],
            },
            tenantB,
            { db: mock.db, operationId: "op-b-1", localId: "pur_b-1" }
        );

        // Query Tenant A (excluding cancelled by default)
        const activeA = await getCachedPurchasesForTenant(tenantA, {}, mock.db);
        check("Tenant A query returns 1 active purchase (cancelled excluded)", activeA.length === 1);
        check("Returned record is PO-A-1", activeA[0]?.purchaseNo === "PO-A-1");

        // Query Tenant A with includeCancelled
        const allA = await getCachedPurchasesForTenant(tenantA, { includeCancelled: true }, mock.db);
        check("Tenant A with includeCancelled returns 2 purchases", allA.length === 2);

        // Query Tenant B
        const allB = await getCachedPurchasesForTenant(tenantB, {}, mock.db);
        check("Tenant B query returns 1 purchase", allB.length === 1);
        check("Tenant B record is PO-B-1", allB[0]?.purchaseNo === "PO-B-1");

        // Lookup by ID
        const foundA1 = await getCachedPurchaseById("pur_a-1", tenantA, mock.db);
        check("getCachedPurchaseById finds Tenant A record", foundA1?.purchaseNo === "PO-A-1");
        const notFoundInB = await getCachedPurchaseById("pur_a-1", tenantB, mock.db);
        check("getCachedPurchaseById returns null for wrong tenant", notFoundInB === null);

        // Lookup by OperationId
        const foundOpA = await getCachedPurchaseByOperationId("op-a-1", tenantA, mock.db);
        check("getCachedPurchaseByOperationId finds Tenant A record", foundOpA?.purchaseNo === "PO-A-1");
        const notFoundOpB = await getCachedPurchaseByOperationId("op-a-1", tenantB, mock.db);
        check("getCachedPurchaseByOperationId returns null for wrong tenant", notFoundOpB === null);
    }

    // ------------------------------------------------------------
    // SUITE 10: Failed Sync Marking (No Silent Deletion)
    // ------------------------------------------------------------
    console.log("\n--- Suite 10: Failed Sync Marking (No Silent Deletion) ---");
    {
        const mock = createMemoryOfflineDb();
        const opId = "op-fail-test";

        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-FAIL-TEST",
                supplierId: serverSupplierId,
                warehouse: { name: "Main" },
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 100 }],
            },
            tenantA,
            { db: mock.db, operationId: opId, localId: "pur_fail-1" }
        );

        // Mark as FAILED
        const markedFailed = await markCachedPurchaseFailed(
            {
                operationId: opId,
                tenantId: tenantA,
                status: "FAILED",
                errorMessage: "Network unreachable after 5 retries",
            },
            mock.db
        );
        check("markCachedPurchaseFailed returns true", markedFailed);

        const failedRec = await getCachedPurchaseByOperationId(opId, tenantA, mock.db);
        check("Failed record was NOT deleted", !!failedRec);
        check("Failed record syncStatus is FAILED", failedRec?.syncStatus === "FAILED");
        check("Failed record has errorMessage", failedRec?.errorMessage === "Network unreachable after 5 retries");

        // Mark as NEEDS_ATTENTION
        const markedAttention = await markCachedPurchaseFailed(
            {
                operationId: opId,
                tenantId: tenantA,
                status: "NEEDS_ATTENTION",
                errorMessage: "Supplier credit limit exceeded on server",
            },
            mock.db
        );
        check("markCachedPurchaseFailed to NEEDS_ATTENTION returns true", markedAttention);

        const attentionRec = await getCachedPurchaseByOperationId(opId, tenantA, mock.db);
        check("NEEDS_ATTENTION record was NOT deleted", !!attentionRec);
        check("Record syncStatus is NEEDS_ATTENTION", attentionRec?.syncStatus === "NEEDS_ATTENTION");
        check("Record has updated errorMessage", attentionRec?.errorMessage === "Supplier credit limit exceeded on server");

        // Cross-tenant attempt to mark fail is rejected
        const wrongTenantFail = await markCachedPurchaseFailed(
            {
                operationId: opId,
                tenantId: tenantB,
                status: "FAILED",
            },
            mock.db
        );
        check("markCachedPurchaseFailed for wrong tenant returns false", wrongTenantFail === false);
    }

    // ------------------------------------------------------------
    // SUITE 11: Server Confirmation Reconciliation
    // ------------------------------------------------------------
    console.log("\n--- Suite 11: Server Confirmation Reconciliation ---");
    {
        const mock = createMemoryOfflineDb();
        const opId = "op-reconcile-001";
        const localId = "pur_temp-rec-1";
        const confirmedServerId = "670c55555555555555555555";
        const confirmedServerNo = "PO-CONFIRMED-0001";

        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-DRAFT-LOCAL",
                supplierId: serverSupplierId,
                warehouse: { name: "Main" },
                items: [{ productId: serverProductId, quantity: 2, unitPrice: 50 }],
            },
            tenantA,
            { db: mock.db, operationId: opId, localId }
        );

        // Verify initial state
        const initial = await getCachedPurchaseById(localId, tenantA, mock.db);
        check("Initial record has temporary localId", initial?.purchaseId === localId);
        check("Initial syncStatus is PENDING", initial?.syncStatus === "PENDING");

        // Perform reconciliation
        const recResult1 = await reconcileConfirmedPurchaseSync(
            {
                operationId: opId,
                tenantId: tenantA,
                serverPurchaseId: confirmedServerId,
                serverPurchaseNo: confirmedServerNo,
            },
            mock.db
        );

        check("Reconciliation succeeds", recResult1.reconciled === true);
        check("Reconciliation returns updated purchase", !!recResult1.purchase);
        check("Reconciled syncStatus is SYNCED", recResult1.purchase?.syncStatus === "SYNCED");
        check("Reconciled purchaseId is server ID", recResult1.purchase?.purchaseId === confirmedServerId);
        check("Reconciled serverPurchaseId is set", recResult1.purchase?.serverPurchaseId === confirmedServerId);
        check("Reconciled purchaseNo updated to server number", recResult1.purchase?.purchaseNo === confirmedServerNo);

        // Check index migration: old temporary key is deleted, new server key is stored
        const oldKeyLookup = await mock.getPurchasesMap().get(`${tenantA}:${localId}`);
        check("Old temporary key is deleted", oldKeyLookup === undefined);

        const newKeyLookup = await mock.getPurchasesMap().get(`${tenantA}:${confirmedServerId}`);
        check("New server key is present in table", newKeyLookup !== undefined);

        // Lookup by new server ID
        const lookupByServerId = await getCachedPurchaseById(confirmedServerId, tenantA, mock.db);
        check("getCachedPurchaseById with server ID returns reconciled record", lookupByServerId !== null);

        // Lookup by operationId returns reconciled record
        const lookupByOpId = await getCachedPurchaseByOperationId(opId, tenantA, mock.db);
        check("getCachedPurchaseByOperationId returns reconciled record", lookupByOpId?.purchaseId === confirmedServerId);

        // Idempotency: repeated reconciliation call
        const recResult2 = await reconcileConfirmedPurchaseSync(
            {
                operationId: opId,
                tenantId: tenantA,
                serverPurchaseId: confirmedServerId,
                serverPurchaseNo: confirmedServerNo,
            },
            mock.db
        );
        check("Repeated reconciliation call returns reconciled: true", recResult2.reconciled === true);
        check("cachedPurchases still has exactly 1 record (no duplicate created)", mock.getPurchasesMap().size === 1);

        // Cross-tenant reconciliation fails safely
        const recWrongTenant = await reconcileConfirmedPurchaseSync(
            {
                operationId: opId,
                tenantId: tenantB,
                serverPurchaseId: confirmedServerId,
            },
            mock.db
        );
        check("Reconciliation for wrong tenant returns reconciled: false", recWrongTenant.reconciled === false);

        // Missing server ID returns false
        const recMissingServerId = await reconcileConfirmedPurchaseSync(
            {
                operationId: opId,
                tenantId: tenantA,
                serverPurchaseId: "",
            },
            mock.db
        );
        check("Reconciliation with empty server ID returns reconciled: false", recMissingServerId.reconciled === false);
    }

    // ------------------------------------------------------------
    // SUITE 12: Tenant Cache Purge / Clear
    // ------------------------------------------------------------
    console.log("\n--- Suite 12: Tenant Cache Cleanup ---");
    {
        const mock = createMemoryOfflineDb();

        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-PURGE-A1",
                supplierId: serverSupplierId,
                warehouse: { name: "Main" },
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            },
            tenantA,
            { db: mock.db, operationId: "op-purge-a1" }
        );

        await savePendingOfflinePurchase(
            {
                purchaseNo: "PO-PURGE-B1",
                supplierId: serverSupplierId,
                warehouse: { name: "Main" },
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 20 }],
            },
            tenantB,
            { db: mock.db, operationId: "op-purge-b1" }
        );

        check("Before purge, total records in map is 2", mock.getPurchasesMap().size === 2);

        // Clear Tenant A only
        const deletedA = await clearCachedPurchasesForTenant(tenantA, mock.db);
        check("clearCachedPurchasesForTenant(tenantA) reports 1 record deleted", deletedA === 1);
        check("Tenant A records are gone", (await getCachedPurchasesForTenant(tenantA, {}, mock.db)).length === 0);
        check("Tenant B records remain intact", (await getCachedPurchasesForTenant(tenantB, {}, mock.db)).length === 1);
        check("Total records in map is 1", mock.getPurchasesMap().size === 1);
    }

    // ------------------------------------------------------------
    // FINAL REPORT
    // ------------------------------------------------------------
    const allPassed = summarize();
    if (!allPassed) {
        process.exit(1);
    }
}

runAllTests().catch((err) => {
    console.error("Test execution fatal error:", err);
    process.exit(1);
});
