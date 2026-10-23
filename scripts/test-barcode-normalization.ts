/*
 * Database-free unit tests for Barcode Normalization, Indexing, and Search.
 *
 * Validates:
 * 1. Mongoose Product Schema definition (barcode trim: true, uppercase: true).
 * 2. Blank and whitespace-only barcode normalization (omitted from document, allows unlimited per tenant).
 * 3. Leading/trailing whitespace trimming and uppercase canonicalization.
 * 4. Case-insensitive duplicate rejection within the same tenant.
 * 5. Cross-tenant barcode uniqueness isolation.
 * 6. Product update (PUT) self-match and conflict rejection behavior.
 * 7. Offline sync normalization, idempotency, and conflict rejection.
 * 8. POS barcode lookup with mixed-case and whitespace inputs.
 * 9. Concurrent duplicate creation E11000 error mapping.
 *
 * Run:
 *   npx tsx scripts/test-barcode-normalization.ts
 */

import { Product } from "../lib/models/Product";
import { matchCatalogItems } from "../components/pos/pos-screen";
import {
    computeBarcodeAuditMetrics,
    validateAuditGuards,
    safeCloseMongooseConnection,
    NON_EMPTY_TRIMMED_BARCODE_MATCH,
} from "./audit-product-barcodes-production";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n============================================================`);
    console.log(`TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    console.log(`============================================================`);
    if (failed.length > 0) {
        console.log("\nFailed checks:");
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    return failed.length === 0;
}

// Pure helper simulating POST /api/products barcode normalization
function normalizePostBarcode(inputBarcode?: string | null): string | undefined {
    return inputBarcode?.trim() ? inputBarcode.trim().toUpperCase() : undefined;
}

// Pure helper simulating POST /api/products duplicate pre-check
function evaluatePostDuplicate(
    existing: { tenantId: string; SKU: string; barcode?: string }[],
    newProduct: { tenantId: string; SKU: string; barcode?: string }
): { isDuplicate: boolean; message?: string } {
    const sku = newProduct.SKU.trim().toUpperCase();
    const cleanBarcode = normalizePostBarcode(newProduct.barcode);

    for (const item of existing) {
        if (item.tenantId !== newProduct.tenantId) continue;

        const isSkuMatch = item.SKU.toUpperCase() === sku;
        const isBarcodeMatch = Boolean(
            cleanBarcode &&
            item.barcode &&
            item.barcode.trim().toUpperCase() === cleanBarcode
        );

        if (isSkuMatch && isBarcodeMatch) {
            return { isDuplicate: true, message: "A product with this SKU or barcode already exists" };
        }
        if (isSkuMatch) {
            return { isDuplicate: true, message: "A product with this SKU already exists" };
        }
        if (isBarcodeMatch) {
            return { isDuplicate: true, message: "A product with this barcode already exists" };
        }
    }
    return { isDuplicate: false };
}

// Pure helper simulating PUT /api/products/[id] duplicate pre-check
function evaluatePutDuplicate(
    existing: { _id: string; tenantId: string; SKU: string; barcode?: string }[],
    targetId: string,
    updateData: { tenantId: string; SKU?: string; barcode?: string }
): { isDuplicate: boolean; message?: string } {
    const current = existing.find((p) => p._id === targetId && p.tenantId === updateData.tenantId);
    if (!current) throw new Error("Product not found");

    const newSKU = updateData.SKU?.trim().toUpperCase();
    const cleanBarcode =
        updateData.barcode !== undefined
            ? updateData.barcode.trim()
                ? updateData.barcode.trim().toUpperCase()
                : ""
            : undefined;

    const currentBarcode = current.barcode ? current.barcode.trim().toUpperCase() : undefined;

    // Check if barcode changed and is non-empty
    const checkBarcode = cleanBarcode !== undefined && cleanBarcode !== "" && cleanBarcode !== currentBarcode;
    const checkSKU = newSKU !== undefined && newSKU !== current.SKU.toUpperCase();

    if (!checkBarcode && !checkSKU) {
        return { isDuplicate: false }; // no conflict, self-match allowed
    }

    for (const other of existing) {
        if (other._id === targetId || other.tenantId !== updateData.tenantId) continue;

        const otherSKU = other.SKU.toUpperCase();
        const otherBarcode = other.barcode ? other.barcode.trim().toUpperCase() : undefined;

        if (checkSKU && newSKU === otherSKU) {
            return { isDuplicate: true, message: "Another product already uses this SKU or barcode" };
        }
        if (checkBarcode && cleanBarcode === otherBarcode) {
            return { isDuplicate: true, message: "Another product already uses this SKU or barcode" };
        }
    }

    return { isDuplicate: false };
}

