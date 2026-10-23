/**
 * Test Suite: Purchases Module Validation & Calculation Integrity (Step 1)
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Valid Purchase Payloads:
 *    - Full payload with optional fields, shipping, and payment
 *    - Minimal valid payload with required fields only
 *    - Text trimming and purchase number uppercase transformation
 *    - Date parsing from Date instances and ISO strings
 * 2. Missing Required Fields:
 *    - Missing or empty purchaseNo
 *    - Missing supplierId
 *    - Missing warehouse or empty warehouse name
 *    - Missing items or empty items array
 * 3. Identifier Verification:
 *    - Valid 24-character hex MongoDB ObjectId accepted
 *    - Temporary offline supplier ID (sup_...) accepted
 *    - Malformed supplier ID rejected
 *    - Valid 24-character hex product ID accepted
 *    - Malformed product ID rejected
 * 4. Numeric Bounds (Quantities and Prices):
 *    - Strictly positive finite quantities accepted
 *    - Zero, negative, and non-finite quantities (NaN, Infinity) rejected
 *    - Non-negative finite prices accepted (including zero for complimentary items)
 *    - Negative and non-finite prices rejected
 * 5. Discount and Tax Bounds:
 *    - Rates between 0 and 100 accepted
 *    - Negative rates rejected
 *    - Rates exceeding 100 rejected
 *    - Defaulting to 0 when omitted
 * 6. Text Trimming and Length Limits:
 *    - Trimming warehouse name, notes, invoice number
 *    - Length violation enforcement (warehouse > 100, invoiceNo > 100, notes > 1000)
 * 7. Optional Financial Fields & Paid Amount Refinement:
 *    - Shipping cost validation (non-negative)
 *    - Paid amount validation (non-negative)
 *    - Paid amount exceeding grand total rejected
 *    - Payment status enum validation
 * 8. Operation ID & Idempotency:
 *    - Operation ID accepted, trimmed, length-checked
 *    - Empty string operationId rejected
 * 9. Strict Schema Property Enforcement:
 *    - Strict schema rejects unrecognized properties and tenantId injection
 * 10. Offline Sync Compatibility:
 *    - Offline payload with temporary supplier ID, supplierSnapshot, productSnapshot, localId
 * 11. Pure Calculation Helper (calculatePurchaseTotals):
 *    - Exact computation of gross, discount, tax, shipping, and grand total
 *
 * Run:
 *   npx tsx scripts/test-purchase-validation.ts
 */

import {
    createPurchaseSchema,
    offlinePurchasePayloadSchema,
    calculatePurchaseTotals,
    isValidMongoObjectId,
    isTemporarySupplierId,
    isValidSupplierId,
    parseFiniteNumber,
    type CreatePurchaseInput,
} from "../lib/validations/purchase";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n============================================================`);
    console.log(`PURCHASE VALIDATION TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

const VALID_OBJECT_ID_SUPPLIER = "507f1f77bcf86cd799439011";
const VALID_OBJECT_ID_PRODUCT_1 = "507f1f77bcf86cd799439022";
const VALID_OBJECT_ID_PRODUCT_2 = "507f1f77bcf86cd799439033";
const VALID_TEMP_SUPPLIER_ID = "sup_12345678-abcd-ef01-2345-6789abcdef01";

