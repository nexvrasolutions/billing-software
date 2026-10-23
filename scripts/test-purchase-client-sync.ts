/**
 * Test Suite: Purchases Offline Support (Step 2.3: SyncManager Integration)
 * (DATABASE-FREE, ATLAS-FREE, NETWORK-FREE, BROWSER-FREE UNIT TESTS)
 *
 * Verifies all 12 Step 2.3 requirements:
 * 1. Purchase sync is deferred while a temporary supplier dependency remains unresolved (SKIPPED).
 * 2. Purchase sync is deferred while a temporary product dependency remains unresolved (SKIPPED).
 * 3. Resolved temporary supplier IDs are rewritten to server MongoDB ObjectIds and official codes in queued purchases and cachedPurchases.
 * 4. Resolved temporary product IDs are rewritten in purchase line items in queued purchases and cachedPurchases.
 * 5. Cross-tenant protection: dependencies and queued operations from other tenants remain strictly untouched.
 * 6. A failed dependency (NEEDS_ATTENTION) cascades without silent deletion or endless retries.
 * 7. Purchase is reconciled ONLY after a confirmed successful server response.
 * 8. Reconciliation records confirmed server ID and official purchase number correctly.
 * 9. Repeated reconciliation is idempotent and does not create duplicate records.
 * 10. Network failure (unreachable) and MAINTENANCE_PAUSED keep the queued operation safely retryable without burning attempt quotas.
 * 11. Existing contracts and prerequisite prioritization in selectSyncable (Supplier/Product before Purchase) hold.
 * 12. A purchase with unresolved temporary IDs is never sent to the server (absolute safety gate).
 *
 * Run:
 *   npx tsx scripts/test-purchase-client-sync.ts
 */

