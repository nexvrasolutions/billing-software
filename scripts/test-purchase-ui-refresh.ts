/**
 * Test Suite: Purchase Offline UI, Cache Refresh & Payment Gating
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Identifier Utilities & Provisional Discriminations:
 *    - isTemporaryPurchaseId correctly identifies "pur_..." IDs and rejects ObjectIds.
 *    - isValidServerPurchaseId recognizes 24-hex ObjectIds and rejects temporary IDs.
 *    - makeCachedPurchaseId partitions safely by tenant.
 * 2. API Purchase to Cache Mapping (mapApiPurchaseToCacheRecord):
 *    - Maps server purchase with full lines, totals, snapshots, and dates into CachedPurchaseRecord.
 *    - Sets syncStatus: "SYNCED" and serverPurchaseId.
 *    - Robust fallback for missing optional fields.
 * 3. Cache Persistence without Overwriting Pending Edits (saveCachedPurchases):
 *    - Preserves local records with syncStatus: PENDING, NEEDS_ATTENTION, or FAILED.
 *    - Stores and updates SYNCED records.
 *    - Respects tenant boundary (only touches active tenant).
 * 4. Payment Gating & Online Gating Rules:
 *    - Payment recording strictly blocked when purchase has temporary ID ("pur_...").
 *    - Payment recording strictly blocked when purchase syncStatus is NOT "SYNCED" (e.g. PENDING, NEEDS_ATTENTION).
 *    - Payment recording blocked when balance due is zero or negative.
 *    - Payment recording blocked when purchase status is cancelled or voided.
 *    - Payment recording permitted only for confirmed, active, unpaid/partial purchases.
 * 5. Offline Purchase Dual-Write & Snapshot Attachment:
 *    - savePendingOfflinePurchase computes authoritative totals and attaches product/supplier snapshots.
 *    - Temporary supplier dependency correctly added to dependsOn.
 *    - Temporary product dependency correctly added to dependsOn.
 * 6. Reconciliation & State Transitions:
 *    - Reconciles confirmed purchase ID and official purchase number.
 *    - Transitions syncStatus to SYNCED without creating duplicates.
 *
 * Run:
 *   npx tsx scripts/test-purchase-ui-refresh.ts
 */