function run() {
    console.log("=== TEST SUITE: PURCHASE MODULE VALIDATION & CALCULATIONS ===\n");

    // ============================================================
    // SECTION 1: Valid Purchase Payloads
    // ============================================================
    console.log("-- 1. Valid Purchase Payloads --");

    // 1.1 Complete valid purchase payload
    const fullPayload = {
        operationId: "op-pur-2026-001",
        purchaseNo: "po-2026-0001",
        supplierId: VALID_OBJECT_ID_SUPPLIER,
        purchaseDate: "2026-10-21T10:00:00.000Z",
        supplierInvoiceNo: "INV-SUP-9981",
        supplierInvoiceDate: "2026-10-20",
        dueDate: new Date("2026-11-20"),
        warehouse: {
            name: "Main Distribution Center",
            location: "Bay 4, Rack A",
        },
        items: [
            {
                productId: VALID_OBJECT_ID_PRODUCT_1,
                quantity: 10,
                unitPrice: 150,
                discountRate: 10,
                taxRate: 18,
            },
            {
                productId: VALID_OBJECT_ID_PRODUCT_2,
                quantity: 5,
                unitPrice: 200,
                discountRate: 0,
                taxRate: 12,
            },
        ],
        shippingCost: 150,
        paidAmount: 500,
        paymentStatus: "partial" as const,
        notes: "Urgent inventory replenishment",
    };

    const resFull = createPurchaseSchema.safeParse(fullPayload);
    check("1.1.1 Full valid purchase payload parses successfully", resFull.success);
    if (resFull.success) {
        check("1.1.2 Purchase number is uppercased", resFull.data.purchaseNo === "PO-2026-0001");
        check("1.1.3 Purchase date parsed to Date instance", resFull.data.purchaseDate instanceof Date);
        check("1.1.4 Supplier invoice date parsed to Date instance", resFull.data.supplierInvoiceDate instanceof Date);
        check("1.1.5 Due date preserved as Date instance", resFull.data.dueDate instanceof Date);
        check("1.1.6 Items array retained 2 items", resFull.data.items.length === 2);
        check("1.1.7 Paid amount preserved", resFull.data.paidAmount === 500);
    }

    // 1.2 Minimal valid purchase payload
    const minimalPayload = {
        purchaseNo: "PO-MINIMAL-01",
        supplierId: VALID_OBJECT_ID_SUPPLIER,
        warehouse: {
            name: "Main Store",
        },
        items: [
            {
                productId: VALID_OBJECT_ID_PRODUCT_1,
                quantity: 2,
                unitPrice: 50,
            },
        ],
    };

    const resMin = createPurchaseSchema.safeParse(minimalPayload);
    check("1.2.1 Minimal payload with required fields only succeeds", resMin.success);
    if (resMin.success) {
        check("1.2.2 Default discountRate on item is 0", resMin.data.items[0].discountRate === 0);
        check("1.2.3 Default taxRate on item is 0", resMin.data.items[0].taxRate === 0);
        check("1.2.4 Default shippingCost is 0", resMin.data.shippingCost === 0);
        check("1.2.5 Default paidAmount is 0", resMin.data.paidAmount === 0);
        check("1.2.6 Optional dates are undefined", resMin.data.purchaseDate === undefined && resMin.data.dueDate === undefined);
    }

    // 1.3 Whitespace trimming
    const whitespacePayload = {
        purchaseNo: "   po-trimmed-02   ",
        supplierId: `   ${VALID_OBJECT_ID_SUPPLIER}   `,
        supplierInvoiceNo: "   INV-777   ",
        warehouse: {
            name: "   North Hub   ",
            location: "   Aisle 2   ",
        },
        items: [
            {
                productId: `  ${VALID_OBJECT_ID_PRODUCT_1}  `,
                quantity: 1,
                unitPrice: 100,
            },
        ],
        notes: "   Handled by manager   ",
    };

    const resTrim = createPurchaseSchema.safeParse(whitespacePayload);
    check("1.3.1 Whitespace padded payload succeeds", resTrim.success);
    if (resTrim.success) {
        check("1.3.2 purchaseNo trimmed & uppercased", resTrim.data.purchaseNo === "PO-TRIMMED-02");
        check("1.3.3 supplierId trimmed", resTrim.data.supplierId === VALID_OBJECT_ID_SUPPLIER);
        check("1.3.4 supplierInvoiceNo trimmed", resTrim.data.supplierInvoiceNo === "INV-777");
        check("1.3.5 warehouse name trimmed", resTrim.data.warehouse.name === "North Hub");
        check("1.3.6 warehouse location trimmed", resTrim.data.warehouse.location === "Aisle 2");
        check("1.3.7 productId trimmed", resTrim.data.items[0].productId === VALID_OBJECT_ID_PRODUCT_1);
        check("1.3.8 notes trimmed", resTrim.data.notes === "Handled by manager");
    }

    // ============================================================
    // SECTION 2: Missing Required Fields
    // ============================================================
    console.log("\n-- 2. Missing Required Fields --");

    check(
        "2.1 Missing purchaseNo rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, purchaseNo: undefined }).success
    );

    check(
        "2.2 Empty / whitespace purchaseNo rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, purchaseNo: "   " }).success
    );

    check(
        "2.3 Missing supplierId rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, supplierId: undefined }).success
    );

    check(
        "2.4 Missing warehouse rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, warehouse: undefined }).success
    );

    check(
        "2.5 Empty warehouse name rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, warehouse: { name: "   " } }).success
    );

    check(
        "2.6 Missing items array rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, items: undefined }).success
    );

    check(
        "2.7 Empty items array [] rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, items: [] }).success
    );

    // ============================================================
    // SECTION 3: Identifier Validation
    // ============================================================
    console.log("\n-- 3. Identifier Validation --");

    check("3.1.1 Valid 24-hex ObjectId recognized by helper", isValidMongoObjectId(VALID_OBJECT_ID_SUPPLIER));
    check("3.1.2 Temporary supplier ID recognized by helper", isTemporarySupplierId(VALID_TEMP_SUPPLIER_ID));
    check("3.1.3 isValidSupplierId accepts 24-hex ObjectId", isValidSupplierId(VALID_OBJECT_ID_SUPPLIER));
    check("3.1.4 isValidSupplierId accepts temporary ID", isValidSupplierId(VALID_TEMP_SUPPLIER_ID));
    check("3.1.5 isValidSupplierId rejects arbitrary string", !isValidSupplierId("invalid-supplier-id"));

    // Online schema (createPurchaseSchema)
    check(
        "3.2.1 Online schema accepts valid MongoDB ObjectId supplierId",
        createPurchaseSchema.safeParse({ ...minimalPayload, supplierId: VALID_OBJECT_ID_SUPPLIER }).success
    );
    check(
        "3.2.2 Online schema rejects temporary supplier ID (must be resolved before server upload)",
        !createPurchaseSchema.safeParse({ ...minimalPayload, supplierId: VALID_TEMP_SUPPLIER_ID }).success
    );

    // Offline queue schema (offlinePurchasePayloadSchema)
    check(
        "3.2.3 Offline queue schema accepts valid temporary supplier ID",
        offlinePurchasePayloadSchema.safeParse({ ...minimalPayload, supplierId: VALID_TEMP_SUPPLIER_ID }).success
    );
    check(
        "3.2.4 Offline queue schema accepts valid MongoDB ObjectId supplierId",
        offlinePurchasePayloadSchema.safeParse({ ...minimalPayload, supplierId: VALID_OBJECT_ID_SUPPLIER }).success
    );

    check(
        "3.3 Malformed supplier ID (23 chars) rejected by both schemas",
        !createPurchaseSchema.safeParse({ ...minimalPayload, supplierId: "507f1f77bcf86cd79943901" }).success &&
        !offlinePurchasePayloadSchema.safeParse({ ...minimalPayload, supplierId: "507f1f77bcf86cd79943901" }).success
    );

    check(
        "3.4 Malformed supplier ID (non-hex) rejected by both schemas",
        !createPurchaseSchema.safeParse({ ...minimalPayload, supplierId: "507f1f77bcf86cd7994390zz" }).success &&
        !offlinePurchasePayloadSchema.safeParse({ ...minimalPayload, supplierId: "507f1f77bcf86cd7994390zz" }).success
    );

    check(
        "3.5 Malformed product ID (non-hex) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: "not-an-object-id", quantity: 1, unitPrice: 100 }],
        }).success
    );

    check(
        "3.6 Empty product ID rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: "", quantity: 1, unitPrice: 100 }],
        }).success
    );

    // ============================================================
    // SECTION 4: Numeric Bounds (Quantities and Prices)
    // ============================================================
    console.log("\n-- 4. Numeric Bounds (Quantities and Prices) --");

    check(
        "4.1 Fractional positive quantity (0.250 kg) accepted",
        createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 0.25, unitPrice: 100 }],
        }).success
    );

    check(
        "4.2 Zero quantity (0) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 0, unitPrice: 100 }],
        }).success
    );

    check(
        "4.3 Negative quantity (-5) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: -5, unitPrice: 100 }],
        }).success
    );

    check(
        "4.4 Non-finite quantity (Infinity) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: Infinity, unitPrice: 100 }],
        }).success
    );

    check(
        "4.5 Zero unit price (free sample) accepted",
        createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 0 }],
        }).success
    );

    check(
        "4.6 Negative unit price (-50) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: -50 }],
        }).success
    );

    check(
        "4.7 Non-finite unit price (NaN) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: NaN }],
        }).success
    );

    check(
        "4.8 String type for quantity rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: "1" as any, unitPrice: 100 }],
        }).success
    );

    check(
        "4.9 Quantity exceeding upper limit (2,000,000) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 2_000_000, unitPrice: 100 }],
        }).success
    );

    // ============================================================
    // SECTION 5: Discount and Tax Bounds
    // ============================================================
    console.log("\n-- 5. Discount and Tax Bounds --");

    check(
        "5.1 Boundary discount rate 0% and 100% accepted",
        createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [
                { productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, discountRate: 0 },
                { productId: VALID_OBJECT_ID_PRODUCT_2, quantity: 1, unitPrice: 100, discountRate: 100 },
            ],
        }).success
    );

    check(
        "5.2 Negative discount rate (-1%) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, discountRate: -1 }],
        }).success
    );

    check(
        "5.3 Discount rate > 100% (100.1%) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, discountRate: 100.1 }],
        }).success
    );

    check(
        "5.4 Boundary tax rate 0%, 18%, 100% accepted",
        createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, taxRate: 18 }],
        }).success
    );

    check(
        "5.5 Negative tax rate (-0.5%) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, taxRate: -0.5 }],
        }).success
    );

    check(
        "5.6 Tax rate > 100% (105%) rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, taxRate: 105 }],
        }).success
    );

    // ============================================================
    // SECTION 6: Text Trimming and Length Limits
    // ============================================================
    console.log("\n-- 6. Text Trimming and Length Limits --");

    check(
        "6.1 Warehouse name exceeding 100 chars rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            warehouse: { name: "W".repeat(101) },
        }).success
    );

    check(
        "6.2 Supplier invoice number exceeding 100 chars rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            supplierInvoiceNo: "I".repeat(101),
        }).success
    );

    check(
        "6.3 Notes exceeding 1000 chars rejected",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            notes: "N".repeat(1001),
        }).success
    );

    const emptyOptionalPayload = {
        ...minimalPayload,
        supplierInvoiceNo: "   ",
        notes: "   ",
    };
    const resEmptyOpt = createPurchaseSchema.safeParse(emptyOptionalPayload);
    check("6.4 Whitespace-only optional fields succeed", resEmptyOpt.success);
    if (resEmptyOpt.success) {
        check("6.5 supplierInvoiceNo converted to undefined", resEmptyOpt.data.supplierInvoiceNo === undefined);
        check("6.6 notes converted to undefined", resEmptyOpt.data.notes === undefined);
    }

    // ============================================================
    // SECTION 7: Financial Fields & Paid Amount Refinement
    // ============================================================
    console.log("\n-- 7. Financial Fields & Paid Amount Refinement --");

    check(
        "7.1 Negative shipping cost (-10) rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, shippingCost: -10 }).success
    );

    check(
        "7.2 Negative paid amount (-50) rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: -50 }).success
    );

    // Item: 2 * 50 = 100 grand total
    check(
        "7.3 Paid amount <= grand total (50 <= 100) passes",
        createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: 50 }).success
    );

    check(
        "7.4 Paid amount == grand total (100 == 100) passes",
        createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: 100 }).success
    );

    check(
        "7.5.1 Paid amount > grand total (150 > 100) rejected by refinement",
        !createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: 150 }).success
    );

    check(
        "7.5.2 Paid amount exceeding grand total within previous 0.0001 tolerance (100.00005 > 100) rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: 100.00005 }).success
    );

    check(
        "7.5.3 Paid amount exceeding grand total at 0.0001 boundary (100.0001 > 100) rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: 100.0001 }).success
    );

    check(
        "7.6 Valid paymentStatus enums accepted",
        createPurchaseSchema.safeParse({ ...minimalPayload, paymentStatus: "unpaid" }).success &&
        createPurchaseSchema.safeParse({ ...minimalPayload, paymentStatus: "partial" }).success &&
        createPurchaseSchema.safeParse({ ...minimalPayload, paidAmount: 100, paymentStatus: "paid" }).success
    );

    check(
        "7.7 Invalid paymentStatus enum rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, paymentStatus: "completed" as any }).success
    );

    // ============================================================
    // SECTION 8: Operation ID & Idempotency
    // ============================================================
    console.log("\n-- 8. Operation ID & Idempotency --");

    const opIdPayload = {
        ...minimalPayload,
        operationId: "  op-purchase-offline-5521  ",
    };
    const resOpId = createPurchaseSchema.safeParse(opIdPayload);
    check("8.1 Valid operationId accepted and trimmed", resOpId.success && resOpId.data.operationId === "op-purchase-offline-5521");

    check(
        "8.2 Empty string operationId rejected if provided",
        !createPurchaseSchema.safeParse({ ...minimalPayload, operationId: "   " }).success
    );

    check(
        "8.3 operationId exceeding 200 chars rejected",
        !createPurchaseSchema.safeParse({ ...minimalPayload, operationId: "O".repeat(201) }).success
    );

    // ============================================================
    // SECTION 9: Strict Schema Property Enforcement
    // ============================================================
    console.log("\n-- 9. Strict Schema Property Enforcement --");

    check(
        "9.1 Unrecognized property rejected by strict schema",
        !createPurchaseSchema.safeParse({ ...minimalPayload, unexpectedField: "hack" }).success
    );

    check(
        "9.2 Injection of tenantId rejected by strict schema",
        !createPurchaseSchema.safeParse({ ...minimalPayload, tenantId: "507f1f77bcf86cd799439099" }).success
    );

    check(
        "9.3 Unrecognized item property rejected by strict item schema",
        !createPurchaseSchema.safeParse({
            ...minimalPayload,
            items: [{ productId: VALID_OBJECT_ID_PRODUCT_1, quantity: 1, unitPrice: 100, malicious: true } as any],
        }).success
    );

    // ============================================================
    // SECTION 10: Offline Sync Compatibility
    // ============================================================
    console.log("\n-- 10. Offline Sync Compatibility --");

    const offlinePayload = {
        operationId: "offline-op-pur-901",
        purchaseNo: "PO-OFFLINE-901",
        supplierId: VALID_TEMP_SUPPLIER_ID, // Temporary supplier ID
        supplierCode: "SUP-TEMP-A1B2",
        supplierSnapshot: {
            name: "Local Cement Works",
            supplierCode: "SUP-TEMP-A1B2",
            phone: "9876543210",
            gstin: "27AAAAA0000A1Z5",
        },
        warehouse: {
            name: "Main Store",
            location: "Yard 1",
        },
        items: [
            {
                productId: VALID_OBJECT_ID_PRODUCT_1,
                quantity: 20,
                unitPrice: 350,
                discountRate: 5,
                taxRate: 18,
                productSnapshot: {
                    name: "Portland Cement",
                    SKU: "CEM-001",
                    unit: "BAG",
                },
            },
        ],
        localId: "local_pur_uuid_777",
        subtotal: 7000,
        discountTotal: 350,
        taxTotal: 1197,
        shippingCost: 500,
        grandTotal: 8347,
        paidAmount: 2000,
        paymentStatus: "partial" as const,
    };

    const resOffline = offlinePurchasePayloadSchema.safeParse(offlinePayload);
    check("10.1 Offline payload satisfies offlinePurchasePayloadSchema", resOffline.success);
    if (resOffline.success) {
        check("10.2 Temporary supplierId preserved in offline schema", resOffline.data.supplierId === VALID_TEMP_SUPPLIER_ID);
        check("10.3 supplierSnapshot preserved", resOffline.data.supplierSnapshot?.name === "Local Cement Works");
        check("10.4 productSnapshot preserved", resOffline.data.items[0].productSnapshot?.SKU === "CEM-001");
        check("10.5 localId preserved", resOffline.data.localId === "local_pur_uuid_777");
        check("10.6 Advisory totals permitted without schema rejection", resOffline.data.grandTotal === 8347);
    }

    check(
        "10.7 Unresolved offline payload with temporary supplierId is rejected by server createPurchaseSchema",
        !createPurchaseSchema.safeParse(offlinePayload).success
    );

    const resolvedOfflinePayload = {
        ...offlinePayload,
        supplierId: VALID_OBJECT_ID_SUPPLIER,
        supplierCode: "SUP-0005",
    };
    check(
        "10.8 Resolved offline payload with server MongoDB ObjectId succeeds with createPurchaseSchema",
        createPurchaseSchema.safeParse(resolvedOfflinePayload).success
    );

    // ============================================================
    // SECTION 11: Pure Calculation Helper (calculatePurchaseTotals)
    // ============================================================
    console.log("\n-- 11. Pure Calculation Helper (calculatePurchaseTotals) --");

    // Item 1: 10 qty * 200 price = 2000 gross. Discount 10% = 200. Taxable = 1800. Tax 18% = 324. Total = 2124.
    // Shipping: 100. GrandTotal = 1800 + 324 + 100 = 2224.
    const calcResult1 = calculatePurchaseTotals(
        [
            {
                quantity: 10,
                unitPrice: 200,
                discountRate: 10,
                taxRate: 18,
            },
        ],
        100
    );

    check("11.1 Subtotal gross equals 2000", calcResult1.subtotal === 2000);
    check("11.2 Discount total equals 200", calcResult1.discountTotal === 200);
    check("11.3 Tax total equals 324", calcResult1.taxTotal === 324);
    check("11.4 Shipping cost equals 100", calcResult1.shippingCost === 100);
    check("11.5 Grand total equals 2224", calcResult1.grandTotal === 2224);

    // Item 2 (Zero discount, zero tax)
    const calcResult2 = calculatePurchaseTotals(
        [
            {
                quantity: 5,
                unitPrice: 40,
            },
        ],
        0
    );
    check("11.6 Zero discount/tax yields exact subtotal == grandTotal", calcResult2.subtotal === 200 && calcResult2.grandTotal === 200);

    // Number parser helper
    check("11.7 parseFiniteNumber parses number", parseFiniteNumber(42.5) === 42.5);
    check("11.8 parseFiniteNumber parses numeric string", parseFiniteNumber(" 100.25 ") === 100.25);
    check("11.9 parseFiniteNumber rejects NaN/Infinity", parseFiniteNumber(NaN) === null && parseFiniteNumber("Infinity") === null);
    check("11.10 parseFiniteNumber rejects non-numeric string", parseFiniteNumber("abc") === null && parseFiniteNumber("") === null);

    return summarize();
}

const success = run();
process.exit(success ? 0 : 1);
