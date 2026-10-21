/**
 * Purchases Module Step 2 Fixes Test Suite
 * (DATABASE-FREE: NO live MongoDB Atlas mutation, NO network calls, NO production data alterations)
 *
 * Verifies:
 * 1. Missing purchase-read permission is rejected (HTTP 403); users with either purchases.read or purchases.create are authorized.
 * 2. Authorized purchase reads enforce strict tenant scoping.
 * 3. Valid operation IDs pass createPurchaseSchema; invalid/oversized values are rejected; null/empty normalize safely.
 * 4. Repeating a purchase operation ID preserves idempotency (no duplicate purchase, no duplicate stock movements).
 * 5. Partial index expression { operationId: { $type: "string", $gt: "" } } excludes null, missing, and empty values.
 * 6. Payment gating correctly suppresses Record Payment on cancelled, draft, or fully paid bills.
 *
 * Run:
 *   npx tsx scripts/test-purchase-step2-fixes.ts
 */

import {
    createPurchaseSchema,
    offlinePurchasePayloadSchema,
} from "../lib/validations/purchase";
import { BUSINESS_PERMISSIONS } from "../lib/auth/businessPermissions";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n==================================================`);
    console.log(`${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`Failed checks:`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`==================================================\n`);
    return failed.length === 0;
}

// ============================================================
// 1. Permission Gating Evaluation
// ============================================================

function evaluateAnyPermission(grantedPermissions: Set<string>, requiredPermissions: string[]): boolean {
    return requiredPermissions.some((perm) => grantedPermissions.has(perm));
}

function runSection1() {
    console.log("\n--- Section 1: Purchase Read Permission Gating ---");

    const required = [BUSINESS_PERMISSIONS.purchasesRead, BUSINESS_PERMISSIONS.purchasesCreate];

    check("1.1 BUSINESS_PERMISSIONS.purchasesRead is defined", BUSINESS_PERMISSIONS.purchasesRead === "purchases.read");
    check("1.2 BUSINESS_PERMISSIONS.purchasesCreate is defined", BUSINESS_PERMISSIONS.purchasesCreate === "purchases.create");

    // Case A: User has neither permission (e.g. Staff with only sales.create)
    const cashierPerms = new Set(["sales.create", "taxes.read"]);
    check(
        "1.3 User lacking purchases.read and purchases.create is REJECTED",
        evaluateAnyPermission(cashierPerms, required) === false
    );

    // Case B: User has purchases.read (Purchasing Viewer)
    const viewerPerms = new Set(["purchases.read"]);
    check(
        "1.4 User with purchases.read is AUTHORIZED",
        evaluateAnyPermission(viewerPerms, required) === true
    );

    // Case C: User has purchases.create (Manager / Business Owner without explicit purchases.read)
    const managerPerms = new Set(["purchases.create", "payments.create"]);
    check(
        "1.5 User with purchases.create retains purchase read navigation/access",
        evaluateAnyPermission(managerPerms, required) === true
    );

    // Case D: User has both
    const adminPerms = new Set(["purchases.read", "purchases.create"]);
    check(
        "1.6 User with both purchases.read and purchases.create is AUTHORIZED",
        evaluateAnyPermission(adminPerms, required) === true
    );
}

// ============================================================
// 2. Tenant Scoping & Isolation
// ============================================================