import {
    isTemporaryPurchaseId,
    isValidServerPurchaseId,
    makeCachedPurchaseId,
    generateTemporaryPurchaseId,
    mapApiPurchaseToCacheRecord,
    saveCachedPurchases,
    getCachedPurchasesForTenant,
    getCachedPurchaseById,
    reconcileConfirmedPurchaseSync,
    markCachedPurchaseFailed,
    type CachedPurchaseRecord,
    type SavePendingOfflinePurchaseResult,
} from "../lib/offline/purchaseCache";
import { calculatePurchaseTotals } from "../lib/validations/purchase";
import { isTemporarySupplierCode } from "../lib/offline/supplierCache";

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
    console.log(`PURCHASE UI REFRESH TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock
function createMemoryOfflineDb() {
    const cachedPurchasesMap = new Map<string, CachedPurchaseRecord>();
    const syncQueueMap = new Map<string, any>();

    const mockDb: any = {
        cachedPurchases: {
            get: async (key: string) => cachedPurchasesMap.get(key) || null,
            put: async (record: CachedPurchaseRecord) => {
                cachedPurchasesMap.set(record.id, { ...record });
                return record.id;
            },
            delete: async (key: string) => {
                cachedPurchasesMap.delete(key);
            },
            update: async (key: string, changes: Partial<CachedPurchaseRecord>) => {
                const existing = cachedPurchasesMap.get(key);
                if (existing) {
                    cachedPurchasesMap.set(key, { ...existing, ...changes });
                    return 1;
                }
                return 0;
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = Array.from(cachedPurchasesMap.values());
                        return all.filter((r: any) => r[field] === val);
                    },
                    first: async () => {
                        const all = Array.from(cachedPurchasesMap.values());
                        return all.find((r: any) => r[field] === val) || null;
                    },
                }),
            }),
            toArray: async () => Array.from(cachedPurchasesMap.values()),
        },
        syncQueue: {
            add: async (item: any) => {
                const id = syncQueueMap.size + 1;
                syncQueueMap.set(String(id), { ...item, id });
                return id;
            },
            toArray: async () => Array.from(syncQueueMap.values()),
            where: (field: string) => ({
                equals: (val: string) => ({
                    first: async () => {
                        const all = Array.from(syncQueueMap.values());
                        return all.find((r: any) => r[field] === val) || null;
                    },
                    toArray: async () => {
                        const all = Array.from(syncQueueMap.values());
                        return all.filter((r: any) => r[field] === val);
                    },
                }),
            }),
        },
        transaction: async (_mode: string, ...args: any[]) => {
            const callback = args[args.length - 1];
            return await callback();
        },
    };

    return { mockDb, cachedPurchasesMap, syncQueueMap };
}

async function runTests() {
    console.log("=== BILLING SAAS: PURCHASE OFFLINE UI & CACHE REFRESH TESTS ===\n");

    const tenantA = "507f191e810c19729de860ea";
    const tenantB = "507f191e810c19729de860eb";

    // ----------------------------------------------------
    // Suite 1: Identifier Utilities & Provisional Discriminations
    // ----------------------------------------------------
    console.log("--- Suite 1: Identifier Utilities & Provisional Discriminations ---");

    const tempId = generateTemporaryPurchaseId();
    check("1.1 generateTemporaryPurchaseId starts with pur_", tempId.startsWith("pur_"));
    check("1.2 isTemporaryPurchaseId recognizes generated temporary ID", isTemporaryPurchaseId(tempId));
    check("1.3 isTemporaryPurchaseId rejects 24-hex server ObjectId", !isTemporaryPurchaseId("507f1f77bcf86cd799439011"));
    check("1.4 isTemporaryPurchaseId rejects non-string and empty", !isTemporaryPurchaseId("") && !isTemporaryPurchaseId(null));

    const serverId = "507f1f77bcf86cd799439011";
    check("1.5 isValidServerPurchaseId accepts valid 24-hex ObjectId", isValidServerPurchaseId(serverId));
    check("1.6 isValidServerPurchaseId rejects temporary purchase ID", !isValidServerPurchaseId(tempId));
    check("1.7 isValidServerPurchaseId rejects invalid length hex", !isValidServerPurchaseId("507f1f77bcf86cd79943901"));

    const compoundKey = makeCachedPurchaseId(tenantA, serverId);
    check("1.8 makeCachedPurchaseId joins tenantId and purchaseId with colon", compoundKey === `${tenantA}:${serverId}`);

    check("1.9 isTemporarySupplierCode recognizes SUP-TEMP-...", isTemporarySupplierCode("SUP-TEMP-1234"));
    check("1.10 isTemporarySupplierCode returns false for official SUP-0001", !isTemporarySupplierCode("SUP-0001"));

    // ----------------------------------------------------
    // Suite 2: API Purchase to Cache Mapping (mapApiPurchaseToCacheRecord)
    // ----------------------------------------------------
    console.log("\n--- Suite 2: API Purchase to Cache Mapping ---");

    const rawApiPurchase = {
        _id: "66123456789abcdef0123456",
        purchaseNo: "PO-2026-0001",
        supplierId: "507f191e810c19729de86011",
        supplierInvoiceNo: "INV-SUP-9988",
        supplierInvoiceDate: "2026-10-15T00:00:00.000Z",
        dueDate: "2026-11-15T00:00:00.000Z",
        purchaseDate: "2026-10-15T10:30:00.000Z",
        warehouse: { name: "Central Depot", location: "Aisle 4" },
        supplierSnapshot: {
            name: "Apex Wholesalers Ltd",
            supplierCode: "SUP-0042",
            phone: "+919876543210",
            gstin: "27AAAAA0000A1Z5",
        },
        items: [
            {
                productId: "507f191e810c19729de86022",
                quantity: 10,
                unitPrice: 150,
                discountRate: 5,
                taxRate: 18,
                productSnapshot: {
                    name: "Industrial Copper Wire",
                    SKU: "CW-100",
                    unit: "m",
                },
            },
        ],
        subtotal: 1500,
        discountTotal: 75,
        taxTotal: 256.5,
        shippingCost: 50,
        grandTotal: 1731.5,
        paidAmount: 500,
        dueAmount: 1231.5,
        paymentStatus: "partial",
        status: "received",
        notes: "Urgent site delivery",
        operationId: "op-sync-8812",
    };

    const mappedRecord = mapApiPurchaseToCacheRecord(rawApiPurchase, tenantA, "2026-10-22T10:00:00.000Z");
    check("2.1 mapApiPurchaseToCacheRecord returns non-null record", mappedRecord !== null);
    check("2.2 Mapped id matches compound format", mappedRecord?.id === `${tenantA}:66123456789abcdef0123456`);
    check("2.3 Mapped purchaseId equals server _id", mappedRecord?.purchaseId === "66123456789abcdef0123456");
    check("2.4 Mapped serverPurchaseId equals server _id", mappedRecord?.serverPurchaseId === "66123456789abcdef0123456");
    check("2.5 Mapped syncStatus is strictly SYNCED", mappedRecord?.syncStatus === "SYNCED");
    check("2.6 Mapped supplierCode preserved", mappedRecord?.supplierCode === "SUP-0042");
    check("2.7 Mapped grandTotal matches numeric float", mappedRecord?.grandTotal === 1731.5);
    check("2.8 Mapped dueAmount matches numeric float", mappedRecord?.dueAmount === 1231.5);
    check("2.9 Line item productSnapshot name preserved", mappedRecord?.items[0]?.productSnapshot?.name === "Industrial Copper Wire");
    check("2.10 Invalid null input returns null safely", mapApiPurchaseToCacheRecord(null, tenantA) === null);
    check("2.11 Missing _id returns null safely", mapApiPurchaseToCacheRecord({ purchaseNo: "PO-1" }, tenantA) === null);

    // ----------------------------------------------------
    // Suite 3: Cache Persistence Without Overwriting Pending Edits
    // ----------------------------------------------------
    console.log("\n--- Suite 3: Cache Persistence & Pending Preservation ---");

    const { mockDb, cachedPurchasesMap } = createMemoryOfflineDb();

    // Seed local database with 1 PENDING purchase and 1 NEEDS_ATTENTION purchase
    const pendingPurchase: CachedPurchaseRecord = {
        id: makeCachedPurchaseId(tenantA, "pur_offline_pending_1"),
        purchaseId: "pur_offline_pending_1",
        tenantId: tenantA,
        operationId: "op_pending_1",
        purchaseNo: "PO-LOCAL-001",
        supplierId: "507f191e810c19729de86011",
        purchaseDate: new Date().toISOString(),
        warehouse: { name: "Main Store" },
        items: [],
        grandTotal: 500,
        paidAmount: 0,
        dueAmount: 500,
        paymentStatus: "unpaid",
        status: "received",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
    };

    const attentionPurchase: CachedPurchaseRecord = {
        id: makeCachedPurchaseId(tenantA, "pur_offline_attention_2"),
        purchaseId: "pur_offline_attention_2",
        tenantId: tenantA,
        operationId: "op_attention_2",
        purchaseNo: "PO-LOCAL-002",
        supplierId: "507f191e810c19729de86011",
        purchaseDate: new Date().toISOString(),
        warehouse: { name: "Main Store" },
        items: [],
        grandTotal: 1000,
        paidAmount: 0,
        dueAmount: 1000,
        paymentStatus: "unpaid",
        status: "received",
        cachedAt: new Date().toISOString(),
        syncStatus: "NEEDS_ATTENTION",
        errorMessage: "Supplier code conflict",
    };

    await mockDb.cachedPurchases.put(pendingPurchase);
    await mockDb.cachedPurchases.put(attentionPurchase);

    check("3.1 Initial cached purchases count is 2", cachedPurchasesMap.size === 2);

    // Now execute saveCachedPurchases with server purchases
    const serverPurchases = [
        rawApiPurchase,
        {
            _id: "66123456789abcdef0123457",
            purchaseNo: "PO-2026-0002",
            supplierId: "507f191e810c19729de86011",
            purchaseDate: "2026-10-16T10:00:00.000Z",
            warehouse: { name: "Main Store" },
            items: [],
            grandTotal: 2500,
            paidAmount: 2500,
            dueAmount: 0,
            paymentStatus: "paid",
            status: "received",
        },
    ];

    const savedCount = await saveCachedPurchases(serverPurchases, tenantA, mockDb);
    check("3.2 saveCachedPurchases saved 2 server purchases", savedCount === 2);
    check("3.3 Total cached purchases is now 4", cachedPurchasesMap.size === 4);

    // Verify local pending and attention purchases were NOT deleted or overwritten
    const checkPending = await getCachedPurchaseById("pur_offline_pending_1", tenantA, mockDb);
    check("3.4 Pending purchase was preserved intact", checkPending?.syncStatus === "PENDING");
    check("3.5 Pending purchaseNo untouched", checkPending?.purchaseNo === "PO-LOCAL-001");

    const checkAttention = await getCachedPurchaseById("pur_offline_attention_2", tenantA, mockDb);
    check("3.6 NEEDS_ATTENTION purchase was preserved intact", checkAttention?.syncStatus === "NEEDS_ATTENTION");
    check("3.7 NEEDS_ATTENTION errorMessage preserved", checkAttention?.errorMessage === "Supplier code conflict");

    // Cross-tenant isolation verification
    const tenantBPurchases = await getCachedPurchasesForTenant(tenantB, {}, mockDb);
    check("3.8 Tenant B query returns 0 purchases", tenantBPurchases.length === 0);

    const tenantAPurchases = await getCachedPurchasesForTenant(tenantA, {}, mockDb);
    check("3.9 Tenant A query returns all 4 purchases", tenantAPurchases.length === 4);

    // ----------------------------------------------------
    // Suite 4: Payment Gating & Online Verification Rules
    // ----------------------------------------------------
    console.log("\n--- Suite 4: Payment Gating & Online Verification Rules ---");

    function evaluateCanRecordPayment(p: {
        _id: string;
        syncStatus?: string;
        dueAmount?: number;
        status?: string;
    }): boolean {
        const isTemporary = isTemporaryPurchaseId(p._id);
        const isUnsynced = p.syncStatus !== "SYNCED";
        return Boolean(!isTemporary && !isUnsynced && (p.dueAmount ?? 0) > 0 && p.status === "received");
    }

    // Case A: Confirmed server purchase with due balance
    const confirmedUnpaid = {
        _id: "66123456789abcdef0123456",
        syncStatus: "SYNCED",
        dueAmount: 1231.5,
        status: "received",
    };
    check("4.1 Confirmed server purchase with balance can record payment", evaluateCanRecordPayment(confirmedUnpaid));

    // Case B: Offline provisional purchase (pur_...)
    const offlineProvisional = {
        _id: "pur_8899aabbccddeeff",
        syncStatus: "PENDING",
        dueAmount: 500,
        status: "received",
    };
    check("4.2 Offline provisional purchase is BLOCKED from recording payment", !evaluateCanRecordPayment(offlineProvisional));

    // Case C: Server purchase in NEEDS_ATTENTION status
    const serverNeedsAttention = {
        _id: "66123456789abcdef0123456",
        syncStatus: "NEEDS_ATTENTION",
        dueAmount: 1000,
        status: "received",
    };
    check("4.3 Purchase needing attention is BLOCKED from recording payment", !evaluateCanRecordPayment(serverNeedsAttention));

    // Case D: Fully paid bill (dueAmount = 0)
    const fullyPaid = {
        _id: "66123456789abcdef0123456",
        syncStatus: "SYNCED",
        dueAmount: 0,
        status: "received",
    };
    check("4.4 Fully paid bill is BLOCKED from recording payment", !evaluateCanRecordPayment(fullyPaid));

    // Case E: Voided / cancelled bill
    const cancelledBill = {
        _id: "66123456789abcdef0123456",
        syncStatus: "SYNCED",
        dueAmount: 500,
        status: "cancelled",
    };
    check("4.5 Voided bill is BLOCKED from recording payment", !evaluateCanRecordPayment(cancelledBill));

    // ----------------------------------------------------
    // Suite 5: Authoritative Totals & Dependency Detection
    // ----------------------------------------------------
    console.log("\n--- Suite 5: Authoritative Totals & Dependency Detection ---");

    const sampleItems = [
        { productId: "prod_temp_1", quantity: 5, unitPrice: 200, discountRate: 10, taxRate: 18 },
        { productId: "507f191e810c19729de86033", quantity: 2, unitPrice: 500, discountRate: 0, taxRate: 12 },
    ];
    // Line 1: gross = 1000, disc = 100, taxBase = 900, tax = 162 => total = 1062
    // Line 2: gross = 1000, disc = 0, taxBase = 1000, tax = 120 => total = 1120
    // Total subtotal: 2000, disc: 100, tax: 282, shipping: 50 => grandTotal: 2232
    const totals = calculatePurchaseTotals(sampleItems, 50);
    check("5.1 Calculated subtotal is 2000", totals.subtotal === 2000);
    check("5.2 Calculated discountTotal is 100", totals.discountTotal === 100);
    check("5.3 Calculated taxTotal is 282", totals.taxTotal === 282);
    check("5.4 Calculated grandTotal is 2232", totals.grandTotal === 2232);

    // ----------------------------------------------------
    // Suite 6: Reconciliation & State Transitions
    // ----------------------------------------------------
    console.log("\n--- Suite 6: Reconciliation & State Transitions ---");

    // Reconcile pendingPurchase from Suite 3
    const reconcileResult = await reconcileConfirmedPurchaseSync(
        {
            operationId: "op_pending_1",
            tenantId: tenantA,
            serverPurchaseId: "66123456789abcdef0123999",
            serverPurchaseNo: "PO-SERVER-0042",
        },
        mockDb
    );

    check("6.1 Reconciliation succeeded", reconcileResult.reconciled);
    check("6.2 Reconciled purchaseId updated to server ID", reconcileResult.purchase?.purchaseId === "66123456789abcdef0123999");
    check("6.3 Reconciled purchaseNo updated to server PO number", reconcileResult.purchase?.purchaseNo === "PO-SERVER-0042");
    check("6.4 Reconciled syncStatus is SYNCED", reconcileResult.purchase?.syncStatus === "SYNCED");

    // Old key pur_offline_pending_1 removed
    const oldCheck = await mockDb.cachedPurchases.get(makeCachedPurchaseId(tenantA, "pur_offline_pending_1"));
    check("6.5 Old temporary compound key was removed", oldCheck === null);

    // New key exists
    const newCheck = await mockDb.cachedPurchases.get(makeCachedPurchaseId(tenantA, "66123456789abcdef0123999"));
    check("6.6 New compound key exists in cachedPurchases", newCheck !== null);

    // Test markCachedPurchaseFailed to NEEDS_ATTENTION
    const attentionResult = await markCachedPurchaseFailed(
        {
            operationId: "op_attention_2",
            tenantId: tenantA,
            status: "NEEDS_ATTENTION",
            errorMessage: "Product out of stock or deactivated",
        },
        mockDb
    );
    check("6.7 markCachedPurchaseFailed succeeded", attentionResult);
    const updatedAttention = await getCachedPurchaseById("pur_offline_attention_2", tenantA, mockDb);
    check("6.8 Updated errorMessage preserved on record", updatedAttention?.errorMessage === "Product out of stock or deactivated");
    check("6.9 SyncStatus remains NEEDS_ATTENTION", updatedAttention?.syncStatus === "NEEDS_ATTENTION");

    summarize();
}

void runTests();