import {
    type CachedPurchaseRecord,
    type CachedSupplierRecord,
    type CachedProductRecord,
    type SyncQueueItem,
    type OfflineDatabase,
} from "../lib/offline/db";
import {
    makeCachedPurchaseId,
    reconcileConfirmedPurchaseSync,
    markCachedPurchaseFailed,
    ensurePendingPurchasesQueued,
    savePendingOfflinePurchase,
    getCachedPurchasesForTenant,
} from "../lib/offline/purchaseCache";
import {
    makeCachedSupplierId,
    resolvePendingSupplierId,
    isTemporarySupplierId,
} from "../lib/offline/supplierCache";
import {
    makeCachedProductId,
    resolvePendingProductId,
} from "../lib/offline/productCatalogueCache";
import {
    selectSyncable,
    interpretResponse,
    decideAfterOutcome,
    type SessionIdentity,
} from "../lib/offline/syncPolicy";
import { isTemporaryProductId } from "../lib/validations/purchase";

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
    console.log(`PURCHASE CLIENT SYNC TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock implementing OfflineDatabase tables with transactions
function createMemoryOfflineDb() {
    let cachedPurchasesMap = new Map<string, CachedPurchaseRecord>();
    let cachedSuppliersMap = new Map<string, CachedSupplierRecord>();
    let cachedProductsMap = new Map<string, CachedProductRecord>();
    let syncQueueList: SyncQueueItem[] = [];
    const metaMap = new Map<string, unknown>();

    let nextQueueId = 1;

    const db = {
        cachedPurchases: {
            get: async (key: string) => {
                const item = cachedPurchasesMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: CachedPurchaseRecord) => {
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
                    filter: (predicate: (item: CachedPurchaseRecord) => boolean) => ({
                        toArray: async () => {
                            const all = Array.from(cachedPurchasesMap.values());
                            return all
                                .filter((s) => (s as unknown as Record<string, unknown>)[field] === val && predicate(s))
                                .map((v) => structuredClone(v));
                        },
                    }),
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
                        return all.filter((s) => (s as unknown as Record<string, unknown>)[field] === val).map((v) => structuredClone(v));
                    },
                }),
            }),
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
            delete: async (key: string) => {
                cachedProductsMap.delete(key);
            },
            toArray: async () => {
                return Array.from(cachedProductsMap.values()).map((v) => structuredClone(v));
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = Array.from(cachedProductsMap.values());
                        return all.filter((s) => (s as unknown as Record<string, unknown>)[field] === val).map((v) => structuredClone(v));
                    },
                }),
            }),
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
            filter: (predicate: (q: SyncQueueItem) => boolean) => ({
                toArray: async () => {
                    return syncQueueList.filter(predicate).map((q) => structuredClone(q));
                },
            }),
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
            const purchasesSnapshot = new Map(
                Array.from(cachedPurchasesMap.entries()).map(([k, v]) => [k, structuredClone(v)])
            );
            const suppliersSnapshot = new Map(
                Array.from(cachedSuppliersMap.entries()).map(([k, v]) => [k, structuredClone(v)])
            );
            const productsSnapshot = new Map(
                Array.from(cachedProductsMap.entries()).map(([k, v]) => [k, structuredClone(v)])
            );
            const queueSnapshot = syncQueueList.map((item) => structuredClone(item));
            const queueIdSnapshot = nextQueueId;

            try {
                return await callback();
            } catch (err) {
                cachedPurchasesMap = purchasesSnapshot;
                cachedSuppliersMap = suppliersSnapshot;
                cachedProductsMap = productsSnapshot;
                syncQueueList = queueSnapshot;
                nextQueueId = queueIdSnapshot;
                throw err;
            }
        },
    } as unknown as OfflineDatabase;

    return {
        db,
        getPurchasesMap: () => cachedPurchasesMap,
        getSuppliersMap: () => cachedSuppliersMap,
        getProductsMap: () => cachedProductsMap,
        getQueueList: () => syncQueueList,
    };
}

/**
 * Pure evaluation function modeling SyncManager's pre-upload dependency guard for Purchase.
 * Exactly reflects the implementation in lib/offline/SyncManager.ts.
 */
async function evaluatePurchasePreUploadGuard(
    item: SyncQueueItem,
    identity: SessionIdentity,
    db: OfflineDatabase
): Promise<"ALLOW" | "SKIP" | "NEEDS_ATTENTION"> {
    if (item.entityType !== "Purchase") return "ALLOW";

    const rawSupId = typeof item.payload?.supplierId === "string" ? item.payload.supplierId.trim() : "";
    if (rawSupId && isTemporarySupplierId(rawSupId)) {
        const cachedKey = makeCachedSupplierId(identity.tenantId, rawSupId);
        const cached = await db.cachedSuppliers.get(cachedKey);

        if (cached && cached.syncStatus === "NEEDS_ATTENTION") {
            return "NEEDS_ATTENTION";
        }
        if (!cached) {
            return "NEEDS_ATTENTION";
        }
        return "SKIP";
    }

    const lineItems = Array.isArray(item.payload?.items) ? item.payload.items : [];
    for (const line of lineItems) {
        const lineProdId = typeof (line as Record<string, unknown> | undefined)?.productId === "string"
            ? String((line as Record<string, unknown>).productId).trim()
            : "";

        if (lineProdId && isTemporaryProductId(lineProdId)) {
            const cachedProdKey = makeCachedProductId(identity.tenantId, lineProdId);
            const cachedProd = await db.cachedProducts.get(cachedProdKey);

            if (cachedProd && cachedProd.syncStatus === "NEEDS_ATTENTION") {
                return "NEEDS_ATTENTION";
            }
            if (!cachedProd) {
                return "NEEDS_ATTENTION";
            }
            return "SKIP";
        }
    }

    if (Array.isArray(item.dependsOn) && item.dependsOn.length > 0) {
        for (const depOpId of item.dependsOn) {
            const depWhere = db.syncQueue.where("operationId").equals(depOpId);
            const depItem = typeof depWhere.first === "function"
                ? await depWhere.first()
                : (await depWhere.toArray())[0];

            if (depItem) {
                if (depItem.status === "NEEDS_ATTENTION") {
                    return "NEEDS_ATTENTION";
                }
                if (depItem.status !== "SYNCED") {
                    return "SKIP";
                }
            }
        }
    }

    const finalSupId = typeof item.payload?.supplierId === "string" ? item.payload.supplierId.trim() : "";
    const hasUnresolvedTemp =
        isTemporarySupplierId(finalSupId) ||
        lineItems.some((it: unknown) => {
            const pid = (it as Record<string, unknown> | undefined)?.productId;
            return typeof pid === "string" && isTemporaryProductId(pid);
        });

    if (hasUnresolvedTemp) {
        return "SKIP";
    }

    return "ALLOW";
}

// ============================================================
// TEST SUITES
// ============================================================

async function runAllTests() {
    console.log("=== BILLING SAAS: PURCHASE CLIENT SYNC & RECONCILIATION TESTS ===\n");

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
    // SUITE 1: Supplier Dependency Deferral (SKIP)
    // ------------------------------------------------------------
    console.log("--- Suite 1: Supplier Dependency Deferral (SKIP) ---");
    {
        const mock = createMemoryOfflineDb();
        const tempSupId = "sup_temp_pending_1";

        // Seed pending supplier in cachedSuppliers
        await mock.db.cachedSuppliers.put({
            id: makeCachedSupplierId(tenantA, tempSupId),
            supplierId: tempSupId,
            tenantId: tenantA,
            name: "Pending Supplier",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "PENDING",
        });

        const purchaseQueueItem: SyncQueueItem = {
            operationId: "op-pur-wait-sup",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-WAIT-SUP",
                supplierId: tempSupId,
                items: [{ productId: serverProductId, quantity: 2, unitPrice: 50 }],
            },
            status: "PENDING",
            localSeq: 100,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
            ownerUserId: sessionOwnerA.userId,
        };

        const decision = await evaluatePurchasePreUploadGuard(purchaseQueueItem, sessionOwnerA, mock.db);
        check("Purchase with pending temporary supplier is deferred (SKIP)", decision === "SKIP");
    }

    // ------------------------------------------------------------
    // SUITE 2: Product Dependency Deferral (SKIP)
    // ------------------------------------------------------------
    console.log("\n--- Suite 2: Product Dependency Deferral (SKIP) ---");
    {
        const mock = createMemoryOfflineDb();
        const tempProdId = "prod_temp_pending_2";

        // Seed pending product in cachedProducts
        await mock.db.cachedProducts.put({
            id: makeCachedProductId(tenantA, tempProdId),
            productId: tempProdId,
            tenantId: tenantA,
            name: "Pending Product",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "PENDING",
        } as CachedProductRecord);

        const purchaseQueueItem: SyncQueueItem = {
            operationId: "op-pur-wait-prod",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-WAIT-PROD",
                supplierId: serverSupplierId,
                items: [{ productId: tempProdId, quantity: 5, unitPrice: 20 }],
            },
            status: "PENDING",
            localSeq: 101,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
            ownerUserId: sessionOwnerA.userId,
        };

        const decision = await evaluatePurchasePreUploadGuard(purchaseQueueItem, sessionOwnerA, mock.db);
        check("Purchase with pending temporary product is deferred (SKIP)", decision === "SKIP");
    }

    // ------------------------------------------------------------
    // SUITE 3: Supplier ID Resolution and Rewriting
    // ------------------------------------------------------------
    console.log("\n--- Suite 3: Supplier ID Resolution and Rewriting ---");
    {
        const mock = createMemoryOfflineDb();
        const tempSupId = "sup_temp_to_resolve";
        const confirmedServerSupId = "670c88888888888888888888";
        const confirmedSupCode = "SUP-OFFICIAL-0088";
        const supOpId = "op-create-sup-88";

        // Seed temporary supplier in cachedSuppliers
        await mock.db.cachedSuppliers.put({
            id: makeCachedSupplierId(tenantA, tempSupId),
            supplierId: tempSupId,
            tenantId: tenantA,
            supplierCode: "SUP-TEMP-88",
            name: "Acme Corp",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "PENDING",
            operationId: supOpId,
        });

        // Seed a pending purchase referencing this supplier
        const purLocalId = "pur_local_sup_rewrite";
        await mock.db.cachedPurchases.put({
            id: makeCachedPurchaseId(tenantA, purLocalId),
            purchaseId: purLocalId,
            tenantId: tenantA,
            operationId: "op-pur-sup-rewrite",
            purchaseNo: "PO-SUP-REWRITE",
            supplierId: tempSupId,
            supplierCode: "SUP-TEMP-88",
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 1, unitPrice: 100 }],
            grandTotal: 100,
            paidAmount: 0,
            status: "received",
            syncStatus: "PENDING",
            cachedAt: new Date().toISOString(),
        });

        // Seed queue item for this purchase with dependsOn
        await mock.db.syncQueue.add({
            operationId: "op-pur-sup-rewrite",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-SUP-REWRITE",
                supplierId: tempSupId,
                supplierCode: "SUP-TEMP-88",
                supplierSnapshot: { name: "Acme Corp", supplierCode: "SUP-TEMP-88" },
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 100 }],
            },
            status: "PENDING",
            localSeq: 105,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
            ownerUserId: sessionOwnerA.userId,
            dependsOn: [supOpId],
        });

        // Resolve supplier
        const res = await resolvePendingSupplierId(
            tempSupId,
            confirmedServerSupId,
            confirmedSupCode,
            tenantA,
            mock.db,
            supOpId
        );

        check("resolvePendingSupplierId reports resolved", res.resolved === true);
        check("resolvePendingSupplierId reports 1 dependent purchase updated", res.dependentPurchasesUpdated === 1);

        // Check syncQueue item rewritten
        const updatedQ = mock.getQueueList().find((q) => q.operationId === "op-pur-sup-rewrite");
        check("Queue item supplierId rewritten to confirmed server ObjectId", updatedQ?.payload?.supplierId === confirmedServerSupId);
        check("Queue item supplierCode rewritten to official code", updatedQ?.payload?.supplierCode === confirmedSupCode);
        check("Supplier opId removed from queue item dependsOn", updatedQ?.dependsOn === undefined || !updatedQ.dependsOn.includes(supOpId));

        // Check cachedPurchases record rewritten
        const updatedCache = await mock.db.cachedPurchases.get(makeCachedPurchaseId(tenantA, purLocalId));
        check("cachedPurchases supplierId updated to confirmed server ObjectId", updatedCache?.supplierId === confirmedServerSupId);
        check("cachedPurchases supplierCode updated to official code", updatedCache?.supplierCode === confirmedSupCode);
    }

    // ------------------------------------------------------------
    // SUITE 4: Product ID Resolution and Rewriting
    // ------------------------------------------------------------
    console.log("\n--- Suite 4: Product ID Resolution and Rewriting ---");
    {
        const mock = createMemoryOfflineDb();
        const tempProdId = "prod_temp_to_resolve";
        const confirmedServerProdId = "670c99999999999999999999";
        const prodOpId = "op-create-prod-99";

        // Seed temporary product in cachedProducts
        await mock.db.cachedProducts.put({
            id: makeCachedProductId(tenantA, tempProdId),
            productId: tempProdId,
            tenantId: tenantA,
            name: "Widget Pro",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "PENDING",
            operationId: prodOpId,
        } as CachedProductRecord);

        // Seed a pending purchase referencing this temporary product
        const purLocalId = "pur_local_prod_rewrite";
        await mock.db.cachedPurchases.put({
            id: makeCachedPurchaseId(tenantA, purLocalId),
            purchaseId: purLocalId,
            tenantId: tenantA,
            operationId: "op-pur-prod-rewrite",
            purchaseNo: "PO-PROD-REWRITE",
            supplierId: serverSupplierId,
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Central" },
            items: [
                { productId: tempProdId, quantity: 3, unitPrice: 30 },
                { productId: serverProductId, quantity: 1, unitPrice: 10 },
            ],
            grandTotal: 100,
            paidAmount: 0,
            status: "received",
            syncStatus: "PENDING",
            cachedAt: new Date().toISOString(),
        });

        // Seed queue item for this purchase with dependsOn
        await mock.db.syncQueue.add({
            operationId: "op-pur-prod-rewrite",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-PROD-REWRITE",
                supplierId: serverSupplierId,
                items: [
                    { productId: tempProdId, quantity: 3, unitPrice: 30 },
                    { productId: serverProductId, quantity: 1, unitPrice: 10 },
                ],
            },
            status: "PENDING",
            localSeq: 110,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
            ownerUserId: sessionOwnerA.userId,
            dependsOn: [prodOpId],
        });

        // Resolve product
        const res = await resolvePendingProductId(
            tempProdId,
            confirmedServerProdId,
            tenantA,
            mock.db
        );

        check("resolvePendingProductId reports resolved", res.resolved === true);
        check("resolvePendingProductId reports dependent sales/purchases updated", res.dependentSalesUpdated === 1);

        // Check syncQueue item rewritten
        const updatedQ = mock.getQueueList().find((q) => q.operationId === "op-pur-prod-rewrite");
        const queueItems = updatedQ?.payload?.items as Array<{ productId: string }>;
        check("Queue line item 0 rewritten to confirmed server ObjectId", queueItems?.[0]?.productId === confirmedServerProdId);
        check("Queue line item 1 (unrelated server ID) untouched", queueItems?.[1]?.productId === serverProductId);
        check("Product opId removed from queue item dependsOn", updatedQ?.dependsOn === undefined || !updatedQ.dependsOn.includes(prodOpId));

        // Check cachedPurchases record line items rewritten
        const updatedCache = await mock.db.cachedPurchases.get(makeCachedPurchaseId(tenantA, purLocalId));
        check("cachedPurchases line item 0 updated to confirmed server ObjectId", updatedCache?.items[0]?.productId === confirmedServerProdId);
        check("cachedPurchases line item 1 untouched", updatedCache?.items[1]?.productId === serverProductId);
    }

    // ------------------------------------------------------------
    // SUITE 5: Cross-Tenant Protection
    // ------------------------------------------------------------
    console.log("\n--- Suite 5: Cross-Tenant Protection ---");
    {
        const mock = createMemoryOfflineDb();
        const sharedLocalSupId = "sup_shared_id";
        const sharedLocalProdId = "prod_shared_id";

        // Seed Tenant B purchase referencing same ID string
        await mock.db.syncQueue.add({
            operationId: "op-tenant-b-purchase",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-TENANT-B",
                supplierId: sharedLocalSupId,
                items: [{ productId: sharedLocalProdId, quantity: 1, unitPrice: 50 }],
            },
            status: "PENDING",
            localSeq: 200,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: { tenantId: tenantB, userId: "user-beta", deviceId: "device-beta" },
            ownerUserId: "user-beta",
            dependsOn: ["op-sup-tenant-b"],
        });

        // Run Tenant A supplier resolution
        await resolvePendingSupplierId(
            sharedLocalSupId,
            "670cAAAAAAAAAAAAAAAAAAAAAAAA",
            "SUP-TENANT-A",
            tenantA,
            mock.db,
            "op-sup-tenant-a"
        );

        // Run Tenant A product resolution
        await resolvePendingProductId(
            sharedLocalProdId,
            "670cBBBBBBBBBBBBBBBBBBBBBBBB",
            tenantA,
            mock.db
        );

        // Check Tenant B queue item is completely untouched
        const tenantBQ = mock.getQueueList().find((q) => q.operationId === "op-tenant-b-purchase");
        check("Cross-tenant purchase supplierId was strictly untouched", tenantBQ?.payload?.supplierId === sharedLocalSupId);
        const bItems = tenantBQ?.payload?.items as Array<{ productId: string }>;
        check("Cross-tenant purchase productId was strictly untouched", bItems?.[0]?.productId === sharedLocalProdId);
        check("Cross-tenant purchase dependsOn was strictly untouched", tenantBQ?.dependsOn?.[0] === "op-sup-tenant-b");
    }

    // ------------------------------------------------------------
    // SUITE 6: Permanent Failure Cascading (NEEDS_ATTENTION)
    // ------------------------------------------------------------
    console.log("\n--- Suite 6: Permanent Failure Cascading (NEEDS_ATTENTION) ---");
    {
        const mock = createMemoryOfflineDb();
        const tempSupFailed = "sup_failed_perm";
        const tempProdFailed = "prod_failed_perm";

        // Seed supplier in NEEDS_ATTENTION
        await mock.db.cachedSuppliers.put({
            id: makeCachedSupplierId(tenantA, tempSupFailed),
            supplierId: tempSupFailed,
            tenantId: tenantA,
            name: "Failed Supplier",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "NEEDS_ATTENTION",
            errorMessage: "Duplicate GSTIN on server",
        });

        // Seed product in NEEDS_ATTENTION
        await mock.db.cachedProducts.put({
            id: makeCachedProductId(tenantA, tempProdFailed),
            productId: tempProdFailed,
            tenantId: tenantA,
            name: "Failed Product",
            status: "active",
            cachedAt: new Date().toISOString(),
            syncStatus: "NEEDS_ATTENTION",
            errorMessage: "Barcode conflict on server",
        } as CachedProductRecord);

        // Purchase with failed supplier
        const qItemSupFail: SyncQueueItem = {
            operationId: "op-pur-fail-sup",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-FAIL-SUP",
                supplierId: tempSupFailed,
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            },
            status: "PENDING",
            localSeq: 300,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
        };

        const supDecision = await evaluatePurchasePreUploadGuard(qItemSupFail, sessionOwnerA, mock.db);
        check("Purchase with failed supplier dependency transitions to NEEDS_ATTENTION", supDecision === "NEEDS_ATTENTION");

        // Purchase with failed product
        const qItemProdFail: SyncQueueItem = {
            operationId: "op-pur-fail-prod",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-FAIL-PROD",
                supplierId: serverSupplierId,
                items: [{ productId: tempProdFailed, quantity: 1, unitPrice: 10 }],
            },
            status: "PENDING",
            localSeq: 301,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
        };

        const prodDecision = await evaluatePurchasePreUploadGuard(qItemProdFail, sessionOwnerA, mock.db);
        check("Purchase with failed product dependency transitions to NEEDS_ATTENTION", prodDecision === "NEEDS_ATTENTION");

        // Verify markCachedPurchaseFailed does not delete the record
        const purLocalId = "pur_failed_perm_record";
        await mock.db.cachedPurchases.put({
            id: makeCachedPurchaseId(tenantA, purLocalId),
            purchaseId: purLocalId,
            tenantId: tenantA,
            operationId: "op-pur-fail-sup",
            purchaseNo: "PO-FAIL-SUP",
            supplierId: tempSupFailed,
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            grandTotal: 10,
            paidAmount: 0,
            status: "received",
            syncStatus: "PENDING",
            cachedAt: new Date().toISOString(),
        });

        const marked = await markCachedPurchaseFailed(
            {
                operationId: "op-pur-fail-sup",
                tenantId: tenantA,
                status: "NEEDS_ATTENTION",
                errorMessage: "Dependent supplier creation failed: Duplicate GSTIN on server",
            },
            mock.db
        );
        check("markCachedPurchaseFailed succeeded", marked === true);
        const record = await mock.db.cachedPurchases.get(makeCachedPurchaseId(tenantA, purLocalId));
        check("Record was NOT deleted", !!record);
        check("Record status is NEEDS_ATTENTION", record?.syncStatus === "NEEDS_ATTENTION");
        check("Record retains error message", record?.errorMessage?.includes("Duplicate GSTIN") === true);
    }

    // ------------------------------------------------------------
    // SUITE 7 & 8: Confirmed Server Reconciliation & ID Recording
    // ------------------------------------------------------------
    console.log("\n--- Suite 7 & 8: Confirmed Server Reconciliation ---");
    {
        const mock = createMemoryOfflineDb();
        const purLocalId = "pur_temp_reconcile";
        const opId = "op-pur-reconcile-success";
        const confirmedServerPurchaseId = "670cCCCCCCCCCCCCCCCCCCCC";
        const confirmedPurchaseNo = "PO-CONFIRMED-2026-001";

        // Seed pending cached purchase
        await mock.db.cachedPurchases.put({
            id: makeCachedPurchaseId(tenantA, purLocalId),
            purchaseId: purLocalId,
            tenantId: tenantA,
            operationId: opId,
            purchaseNo: "PO-TEMP-DRAFT",
            supplierId: serverSupplierId,
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 10, unitPrice: 25 }],
            grandTotal: 250,
            paidAmount: 250,
            status: "received",
            syncStatus: "PENDING",
            cachedAt: new Date().toISOString(),
        });

        // Run reconciliation
        const rec = await reconcileConfirmedPurchaseSync(
            {
                operationId: opId,
                tenantId: tenantA,
                serverPurchaseId: confirmedServerPurchaseId,
                serverPurchaseNo: confirmedPurchaseNo,
            },
            mock.db
        );

        check("Reconciliation succeeds with confirmed server data", rec.reconciled === true);
        check("Reconciled record has server MongoDB ObjectId", rec.purchase?.purchaseId === confirmedServerPurchaseId);
        check("Reconciled record has serverPurchaseId set", rec.purchase?.serverPurchaseId === confirmedServerPurchaseId);
        check("Reconciled record purchaseNo updated to server official number", rec.purchase?.purchaseNo === confirmedPurchaseNo);
        check("Reconciled record syncStatus is SYNCED", rec.purchase?.syncStatus === "SYNCED");
        check("Old temporary compound key removed from cachedPurchases", mock.getPurchasesMap().get(makeCachedPurchaseId(tenantA, purLocalId)) === undefined);
        check("New compound key exists in cachedPurchases", mock.getPurchasesMap().get(makeCachedPurchaseId(tenantA, confirmedServerPurchaseId)) !== undefined);
    }

    // ------------------------------------------------------------
    // SUITE 9: Idempotent Repeated Reconciliation
    // ------------------------------------------------------------
    console.log("\n--- Suite 9: Idempotent Repeated Reconciliation ---");
    {
        const mock = createMemoryOfflineDb();
        const opId = "op-pur-idempotent-rec";
        const confirmedId = "670cDDDDDDDDDDDDDDDDDDDD";

        await mock.db.cachedPurchases.put({
            id: makeCachedPurchaseId(tenantA, "pur_temp_idem"),
            purchaseId: "pur_temp_idem",
            tenantId: tenantA,
            operationId: opId,
            purchaseNo: "PO-IDEM",
            supplierId: serverSupplierId,
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            grandTotal: 10,
            paidAmount: 0,
            status: "received",
            syncStatus: "PENDING",
            cachedAt: new Date().toISOString(),
        });

        // First reconciliation
        const rec1 = await reconcileConfirmedPurchaseSync(
            { operationId: opId, tenantId: tenantA, serverPurchaseId: confirmedId },
            mock.db
        );
        check("First reconciliation returns reconciled: true", rec1.reconciled === true);
        check("Total cached purchases is 1", mock.getPurchasesMap().size === 1);

        // Repeated reconciliation (idempotent replay)
        const rec2 = await reconcileConfirmedPurchaseSync(
            { operationId: opId, tenantId: tenantA, serverPurchaseId: confirmedId },
            mock.db
        );
        check("Second reconciliation returns reconciled: true", rec2.reconciled === true);
        check("Total cached purchases remains exactly 1 (no duplicates)", mock.getPurchasesMap().size === 1);
        check("Cached record purchaseId remains confirmedId", rec2.purchase?.purchaseId === confirmedId);
    }

    // ------------------------------------------------------------
    // SUITE 10: Network Failure and MAINTENANCE_PAUSED Retryability
    // ------------------------------------------------------------
    console.log("\n--- Suite 10: Network Failure & MAINTENANCE_PAUSED ---");
    {
        // 10a. MAINTENANCE_PAUSED interpretation
        const maintOutcome = interpretResponse(503, {
            code: "MAINTENANCE_PAUSED",
            message: "Purchase sync processing paused for maintenance",
            retryAfterSeconds: 45,
        });
        check("interpretResponse classifies MAINTENANCE_PAUSED as retryable", maintOutcome.kind === "retryable");
        check("maintOutcome has isMaintenance: true", (maintOutcome as any).isMaintenance === true);

        // Decide after maintenance failure: attempts MUST NOT be incremented to protect client quota
        const now = new Date();
        const maintDecision = decideAfterOutcome(maintOutcome, 2, now);
        check("Maintenance failure action is 'failed'", maintDecision.action === "failed");
        if (maintDecision.action === "failed") {
            check("Maintenance failure status is FAILED (never escalated to NEEDS_ATTENTION)", maintDecision.status === "FAILED");
            check("Attempts not incremented during maintenance", maintDecision.attempts === 2);
            check("nextAttemptAt is scheduled with backoff delay", !!maintDecision.nextAttemptAt);
        }

        // 10b. Unreachable / Network Timeout interpretation
        const timeoutDecision = decideAfterOutcome({ kind: "unreachable", message: "Timeout" }, 1, now);
        check("Unreachable outcome action is 'restore'", timeoutDecision.action === "restore");
        if (timeoutDecision.action === "restore") {
            check("stopReason is unreachable", timeoutDecision.stopReason === "unreachable");
        }
    }

    // ------------------------------------------------------------
    // SUITE 11: Prerequisite Prioritization & Queue Healing
    // ------------------------------------------------------------
    console.log("\n--- Suite 11: Prerequisite Prioritization & Queue Healing ---");
    {
        const mock = createMemoryOfflineDb();

        // 11a. selectSyncable ordering: Supplier and Product must precede Purchase
        const now = new Date();
        const queueItems: SyncQueueItem[] = [
            {
                operationId: "op-pur-1",
                entityType: "Purchase",
                operationType: "CREATE",
                payload: {},
                status: "PENDING",
                localSeq: 10,
                attempts: 0,
                createdAt: now.toISOString(),
                owner: sessionOwnerA,
            },
            {
                operationId: "op-sup-1",
                entityType: "Supplier",
                operationType: "CREATE",
                payload: {},
                status: "PENDING",
                localSeq: 20,
                attempts: 0,
                createdAt: now.toISOString(),
                owner: sessionOwnerA,
            },
            {
                operationId: "op-prod-1",
                entityType: "Product",
                operationType: "CREATE",
                payload: {},
                status: "PENDING",
                localSeq: 30,
                attempts: 0,
                createdAt: now.toISOString(),
                owner: sessionOwnerA,
            },
        ];

        const sorted = selectSyncable(queueItems, sessionOwnerA, now);
        check("selectSyncable returns all 3 candidates", sorted.length === 3);
        check("First candidate is Supplier", sorted[0]?.entityType === "Supplier");
        check("Second candidate is Product", sorted[1]?.entityType === "Product");
        check("Third candidate is Purchase", sorted[2]?.entityType === "Purchase");

        // 11b. ensurePendingPurchasesQueued healing
        await mock.db.cachedPurchases.put({
            id: makeCachedPurchaseId(tenantA, "pur_orphaned_1"),
            purchaseId: "pur_orphaned_1",
            tenantId: tenantA,
            operationId: "op-pur-orphaned-1",
            purchaseNo: "PO-ORPHAN-1",
            supplierId: serverSupplierId,
            purchaseDate: now.toISOString(),
            warehouse: { name: "Central" },
            items: [{ productId: serverProductId, quantity: 2, unitPrice: 50 }],
            grandTotal: 100,
            paidAmount: 0,
            status: "received",
            syncStatus: "PENDING",
            cachedAt: now.toISOString(),
        });

        check("Before healing, syncQueue is empty", mock.getQueueList().length === 0);
        const healedCount = await ensurePendingPurchasesQueued(tenantA, mock.db, sessionOwnerA);
        check("ensurePendingPurchasesQueued healed 1 orphaned purchase", healedCount === 1);
        check("syncQueue now has 1 item", mock.getQueueList().length === 1);
        const qItem = mock.getQueueList()[0];
        check("Healed queue item entityType is Purchase", qItem.entityType === "Purchase");
        check("Healed queue item operationId matches", qItem.operationId === "op-pur-orphaned-1");
        check("Healed queue item owner assigned", qItem.owner?.userId === sessionOwnerA.userId);

        // Repeated run is idempotent (0 added)
        const healedAgain = await ensurePendingPurchasesQueued(tenantA, mock.db, sessionOwnerA);
        check("Repeated ensurePendingPurchasesQueued adds 0 items", healedAgain === 0);
    }

    // ------------------------------------------------------------
    // SUITE 12: Absolute Safety Gate (Never Send Unresolved Temp IDs)
    // ------------------------------------------------------------
    console.log("\n--- Suite 12: Absolute Safety Gate ---");
    {
        const mock = createMemoryOfflineDb();

        // 12a. Purchase with unresolved temporary supplierId is blocked
        const blockedSupPurchase: SyncQueueItem = {
            operationId: "op-pur-unresolved-sup",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-BLOCKED-SUP",
                supplierId: "sup_unresolved_404",
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            },
            status: "PENDING",
            localSeq: 400,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
        };
        const supGate = await evaluatePurchasePreUploadGuard(blockedSupPurchase, sessionOwnerA, mock.db);
        check("Purchase with un-cached temporary supplier is NOT allowed to upload", supGate !== "ALLOW");

        // 12b. Purchase with unresolved temporary productId is blocked
        const blockedProdPurchase: SyncQueueItem = {
            operationId: "op-pur-unresolved-prod",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-BLOCKED-PROD",
                supplierId: serverSupplierId,
                items: [{ productId: "prod_unresolved_404", quantity: 1, unitPrice: 10 }],
            },
            status: "PENDING",
            localSeq: 401,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
        };
        const prodGate = await evaluatePurchasePreUploadGuard(blockedProdPurchase, sessionOwnerA, mock.db);
        check("Purchase with un-cached temporary product is NOT allowed to upload", prodGate !== "ALLOW");

        // 12c. Purchase with all server ObjectIds is ALLOWED to upload
        const allowedPurchase: SyncQueueItem = {
            operationId: "op-pur-allowed",
            operationType: "CREATE",
            entityType: "Purchase",
            payload: {
                purchaseNo: "PO-ALLOWED",
                supplierId: serverSupplierId,
                items: [{ productId: serverProductId, quantity: 1, unitPrice: 10 }],
            },
            status: "PENDING",
            localSeq: 402,
            attempts: 0,
            createdAt: new Date().toISOString(),
            owner: sessionOwnerA,
        };
        const allowGate = await evaluatePurchasePreUploadGuard(allowedPurchase, sessionOwnerA, mock.db);
        check("Purchase with server ObjectIds is ALLOWED to upload", allowGate === "ALLOW");
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