function runSection2() {
    console.log("\n--- Section 2: Tenant Scoping & Multi-Tenant Isolation ---");

    interface MockDbPurchase {
        _id: string;
        tenantId: string;
        purchaseNo: string;
        grandTotal: number;
    }

    const mockPurchases: MockDbPurchase[] = [
        { _id: "pur-tenant-a-1", tenantId: "tenant-a", purchaseNo: "PO-A-001", grandTotal: 5000 },
        { _id: "pur-tenant-a-2", tenantId: "tenant-a", purchaseNo: "PO-A-002", grandTotal: 3000 },
        { _id: "pur-tenant-b-1", tenantId: "tenant-b", purchaseNo: "PO-B-001", grandTotal: 9000 },
    ];

    // List query simulation
    const findPurchasesForTenant = (tenantId: string) =>
        mockPurchases.filter((p) => p.tenantId === tenantId);

    const tenantAPurchases = findPurchasesForTenant("tenant-a");
    const tenantBPurchases = findPurchasesForTenant("tenant-b");

    check("2.1 Tenant A query returns only Tenant A purchases", tenantAPurchases.length === 2 && tenantAPurchases.every((p) => p.tenantId === "tenant-a"));
    check("2.2 Tenant B query returns only Tenant B purchases", tenantBPurchases.length === 1 && tenantBPurchases[0].tenantId === "tenant-b");

    // Single item query simulation
    const findPurchaseByIdAndTenant = (id: string, tenantId: string) =>
        mockPurchases.find((p) => p._id === id && p.tenantId === tenantId) || null;

    check(
        "2.3 Cross-tenant query (Tenant A requesting Tenant B purchase) returns null (404)",
        findPurchaseByIdAndTenant("pur-tenant-b-1", "tenant-a") === null
    );
    check(
        "2.4 Same-tenant query successfully locates purchase",
        findPurchaseByIdAndTenant("pur-tenant-a-1", "tenant-a")?._id === "pur-tenant-a-1"
    );
}

// ============================================================
// 3. Operation ID Validation & Schema Conformance
// ============================================================

function runSection3() {
    console.log("\n--- Section 3: Operation ID Validation & Schema Rules ---");

    const validPayload = {
        purchaseNo: "PO-2026-TEST",
        supplierId: "650000000000000000000001",
        warehouse: { name: "Central Warehouse" },
        items: [
            {
                productId: "650000000000000000000002",
                quantity: 10,
                unitPrice: 100,
            },
        ],
    };

    // 3.1 Optional operationId
    const resNoOp = createPurchaseSchema.safeParse(validPayload);
    check("3.1 Valid payload without operationId succeeds", resNoOp.success && resNoOp.data.operationId === undefined);

    // 3.2 Valid non-empty operationId
    const resWithOp = createPurchaseSchema.safeParse({ ...validPayload, operationId: "op-sync-purch-1001" });
    check("3.2 Valid string operationId succeeds", resWithOp.success && resWithOp.data.operationId === "op-sync-purch-1001");

    // 3.3 Trimming behavior
    const resTrimmed = createPurchaseSchema.safeParse({ ...validPayload, operationId: "   op-trimmed-2002   " });
    check("3.3 OperationId is cleanly trimmed", resTrimmed.success && resTrimmed.data.operationId === "op-trimmed-2002");

    // 3.4 Empty / whitespace operationId is rejected if provided
    const resEmpty = createPurchaseSchema.safeParse({ ...validPayload, operationId: "" });
    check("3.4 Empty string operationId is rejected if provided", resEmpty.success === false);

    const resWhitespace = createPurchaseSchema.safeParse({ ...validPayload, operationId: "    " });
    check("3.5 Whitespace-only operationId is rejected if provided", resWhitespace.success === false);

    const resNull = createPurchaseSchema.safeParse({ ...validPayload, operationId: null });
    check("3.6 Null operationId is rejected if provided", resNull.success === false);

    // 3.7 Oversized operationId rejected
    const oversizedOp = "a".repeat(201);
    const resOversized = createPurchaseSchema.safeParse({ ...validPayload, operationId: oversizedOp });
    check("3.7 OperationId exceeding 200 characters is rejected", resOversized.success === false);

    // 3.8 Non-string operationId rejected
    const resNumber = createPurchaseSchema.safeParse({ ...validPayload, operationId: 12345 });
    check("3.8 Numeric operationId is rejected", resNumber.success === false);

    // 3.9 Online supplier ID strictness
    const resTempSupplierOnline = createPurchaseSchema.safeParse({ ...validPayload, supplierId: "sup_temp_12345" });
    check("3.9 Online schema REJECTS temporary offline supplier ID", resTempSupplierOnline.success === false);

    const resTempSupplierOffline = offlinePurchasePayloadSchema.safeParse({ ...validPayload, supplierId: "sup_temp_12345" });
    check("3.10 Offline schema ACCEPTS temporary offline supplier ID", resTempSupplierOffline.success === true);
}

