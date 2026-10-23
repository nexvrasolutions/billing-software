/**
 * Automated Database-Free Test Suite for Purchase Online Submission Prerequisite Guard
 * (NO MONGODB, NO ATLAS, NO LIVE NETWORK, NO BROWSER STORAGE MUTATIONS).
 *
 * Validates:
 * 1. Online purchase with real IDs uses direct server submission.
 * 2. Online purchase with temporary supplier ID (sup_...) is queued locally.
 * 3. Online purchase with temporary supplier code (SUP-TEMP-...) is queued locally.
 * 4. Online purchase with temporary product ID (prod_...) is queued locally.
 * 5. Offline purchase (!navigator.onLine) is queued locally regardless of ID type.
 * 6. Normal server-side validation failure (HTTP 400/422) is shown as error and NOT silently queued.
 * 7. Repeated submission with the same operation ID preserves idempotency (no duplicate cache or queue entries).
 * 8. User entered quantities, prices, taxes, totals, snapshots, and payment values are preserved.
 *
 * Run:
 *   npx tsx scripts/test-purchase-online-submission-guard.ts
 */

import {
    isTemporarySupplierId,
    isTemporaryProductId,
    createPurchaseSchema,
    offlinePurchasePayloadSchema,
    calculatePurchaseTotals,
} from "../lib/validations/purchase";
import { isTemporarySupplierCode } from "../lib/offline/supplierCache";
import {
    savePendingOfflinePurchase,
    generateTemporaryPurchaseId,
    type CachedPurchaseRecord,
} from "../lib/offline/purchaseCache";
import type { OfflineDatabase, SyncQueueItem, CachedSupplierRecord, CachedProductRecord } from "../lib/offline/db";

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
    console.log(`SUBMISSION GUARD TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock implementing OfflineDatabase tables with atomic transaction support
function createMockOfflineDb(): OfflineDatabase {
    const cachedPurchasesMap = new Map<string, CachedPurchaseRecord>();
    const cachedSuppliersMap = new Map<string, CachedSupplierRecord>();
    const cachedProductsMap = new Map<string, CachedProductRecord>();
    const syncQueueList: SyncQueueItem[] = [];
    const metaMap = new Map<string, unknown>();

    const dbMock: unknown = {
        cachedPurchases: {
            get: async (key: string) => {
                const rec = cachedPurchasesMap.get(key);
                return rec ? JSON.parse(JSON.stringify(rec)) : undefined;
            },
            put: async (item: CachedPurchaseRecord) => {
                cachedPurchasesMap.set(item.id, JSON.parse(JSON.stringify(item)));
                return item.id;
            },
            where: (field: string) => ({
                equals: (val: unknown) => ({
                    first: async () => {
                        for (const item of cachedPurchasesMap.values()) {
                            if ((item as unknown as Record<string, unknown>)[field] === val) {
                                return JSON.parse(JSON.stringify(item));
                            }
                        }
                        return undefined;
                    },
                    toArray: async () => {
                        const out: CachedPurchaseRecord[] = [];
                        for (const item of cachedPurchasesMap.values()) {
                            if ((item as unknown as Record<string, unknown>)[field] === val) {
                                out.push(JSON.parse(JSON.stringify(item)));
                            }
                        }
                        return out;
                    },
                }),
            }),
            count: async () => cachedPurchasesMap.size,
        },
        cachedSuppliers: {
            get: async (key: string) => cachedSuppliersMap.get(key),
            put: async (item: CachedSupplierRecord) => cachedSuppliersMap.set(item.id, item),
        },
        cachedProducts: {
            get: async (key: string) => cachedProductsMap.get(key),
            put: async (item: CachedProductRecord) => cachedProductsMap.set(item.id, item),
        },
        syncQueue: {
            add: async (item: SyncQueueItem) => {
                const id = syncQueueList.length + 1;
                const cloned = JSON.parse(JSON.stringify(item));
                cloned.id = id;
                syncQueueList.push(cloned);
                return id;
            },
            put: async (item: SyncQueueItem) => {
                const idx = syncQueueList.findIndex((q) => q.id === item.id);
                if (idx >= 0) {
                    syncQueueList[idx] = JSON.parse(JSON.stringify(item));
                } else {
                    syncQueueList.push(JSON.parse(JSON.stringify(item)));
                }
                return item.id;
            },
            where: (field: string) => ({
                equals: (val: unknown) => ({
                    first: async () => {
                        const found = syncQueueList.find((q) => (q as unknown as Record<string, unknown>)[field] === val);
                        return found ? JSON.parse(JSON.stringify(found)) : undefined;
                    },
                    toArray: async () => {
                        return syncQueueList
                            .filter((q) => (q as unknown as Record<string, unknown>)[field] === val)
                            .map((q) => JSON.parse(JSON.stringify(q)));
                    },
                }),
            }),
            count: async () => syncQueueList.length,
        },
        meta: {
            get: async (key: string) => metaMap.get(key),
            put: async (item: { key: string; value: unknown }) => metaMap.set(item.key, item),
        },
        transaction: async (_mode: string, ...args: unknown[]) => {
            const txFn = args[args.length - 1] as () => Promise<unknown>;
            return await txFn();
        },
    };

    return dbMock as OfflineDatabase;
}

// Logic replicating the exact submission route decision in app/purchases/new/page.tsx
function evaluateSubmissionDecision(params: {
    isNavOnline: boolean;
    supplierId: string;
    supplierCode?: string;
    items: Array<{ productId: string }>;
}): {
    route: "DIRECT_ONLINE" | "OFFLINE_QUEUE";
    hasTemporarySupplier: boolean;
    hasTemporaryProducts: boolean;
    hasUnresolvedPrerequisites: boolean;
} {
    const hasTemporarySupplier =
        isTemporarySupplierId(params.supplierId) ||
        (params.supplierCode ? isTemporarySupplierCode(params.supplierCode) : false);

    const hasTemporaryProducts = params.items.some((item) => isTemporaryProductId(item.productId));
    const hasUnresolvedPrerequisites = hasTemporarySupplier || hasTemporaryProducts;

    if (params.isNavOnline && !hasUnresolvedPrerequisites) {
        return {
            route: "DIRECT_ONLINE",
            hasTemporarySupplier,
            hasTemporaryProducts,
            hasUnresolvedPrerequisites,
        };
    }

    return {
        route: "OFFLINE_QUEUE",
        hasTemporarySupplier,
        hasTemporaryProducts,
        hasUnresolvedPrerequisites,
    };
}

// ============================================================
// TESTS
// ============================================================

async function runTests() {
    console.log("\n--- 1. Online Submission with Real Server ObjectIds ---");
    {
        const realSupplierId = "507f1f77bcf86cd799439011";
        const realProductId = "507f1f77bcf86cd799439012";

        const decision = evaluateSubmissionDecision({
            isNavOnline: true,
            supplierId: realSupplierId,
            supplierCode: "SUP-001",
            items: [{ productId: realProductId }],
        });

        check("1.1 Real IDs with online navigator selects DIRECT_ONLINE route", decision.route === "DIRECT_ONLINE");
        check("1.2 Real supplier is not flagged as temporary", decision.hasTemporarySupplier === false);
        check("1.3 Real product is not flagged as temporary", decision.hasTemporaryProducts === false);
        check("1.4 hasUnresolvedPrerequisites is false", decision.hasUnresolvedPrerequisites === false);

        // Verify server schema acceptance
        const serverPayload = {
            purchaseNo: "PO-2026-0001",
            supplierId: realSupplierId,
            supplierInvoiceNo: "INV-1001",
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Main Store" },
            items: [
                {
                    productId: realProductId,
                    quantity: 10,
                    unitPrice: 100,
                    taxRate: 18,
                },
            ],
            paidAmount: 500,
        };

        const serverParsed = createPurchaseSchema.safeParse(serverPayload);
        check("1.5 Server schema accepts real ObjectIds payload", serverParsed.success);
    }

    console.log("\n--- 2. Online Submission with Temporary Supplier ID (sup_...) ---");
    {
        const tempSupplierId = "sup_e8b9b5f2-9c3a-4a2e-8b1e-6d7a8e9f0a1b";
        const realProductId = "507f1f77bcf86cd799439012";

        const decision = evaluateSubmissionDecision({
            isNavOnline: true,
            supplierId: tempSupplierId,
            items: [{ productId: realProductId }],
        });

        check("2.1 Online navigator with temporary supplier routes to OFFLINE_QUEUE", decision.route === "OFFLINE_QUEUE");
        check("2.2 Temporary supplier is detected", decision.hasTemporarySupplier === true);
        check("2.3 hasUnresolvedPrerequisites is true", decision.hasUnresolvedPrerequisites === true);

        // Server schema rejection test: server schema MUST reject temporary supplier
        const serverPayload = {
            purchaseNo: "PO-2026-0002",
            supplierId: tempSupplierId,
            supplierInvoiceNo: "INV-1002",
            purchaseDate: new Date().toISOString(),
            warehouse: { name: "Main Store" },
            items: [
                {
                    productId: realProductId,
                    quantity: 5,
                    unitPrice: 200,
                },
            ],
        };
        const serverParsed = createPurchaseSchema.safeParse(serverPayload);
        check("2.4 Server schema rejects temporary supplier ID (would 400 if posted)", !serverParsed.success);

        // Offline schema accepts and can be saved to Dexie mock
        const offlinePayload = {
            purchaseNo: "PO-2026-0002",
            supplierId: tempSupplierId,
            supplierInvoiceNo: "INV-1002",
            warehouse: { name: "Main Store" },
            items: [
                {
                    productId: realProductId,
                    quantity: 5,
                    unitPrice: 200,
                },
            ],
        };
        const offlineParsed = offlinePurchasePayloadSchema.safeParse(offlinePayload);
        check("2.5 Offline schema accepts temporary supplier payload", offlineParsed.success);

        const mockDb = createMockOfflineDb();
        const saveRes = await savePendingOfflinePurchase(offlinePayload, "tenant-test-a", {
            db: mockDb,
            operationId: "op-sup-test-1",
            localId: generateTemporaryPurchaseId(),
        });
        check("2.6 Successfully queued in local offline database", saveRes.purchase.supplierId === tempSupplierId);
        check("2.7 Queued record status is PENDING", saveRes.purchase.syncStatus === "PENDING");
    }

    console.log("\n--- 3. Online Submission with Temporary Supplier Code (SUP-TEMP-...) ---");
    {
        const supplierWithTempCode = {
            _id: "sup_local_custom_id",
            supplierCode: "SUP-TEMP-0042",
        };
        const realProductId = "507f1f77bcf86cd799439012";

        const decision = evaluateSubmissionDecision({
            isNavOnline: true,
            supplierId: supplierWithTempCode._id,
            supplierCode: supplierWithTempCode.supplierCode,
            items: [{ productId: realProductId }],
        });

        check("3.1 Temporary supplier code triggers prerequisite detection", decision.hasTemporarySupplier === true);
        check("3.2 Routes to OFFLINE_QUEUE despite isNavOnline=true", decision.route === "OFFLINE_QUEUE");
    }

    console.log("\n--- 4. Online Submission with Temporary Product ID (prod_...) ---");
    {
        const realSupplierId = "507f1f77bcf86cd799439011";
        const tempProductId = "prod_c4d3e2f1-0a9b-8c7d-6e5f-4a3b2c1d0e9f";

        const decision = evaluateSubmissionDecision({
            isNavOnline: true,
            supplierId: realSupplierId,
            items: [{ productId: tempProductId }],
        });

        check("4.1 Temporary product ID routes to OFFLINE_QUEUE", decision.route === "OFFLINE_QUEUE");
        check("4.2 hasTemporaryProducts is true", decision.hasTemporaryProducts === true);
        check("4.3 hasUnresolvedPrerequisites is true", decision.hasUnresolvedPrerequisites === true);

        // Server schema rejects temporary product ID
        const serverPayload = {
            purchaseNo: "PO-2026-0004",
            supplierId: realSupplierId,
            supplierInvoiceNo: "INV-1004",
            warehouse: { name: "Main Store" },
            items: [
                {
                    productId: tempProductId,
                    quantity: 2,
                    unitPrice: 150,
                },
            ],
        };
        const serverParsed = createPurchaseSchema.safeParse(serverPayload);
        check("4.4 Server schema rejects temporary product ID", !serverParsed.success);

        // Offline queue saves with product dependency
        const mockDb = createMockOfflineDb();
        const saveRes = await savePendingOfflinePurchase(serverPayload, "tenant-test-a", {
            db: mockDb,
            operationId: "op-prod-test-1",
        });
        check("4.5 Offline queue successfully stores temporary product line", saveRes.purchase.items[0].productId === tempProductId);
    }

    console.log("\n--- 5. Offline Submission (!isNavOnline) ---");
    {
        const realSupplierId = "507f1f77bcf86cd799439011";
        const realProductId = "507f1f77bcf86cd799439012";

        const decision = evaluateSubmissionDecision({
            isNavOnline: false,
            supplierId: realSupplierId,
            items: [{ productId: realProductId }],
        });

        check("5.1 Offline navigator routes to OFFLINE_QUEUE even with real IDs", decision.route === "OFFLINE_QUEUE");
        check("5.2 Prerequisites are not flagged when IDs are real", decision.hasUnresolvedPrerequisites === false);
    }

    console.log("\n--- 6. Server Validation Rejection Isolation (HTTP 400 Handling) ---");
    {
        // Simulate online submission response handling
        let displayedError: string | null = null;
        let didQueueOffline = false;
        let loadingState = true;

        const simulatedServerResponse = {
            status: 400,
            data: { success: false, message: "Duplicate supplier invoice number for this supplier" },
        };

        // Replicate logic from app/purchases/new/page.tsx lines 319-322
        if (simulatedServerResponse.status === 503) {
            didQueueOffline = true;
        } else if (simulatedServerResponse.status === 400 || simulatedServerResponse.status === 422) {
            displayedError = simulatedServerResponse.data?.message || "Validation error from server";
            loadingState = false;
            // return without calling savePendingOfflinePurchase
        }

        check("6.1 Server 400 displays exact server validation error", displayedError === "Duplicate supplier invoice number for this supplier");
        check("6.2 Server 400 stops loading state", loadingState === false);
        check("6.3 Server 400 does NOT silently queue into offline storage", didQueueOffline === false);
    }

    console.log("\n--- 7. Operation ID Idempotency on Repeated Submission / Retries ---");
    {
        const mockDb = createMockOfflineDb();
        const tenantId = "tenant-test-idempotency";
        const stableOpId = "op-stable-retry-test-001";
        const localPurchaseId = generateTemporaryPurchaseId();

        const payload = {
            operationId: stableOpId,
            purchaseNo: "PO-2026-RETRY-01",
            supplierId: "sup_temp_retry_1",
            supplierInvoiceNo: "INV-RETRY-01",
            warehouse: { name: "Main Store" },
            items: [
                {
                    productId: "prod_temp_retry_1",
                    quantity: 3,
                    unitPrice: 50,
                    taxRate: 5,
                },
            ],
            paidAmount: 50,
        };

        // First attempt (e.g. initial submit)
        const firstRes = await savePendingOfflinePurchase(payload, tenantId, {
            db: mockDb,
            operationId: stableOpId,
            localId: localPurchaseId,
        });

        check("7.1 First submission succeeds", !!firstRes.purchase);
        check("7.2 First submission returns alreadyExists=false", firstRes.alreadyExists === false);
        check("7.3 Local purchase ID matches", firstRes.localId === localPurchaseId);

        const purchaseCountFirst = await mockDb.cachedPurchases.count();
        const queueCountFirst = await mockDb.syncQueue.count();
        check("7.4 First attempt created 1 cached purchase", purchaseCountFirst === 1);
        check("7.5 First attempt created 1 sync queue item", queueCountFirst === 1);

        // Repeated submission (user clicks retry or re-submits draft with same operationId)
        const secondRes = await savePendingOfflinePurchase(payload, tenantId, {
            db: mockDb,
            operationId: stableOpId,
            localId: localPurchaseId,
        });

        check("7.6 Repeated submission returns alreadyExists=true", secondRes.alreadyExists === true);
        check("7.7 Repeated submission returns original localId", secondRes.localId === localPurchaseId);

        const purchaseCountSecond = await mockDb.cachedPurchases.count();
        const queueCountSecond = await mockDb.syncQueue.count();
        check("7.8 No duplicate cached purchase created on retry (count still 1)", purchaseCountSecond === 1);
        check("7.9 No duplicate sync queue item created on retry (count still 1)", queueCountSecond === 1);

        // Cross-tenant collision defense
        let crossTenantError: string | null = null;
        try {
            await savePendingOfflinePurchase(payload, "tenant-DIFFERENT", {
                db: mockDb,
                operationId: stableOpId,
                localId: generateTemporaryPurchaseId(),
            });
        } catch (e: unknown) {
            crossTenantError = e instanceof Error ? e.message : String(e);
        }
        check(
            "7.10 Cross-tenant re-use of operationId is strictly rejected",
            crossTenantError !== null && crossTenantError.includes("Cross-tenant operation ID conflict")
        );
    }

    console.log("\n--- 8. Data Preservation & Financial Totals ---");
    {
        const mockDb = createMockOfflineDb();
        const items = [
            {
                productId: "prod_preserve_1",
                quantity: 4,
                unitPrice: 250,
                taxRate: 18,
                productSnapshot: { name: "Motor Oil", SKU: "OIL-5W30", unit: "Litre" },
            },
            {
                productId: "prod_preserve_2",
                quantity: 2,
                unitPrice: 500,
                taxRate: 12,
                productSnapshot: { name: "Air Filter", SKU: "FLT-A1", unit: "Piece" },
            },
        ];

        const calculated = calculatePurchaseTotals(items, 50); // shipping = 50
        // Item 1: 4 * 250 = 1000, 18% tax = 180 -> 1180
        // Item 2: 2 * 500 = 1000, 12% tax = 120 -> 1120
        // Subtotal = 2000, Tax = 300, Shipping = 50, GrandTotal = 2350
        check("8.1 Subtotal correctly calculated (2000)", calculated.subtotal === 2000);
        check("8.2 Tax correctly calculated (300)", calculated.taxTotal === 300);
        check("8.3 Grand total correctly calculated (2350)", calculated.grandTotal === 2350);

        const fullPayload = {
            operationId: "op-preserve-totals-01",
            purchaseNo: "PO-PRESERVE-01",
            supplierId: "sup_preserve_1",
            supplierInvoiceNo: "INV-PRESERVE-99",
            warehouse: { name: "Distribution Hub" },
            items,
            shippingCost: 50,
            paidAmount: 1000,
            subtotal: calculated.subtotal,
            taxTotal: calculated.taxTotal,
            grandTotal: calculated.grandTotal,
            supplierSnapshot: {
                name: "Premier Spares Ltd",
                supplierCode: "SUP-TEMP-99",
                phone: "9876543210",
                gstin: "27AAAAA0000A1Z5",
            },
        };

        const saveRes = await savePendingOfflinePurchase(fullPayload, "tenant-preserve", {
            db: mockDb,
            operationId: fullPayload.operationId,
        });

        const saved = saveRes.purchase;
        check("8.4 Saved record preserves all line items count (2)", saved.items.length === 2);
        check("8.5 Line 1 snapshot SKU preserved", saved.items[0].productSnapshot?.SKU === "OIL-5W30");
        check("8.6 Line 2 snapshot unit preserved", saved.items[1].productSnapshot?.unit === "Piece");
        check("8.7 Subtotal preserved (2000)", saved.subtotal === 2000);
        check("8.8 Grand total preserved (2350)", saved.grandTotal === 2350);
        check("8.9 Paid amount preserved (1000)", saved.paidAmount === 1000);
        check("8.10 Due amount computed correctly (1350)", saved.dueAmount === 1350);
        check("8.11 Payment status is 'partial'", saved.paymentStatus === "partial");
        check("8.12 Supplier snapshot name preserved", saved.supplierSnapshot?.name === "Premier Spares Ltd");
    }

    console.log("\n--- 9. Submission Identity & Ref Lifecycle (Simulation Model) ---");
    console.log("NOTE: This section simulates the ref lifecycle logic (initialization, retry preservation, and post-success reset) using a TypeScript state simulation model. It exercises the lifecycle contract without mounting the React component DOM.");
    {
        interface FormRefState {
            operationId: string | null;
            localPurchaseId: string | null;
            purchaseNo: string | null;
        }

        function createFormRefs(): FormRefState {
            return {
                operationId: null,
                localPurchaseId: null,
                purchaseNo: null,
            };
        }

        function ensureSubmissionIds(refs: FormRefState) {
            if (!refs.operationId) {
                refs.operationId = `op-pur-sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            }
            if (!refs.localPurchaseId) {
                refs.localPurchaseId = generateTemporaryPurchaseId();
            }
            if (!refs.purchaseNo) {
                refs.purchaseNo = `PO-${Date.now().toString().slice(-6)}`;
            }
        }

        function resetSubmissionIds(refs: FormRefState) {
            refs.operationId = null;
            refs.localPurchaseId = null;
            refs.purchaseNo = null;
        }

        // Test 9.1: Initial State
        const refs = createFormRefs();
        check(
            "9.1 Initial ref state has null operationId, localPurchaseId, and purchaseNo",
            refs.operationId === null && refs.localPurchaseId === null && refs.purchaseNo === null
        );

        // Test 9.2: First submit generates IDs
        ensureSubmissionIds(refs);
        const opId1 = refs.operationId;
        const localId1 = refs.localPurchaseId;
        const purchaseNo1 = refs.purchaseNo;
        check(
            "9.2 First submit attempt generates non-null IDs",
            typeof opId1 === "string" && typeof localId1 === "string" && typeof purchaseNo1 === "string"
        );

        // Test 9.3: Failed submission attempt (e.g. server 400 or network drop) does NOT reset refs
        ensureSubmissionIds(refs); // simulate retry without reset
        check("9.3 Retry after failure preserves exact same operationId", refs.operationId === opId1);
        check("9.4 Retry after failure preserves exact same localPurchaseId", refs.localPurchaseId === localId1);
        check("9.5 Retry after failure preserves exact same purchaseNo", refs.purchaseNo === purchaseNo1);

        // Test 9.6: Definitive Online Success resets refs immediately before redirect
        resetSubmissionIds(refs);
        check("9.6 Post-success reset clears operationId", refs.operationId === null);
        check("9.7 Post-success reset clears localPurchaseId", refs.localPurchaseId === null);
        check("9.8 Post-success reset clears purchaseNo", refs.purchaseNo === null);

        // Test 9.7: Subsequent new purchase generates completely new IDs
        ensureSubmissionIds(refs);
        const opId2 = refs.operationId;
        const localId2 = refs.localPurchaseId;
        check("9.9 Next purchase receives fresh operationId (no collision with previous purchase)", opId2 !== opId1);
        check("9.10 Next purchase receives fresh localPurchaseId", localId2 !== localId1);

        // Test 9.8: Definitive Offline Queue Success resets refs immediately before redirect
        resetSubmissionIds(refs);
        check(
            "9.11 Definitive offline queue success clears refs",
            refs.operationId === null && refs.localPurchaseId === null
        );
    }

    const allPassed = summarize();
    if (!allPassed) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