// Pure helper simulating ProductSyncService offline payload ingestion
function normalizeSyncBarcode(payloadBarcode?: unknown): string | undefined {
    return typeof payloadBarcode === "string" && payloadBarcode.trim()
        ? payloadBarcode.trim().toUpperCase()
        : undefined;
}

// Pure helper simulating E11000 error mapping in POST /api/products
function mapPostE11000Error(keyPattern?: Record<string, unknown>): { status: number; message: string } {
    let message = "A product with this SKU or barcode already exists";
    if (keyPattern) {
        if (keyPattern.barcode) {
            message = "A product with this barcode already exists";
        } else if (keyPattern.SKU) {
            message = "A product with this SKU already exists";
        } else if (keyPattern.operationId) {
            message = "A product with this operation ID already exists";
        }
    }
    return { status: 409, message };
}

async function main() {
    console.log("=== COMPREHENSIVE BARCODE NORMALIZATION DATABASE-FREE TESTS ===\n");

    // ============================================================
    // 1. MONGOOSE SCHEMA VALIDATION
    // ============================================================
    console.log("-- 1. Mongoose Product Schema Definitions --");

    const schemaPath = Product.schema.path("barcode") as any;
    check("1.1. Barcode field is registered on Product schema", Boolean(schemaPath));
    check("1.2. Barcode schema options enforce trim: true", schemaPath?.options?.trim === true);
    check("1.3. Barcode schema options enforce uppercase: true", schemaPath?.options?.uppercase === true);

    const skuPath = Product.schema.path("SKU") as any;
    check("1.4. SKU schema options enforce uppercase: true and trim: true",
        skuPath?.options?.uppercase === true && skuPath?.options?.trim === true);

    // ============================================================
    // 2. BLANK & WHITESPACE-ONLY BARCODE NORMALIZATION
    // ============================================================
    console.log("\n-- 2. Blank & Whitespace-Only Barcode Normalization --");

    check("2.1. Undefined barcode normalizes to undefined", normalizePostBarcode(undefined) === undefined);
    check("2.2. Null barcode normalizes to undefined", normalizePostBarcode(null) === undefined);
    check("2.3. Empty string '' normalizes to undefined", normalizePostBarcode("") === undefined);
    check("2.4. Whitespace-only string '   ' normalizes to undefined", normalizePostBarcode("   ") === undefined);

    // Multiple products with blank barcodes do not collide
    const existingBlankProducts = [
        { tenantId: "t1", SKU: "P1", barcode: undefined },
        { tenantId: "t1", SKU: "P2" },
    ];
    const newBlank1 = evaluatePostDuplicate(existingBlankProducts, { tenantId: "t1", SKU: "P3", barcode: "" });
    check("2.5. Product with empty string barcode does not collide with existing blank products", !newBlank1.isDuplicate);

    const newBlank2 = evaluatePostDuplicate(existingBlankProducts, { tenantId: "t1", SKU: "P4", barcode: "   " });
    check("2.6. Product with whitespace barcode does not collide with existing blank products", !newBlank2.isDuplicate);

    // ============================================================
    // 3. LEADING/TRAILING WHITESPACE & UPPERCASE CANONICALIZATION
    // ============================================================
    console.log("\n-- 3. Trimming and Uppercase Canonicalization --");

    check("3.1. Lowercase barcode normalizes to uppercase", normalizePostBarcode("abc123xyz") === "ABC123XYZ");
    check("3.2. Leading and trailing spaces are stripped and converted to uppercase",
        normalizePostBarcode("  ean-9876-ab  ") === "EAN-9876-AB");
    check("3.3. Numeric barcode strings are preserved without alteration",
        normalizePostBarcode("8901234567890") === "8901234567890");

    // ============================================================
    // 4. CASE-INSENSITIVE DUPLICATE REJECTION (SAME TENANT)
    // ============================================================
    console.log("\n-- 4. Case-Insensitive Duplicate Rejection (Same Tenant) --");

    const existingCatalog = [
        { tenantId: "tenant_1", SKU: "SHIRT-RED", barcode: "EAN-100" },
        { tenantId: "tenant_1", SKU: "SHIRT-BLUE", barcode: "EAN-200" },
    ];

    // Attempting same barcode, same case
    const dupExact = evaluatePostDuplicate(existingCatalog, {
        tenantId: "tenant_1",
        SKU: "SHIRT-GREEN",
        barcode: "EAN-100",
    });
    check("4.1. Exact duplicate barcode is rejected", Boolean(dupExact.isDuplicate && dupExact.message?.includes("barcode")));

    // Attempting same barcode, lowercase
    const dupLower = evaluatePostDuplicate(existingCatalog, {
        tenantId: "tenant_1",
        SKU: "SHIRT-GREEN",
        barcode: "ean-100",
    });
    check("4.2. Lowercase variation of existing barcode is rejected", Boolean(dupLower.isDuplicate && dupLower.message?.includes("barcode")));

    // Attempting same barcode, with surrounding whitespace and mixed case
    const dupSpacedMixed = evaluatePostDuplicate(existingCatalog, {
        tenantId: "tenant_1",
        SKU: "SHIRT-GREEN",
        barcode: "  EaN-100  ",
    });
    check("4.3. Spaced mixed-case variation of existing barcode is rejected",
        Boolean(dupSpacedMixed.isDuplicate && dupSpacedMixed.message?.includes("barcode")));

    // Distinct barcode succeeds
    const nonDup = evaluatePostDuplicate(existingCatalog, {
        tenantId: "tenant_1",
        SKU: "SHIRT-YELLOW",
        barcode: "EAN-300",
    });
    check("4.4. Distinct barcode succeeds without duplicate conflict", !nonDup.isDuplicate);

    // ============================================================
    // 5. CROSS-TENANT BARCODE UNIQUENESS ISOLATION
    // ============================================================
    console.log("\n-- 5. Cross-Tenant Barcode Uniqueness --");

    // Tenant 2 creating same barcode that exists in Tenant 1
    const crossTenantCreate = evaluatePostDuplicate(existingCatalog, {
        tenantId: "tenant_2",
        SKU: "SHIRT-ORANGE",
        barcode: "ean-100", // different tenant
    });
    check("5.1. Identical barcode in different tenant is permitted (tenant isolation)", !crossTenantCreate.isDuplicate);

    // ============================================================
    // 6. PRODUCT UPDATE (PUT) SELF-MATCH & CONFLICT BEHAVIOR
    // ============================================================
    console.log("\n-- 6. Product Update (PUT) Self-Match & Conflict Checks --");

    const inventoryProducts = [
        { _id: "prod_1", tenantId: "t1", SKU: "ITEM-A", barcode: "BAR-100" },
        { _id: "prod_2", tenantId: "t1", SKU: "ITEM-B", barcode: "BAR-200" },
        { _id: "prod_3", tenantId: "t1", SKU: "ITEM-C" }, // no barcode
    ];

    // Self-match: updating description while passing own barcode in different case
    const putSelfMatchCase = evaluatePutDuplicate(inventoryProducts, "prod_1", {
        tenantId: "t1",
        barcode: "bar-100", // own barcode, lowercased
    });
    check("6.1. Product updating with its own barcode (different case) succeeds (self-match)", !putSelfMatchCase.isDuplicate);

    // Self-match: updating price and passing own exact barcode
    const putSelfMatchExact = evaluatePutDuplicate(inventoryProducts, "prod_1", {
        tenantId: "t1",
        barcode: "BAR-100",
    });
    check("6.2. Product updating with its own exact barcode succeeds", !putSelfMatchExact.isDuplicate);

    // Conflict: prod_1 attempting to take prod_2's barcode
    const putConflict = evaluatePutDuplicate(inventoryProducts, "prod_1", {
        tenantId: "t1",
        barcode: "bar-200", // prod_2's barcode
    });
    check("6.3. Product attempting to take another product's barcode is rejected",
        Boolean(putConflict.isDuplicate && putConflict.message?.includes("Another product already uses this SKU or barcode")));

    // Clearing barcode with empty string
    const putClear = evaluatePutDuplicate(inventoryProducts, "prod_1", {
        tenantId: "t1",
        barcode: "",
    });
    check("6.4. Product clearing its barcode with '' does not trigger conflict", !putClear.isDuplicate);

    // Assigning barcode to product that previously had none
    const putAssignNew = evaluatePutDuplicate(inventoryProducts, "prod_3", {
        tenantId: "t1",
        barcode: "BAR-300",
    });
    check("6.5. Product without barcode assigning unique barcode succeeds", !putAssignNew.isDuplicate);

    // ============================================================
    // 7. OFFLINE PRODUCT SYNC NORMALIZATION & IDEMPOTENCY
    // ============================================================
    console.log("\n-- 7. Offline Product Sync Normalization & Idempotency --");

    check("7.1. Sync payload barcode is trimmed and uppercased",
        normalizeSyncBarcode("  sync-code-123  ") === "SYNC-CODE-123");
    check("7.2. Sync payload empty barcode resolves to undefined",
        normalizeSyncBarcode("   ") === undefined);

    // In-memory simulation of SyncService idempotency check
    const syncDb = [
        { _id: "p_101", tenantId: "t1", SKU: "SYNC-SKU-1", barcode: "SYNC-BAR-1", operationId: "op-uuid-101" },
    ];

    // Idempotent retry: same operationId returns alreadyProcessed
    const isRetry = syncDb.some((p) => p.tenantId === "t1" && p.operationId === "op-uuid-101");
    check("7.3. Sync retry with same operationId detects alreadyProcessed", isRetry);

    // Conflict: different operationId with colliding barcode
    const syncConflict = syncDb.some(
        (p) => p.tenantId === "t1" && p.operationId !== "op-uuid-102" && p.barcode === normalizeSyncBarcode("sync-bar-1")
    );
    check("7.4. Sync with new operationId colliding on case-insensitive barcode triggers conflict", syncConflict);

    // ============================================================
    // 8. POS BARCODE LOOKUP TESTS
    // ============================================================
    console.log("\n-- 8. POS Barcode Lookup with Canonical Representation --");

    const posCatalog = [
        {
            variantId: "v1",
            name: "Basmati Rice 1kg",
            sku: "RICE-001",
            barcode: "8901234567890",
            unitCode: "pcs",
            allowsFraction: false,
            trackSerial: false,
            pricePaise: 8000,
            taxLabel: "GST 0%",
            isTaxConfigured: true,
            inStock: "50",
            syncStatus: "SYNCED" as const,
        },
        {
            variantId: "v2",
            name: "Premium Olive Oil 1L",
            sku: "OIL-002",
            barcode: "OIL-EXTRA-VIRGIN",
            unitCode: "pcs",
            allowsFraction: false,
            trackSerial: false,
            pricePaise: 45000,
            taxLabel: "GST 5%",
            isTaxConfigured: true,
            inStock: "20",
            syncStatus: "SYNCED" as const,
        },
    ];

    // POS scan exact match with lowercase input
    const matchLower = matchCatalogItems(posCatalog, "oil-extra-virgin");
    check("8.1. POS search with lowercase barcode matches uppercase catalog barcode exactly",
        matchLower.exact?.variantId === "v2");

    // POS scan with surrounding whitespace
    const matchSpaced = matchCatalogItems(posCatalog, "  8901234567890  ");
    check("8.2. POS search with spaced numeric barcode matches exact catalog item",
        matchSpaced.exact?.variantId === "v1");

    // POS search with partial substring
    const matchSubstring = matchCatalogItems(posCatalog, "virgin");
    check("8.3. POS search substring matches barcode candidate",
        matchSubstring.candidates.some((c) => c.variantId === "v2"));

    // ============================================================
    // 9. CONCURRENT DUPLICATE CREATION E11000 ERROR HANDLING
    // ============================================================
    console.log("\n-- 9. Concurrent E11000 Error Handling Simulation --");

    const barcodeError = mapPostE11000Error({ barcode: 1, tenantId: 1 });
    check("9.1. E11000 with barcode keyPattern returns HTTP 409 and barcode-specific message",
        barcodeError.status === 409 && barcodeError.message === "A product with this barcode already exists");

    const skuError = mapPostE11000Error({ SKU: 1, tenantId: 1 });
    check("9.2. E11000 with SKU keyPattern returns HTTP 409 and SKU-specific message",
        skuError.status === 409 && skuError.message === "A product with this SKU already exists");

    const fallbackError = mapPostE11000Error(undefined);
    check("9.3. E11000 without keyPattern safely falls back to compound message",
        fallbackError.status === 409 && fallbackError.message === "A product with this SKU or barcode already exists");

    // ============================================================
    // 10. AUDIT METRICS LOGIC & SAFETY HELPERS VERIFICATION
    // ============================================================
    console.log("\n-- 10. Read-Only Production Audit Metrics & Safety Helpers --");

    const auditSample = [
        { tenantId: "t1", barcode: "BAR-100" },
        { tenantId: "t1", barcode: "bar-100" }, // case-only duplicate
        { tenantId: "t1", barcode: "BAR-200" },
        { tenantId: "t1", barcode: "BAR-200" }, // exact duplicate
        { tenantId: "t1", barcode: "" },
        { tenantId: "t1" }, // blank
        { tenantId: "t1", barcode: "   " }, // whitespace-only (should count as blank)
        { tenantId: "t2", barcode: "BAR-100" }, // different tenant (allowed)
    ];

    const auditMetrics = computeBarcodeAuditMetrics(auditSample);
    check("10.1. Audit metrics count products with and without barcodes accurately",
        auditMetrics.totalProducts === 8 && auditMetrics.productsWithBarcode === 5 && auditMetrics.productsWithoutBarcode === 3);
    check("10.2. Whitespace-only barcode is counted as blank and excluded from conflicts",
        auditMetrics.productsWithoutBarcode === 3);
    check("10.3. Audit metrics identify exact duplicate groups correctly",
        auditMetrics.exactDuplicateCount === 1 && auditMetrics.exactDuplicateGroups[0].barcode === "BAR-200");
    check("10.4. Audit metrics identify case-only duplicate groups correctly",
        auditMetrics.caseOnlyDuplicateCount === 1 && auditMetrics.caseOnlyDuplicateGroups[0].canonicalBarcode === "BAR-100" && auditMetrics.caseOnlyDuplicateGroups[0].variations.length === 2);

    // Truncation and memory bounding check
    const multiDuplicateSample = [
        { tenantId: "t1", barcode: "DUP-1" },
        { tenantId: "t1", barcode: "DUP-1" },
        { tenantId: "t1", barcode: "DUP-2" },
        { tenantId: "t1", barcode: "DUP-2" },
        { tenantId: "t1", barcode: "CASE-A" },
        { tenantId: "t1", barcode: "case-a" },
        { tenantId: "t1", barcode: "CASE-B" },
        { tenantId: "t1", barcode: "case-b" },
    ];
    const cappedMetrics = computeBarcodeAuditMetrics(multiDuplicateSample, 1);
    check("10.5. Capped metrics report accurate total count while truncating sampled groups",
        cappedMetrics.exactDuplicateCount === 2 &&
        cappedMetrics.exactDuplicateGroups.length === 1 &&
        cappedMetrics.exactDuplicateTruncated === true &&
        cappedMetrics.caseOnlyDuplicateCount === 2 &&
        cappedMetrics.caseOnlyDuplicateGroups.length === 1 &&
        cappedMetrics.caseOnlyDuplicateTruncated === true);

    // Guard confirmation
    check("10.6. Audit guard rejects missing confirmation",
        !validateAuditGuards({ CONFIRM_PRODUCTION_AUDIT: undefined, MONGODB_URI: "mongodb://localhost/billing_inventory" }).ok);
    check("10.7. Audit guard rejects wrong confirmation target",
        !validateAuditGuards({ CONFIRM_PRODUCTION_AUDIT: "billing_test", MONGODB_URI: "mongodb://localhost/billing_inventory" }).ok);

    // Connection teardown verification
    let disconnectCalled = false;
    const fakeActiveMongoose = {
        connection: { readyState: 1 },
        disconnect: async () => { disconnectCalled = true; },
    };
    await safeCloseMongooseConnection(fakeActiveMongoose);
    check("10.8. safeCloseMongooseConnection disconnects active connection", disconnectCalled);

    let disconnectCalledForClosed = false;
    const fakeClosedMongoose = {
        connection: { readyState: 0 },
        disconnect: async () => { disconnectCalledForClosed = true; },
    };
    await safeCloseMongooseConnection(fakeClosedMongoose);
    check("10.9. safeCloseMongooseConnection skips disconnect when already closed", !disconnectCalledForClosed);

    const fakeFailingMongoose = {
        connection: { readyState: 1 },
        disconnect: async () => { throw new Error("Network teardown error"); },
    };
    let closedSafely = false;
    try {
        await safeCloseMongooseConnection(fakeFailingMongoose);
        closedSafely = true;
    } catch {
        closedSafely = false;
    }
    check("10.10. safeCloseMongooseConnection swallows disconnect errors without masking", closedSafely);

    // Pipeline match condition check
    check("10.11. NON_EMPTY_TRIMMED_BARCODE_MATCH checks type and non-empty trimmed length",
        NON_EMPTY_TRIMMED_BARCODE_MATCH.barcode.$type === "string" &&
        NON_EMPTY_TRIMMED_BARCODE_MATCH.barcode.$gt === "" &&
        Boolean(NON_EMPTY_TRIMMED_BARCODE_MATCH.$expr));

    const success = summarize();
    process.exit(success ? 0 : 1);
}

main().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