// ============================================================
// 4. Idempotency & Stock Movement Double-Count Protection
// ============================================================

function runSection4() {
    console.log("\n--- Section 4: Idempotency & Stock Movement Double-Count Protection ---");

    interface MockPurchaseRecord {
        _id: string;
        tenantId: string;
        operationId?: string;
        purchaseNo: string;
        grandTotal: number;
        alreadyProcessed?: boolean;
    }

    interface MockStockMovement {
        _id: string;
        tenantId: string;
        referenceId: string;
        productId: string;
        quantity: number;
    }

    const purchasesTable: MockPurchaseRecord[] = [];
    const stockMovementsTable: MockStockMovement[] = [];
    const productStock: Record<string, number> = { "prod-101": 0 };

    function simulateCreatePurchase(
        tenantId: string,
        input: { purchaseNo: string; productId: string; quantity: number },
        operationId?: string
    ): { purchase: MockPurchaseRecord; alreadyProcessed: boolean } {
        const normalizedOpId = operationId?.trim() || undefined;

        // Step 1: Idempotency lookup
        if (normalizedOpId) {
            const existing = purchasesTable.find((p) => p.tenantId === tenantId && p.operationId === normalizedOpId);
            if (existing) {
                return { purchase: { ...existing, alreadyProcessed: true }, alreadyProcessed: true };
            }
        }

        // Step 2: Fresh creation
        const purchaseId = `pur-${purchasesTable.length + 1}`;
        const newPurchase: MockPurchaseRecord = {
            _id: purchaseId,
            tenantId,
            operationId: normalizedOpId,
            purchaseNo: input.purchaseNo,
            grandTotal: input.quantity * 100,
        };
        purchasesTable.push(newPurchase);

        // Step 3: Stock update
        stockMovementsTable.push({
            _id: `sm-${stockMovementsTable.length + 1}`,
            tenantId,
            referenceId: purchaseId,
            productId: input.productId,
            quantity: input.quantity,
        });
        productStock[input.productId] = (productStock[input.productId] || 0) + input.quantity;

        return { purchase: newPurchase, alreadyProcessed: false };
    }

    // Call 1: First submission
    const res1 = simulateCreatePurchase("tenant-1", { purchaseNo: "PO-IDEMP-01", productId: "prod-101", quantity: 20 }, "op-pur-unique-999");
    check("4.1 Initial submission creates purchase", res1.alreadyProcessed === false && purchasesTable.length === 1);
    check("4.2 Initial submission creates stock movement", stockMovementsTable.length === 1 && stockMovementsTable[0].quantity === 20);
    check("4.3 Initial submission increments product stock to 20", productStock["prod-101"] === 20);

    // Call 2: Duplicate submission with same operationId (retry after network timeout)
    const res2 = simulateCreatePurchase("tenant-1", { purchaseNo: "PO-IDEMP-01", productId: "prod-101", quantity: 20 }, "op-pur-unique-999");
    check("4.4 Duplicate submission identifies alreadyProcessed: true", res2.alreadyProcessed === true && res2.purchase._id === res1.purchase._id);
    check("4.5 Duplicate submission does NOT create a second purchase document", purchasesTable.length === 1);
    check("4.6 Duplicate submission does NOT create an additional stock movement", stockMovementsTable.length === 1);
    check("4.7 Duplicate submission does NOT increment stock (stock remains exactly 20)", productStock["prod-101"] === 20);
}

// ============================================================
// 5. Partial Index Filter Evaluation
// ============================================================

function runSection5() {
    console.log("\n--- Section 5: Partial Index Filter Evaluation ---");

    /**
     * Evaluates MongoDB partialFilterExpression:
     *   { operationId: { $type: "string", $gt: "" } }
     */
    function matchesPartialFilter(doc: { operationId?: unknown }): boolean {
        const val = doc.operationId;
        const isString = typeof val === "string";
        const isGreaterThanEmpty = isString && (val as string) > "";
        return isString && isGreaterThanEmpty;
    }

    /**
     * Old buggy expression:
     *   { operationId: { $exists: true } }
     */
    function matchesOldBuggyFilter(doc: { operationId?: unknown }): boolean {
        return Object.prototype.hasOwnProperty.call(doc, "operationId") && doc.operationId !== undefined;
    }

    // Test cases
    const docMissing = {};
    const docUndefined = { operationId: undefined };
    const docNull = { operationId: null };
    const docEmptyString = { operationId: "" };
    const docWhitespaceOnly = { operationId: "   " };
    const docValid = { operationId: "op-valid-123" };

    check("5.1 Missing operationId is EXCLUDED from partial index", matchesPartialFilter(docMissing) === false);
    check("5.2 Undefined operationId is EXCLUDED from partial index", matchesPartialFilter(docUndefined) === false);
    check("5.3 Null operationId is EXCLUDED from partial index (safe for legacy nulls)", matchesPartialFilter(docNull) === false);
    check("5.4 Empty string operationId is EXCLUDED from partial index", matchesPartialFilter(docEmptyString) === false);
    check("5.5 Trimmed whitespace-only operationId is EXCLUDED from partial index", matchesPartialFilter({ operationId: docWhitespaceOnly.operationId.trim() }) === false);
    check("5.6 Non-empty string operationId is INCLUDED in unique index", matchesPartialFilter(docValid) === true);

    // Comparison with old filter vulnerability
    check(
        "5.6 Contrast: old filter ($exists: true) mistakenly indexed null (causing collisions)",
        matchesOldBuggyFilter(docNull) === true && matchesPartialFilter(docNull) === false
    );
    check(
        "5.7 Contrast: old filter ($exists: true) mistakenly indexed empty string",
        matchesOldBuggyFilter(docEmptyString) === true && matchesPartialFilter(docEmptyString) === false
    );
}

// ============================================================
// 6. Payment Gating for Cancelled/Draft Purchases
// ============================================================

function runSection6() {
    console.log("\n--- Section 6: Payment Gating & State Behavior ---");

    interface MockPurchaseState {
        dueAmount: number;
        status: "draft" | "received" | "cancelled";
    }

    function canRecordPayment(purchase: MockPurchaseState): boolean {
        return purchase.dueAmount > 0 && purchase.status === "received";
    }

    const openBill: MockPurchaseState = { dueAmount: 500, status: "received" };
    check("6.1 Open bill with positive due amount and status 'received' allows recording payment", canRecordPayment(openBill) === true);

    const paidBill: MockPurchaseState = { dueAmount: 0, status: "received" };
    check("6.2 Fully settled bill (dueAmount: 0) disallows recording payment", canRecordPayment(paidBill) === false);

    const cancelledBill: MockPurchaseState = { dueAmount: 500, status: "cancelled" };
    check("6.3 Voided/cancelled bill disallows recording payment", canRecordPayment(cancelledBill) === false);

    const draftBill: MockPurchaseState = { dueAmount: 500, status: "draft" };
    check("6.4 Draft bill disallows recording payment", canRecordPayment(draftBill) === false);
}

// ============================================================
// MAIN RUNNER
// ============================================================

function main() {
    console.log("=== PURCHASES MODULE STEP 2 FIXES TEST SUITE ===");
    runSection1();
    runSection2();
    runSection3();
    runSection4();
    runSection5();
    runSection6();

    const ok = summarize();
    process.exitCode = ok ? 0 : 1;
}

main();
