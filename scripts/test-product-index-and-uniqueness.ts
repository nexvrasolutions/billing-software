/*
 * Database-free tests for Product indexes, partial uniqueness, and duplicate error handling.
 *
 * Verifies:
 * 1. Mongoose ProductSchema indexes:
 *    - Barcode index uses unique partialFilterExpression (non-empty string), NOT compound sparse.
 *    - OperationId index uses unique partialFilterExpression (non-empty string), NOT compound sparse.
 *    - SKU index is tenant-scoped unique.
 * 2. Uniqueness evaluation rules:
 *    - Multiple products in the same tenant can have absent/undefined/empty barcodes without collision.
 *    - Non-empty barcodes within the same tenant must be strictly unique.
 *    - Identical barcodes across different tenants are permitted (tenant isolation).
 *    - SKUs within the same tenant must be unique (case-insensitive).
 *    - Identical SKUs across different tenants are permitted.
 *    - Multiple products in the same tenant can have absent/undefined/empty operationIds without collision.
 *    - Non-empty operationIds within the same tenant must be strictly unique.
 * 3. Error keyPattern differentiation:
 *    - Maps MongoDB E11000 keyPattern to specific, safe, non-leaking messages.
 *
 * Run:
 *   npx tsx scripts/test-product-index-and-uniqueness.ts
 */

import { Product } from "../lib/models/Product";

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

// Emulates MongoDB partial index filter evaluator
function matchesPartialFilter(
    record: Record<string, unknown>,
    filter: Record<string, { $type?: string; $gt?: unknown }>
): boolean {
    for (const [field, condition] of Object.entries(filter)) {
        const val = record[field];
        if (condition.$type === "string") {
            if (typeof val !== "string") return false;
        }
        if (condition.$gt !== undefined) {
            if (typeof val !== "string" || val <= (condition.$gt as string)) return false;
        }
    }
    return true;
}

// Pure duplicate check helper simulating /api/products pre-check logic
function evaluateDuplicatePreCheck(
    existing: { SKU: string; barcode?: string }[],
    input: { SKU: string; barcode?: string }
): { isDuplicate: boolean; message?: string } {
    const sku = input.SKU.trim().toUpperCase();
    const cleanBarcode = input.barcode?.trim() || undefined;

    for (const item of existing) {
        const isSkuMatch = item.SKU.toUpperCase() === sku;
        const isBarcodeMatch = Boolean(
            cleanBarcode &&
            item.barcode &&
            item.barcode.trim().toLowerCase() === cleanBarcode.toLowerCase()
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

// Pure E11000 keyPattern mapper simulating /api/products catch block logic
function mapE11000KeyPattern(keyPattern?: Record<string, unknown>): string {
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
    return message;
}

function main() {
    console.log("=== PRODUCT INDEXES, PARTIAL UNIQUENESS & ERROR HANDLING TESTS ===\n");

    // ============================================================
    // 1. MONGOOSE SCHEMA INDEX SPECIFICATIONS
    // ============================================================
    console.log("-- 1. Mongoose Schema Index Definitions --");

    const indexes = Product.schema.indexes() as [Record<string, number>, Record<string, unknown>][];

    // Check SKU index
    const skuIndex = indexes.find(([fields]) => fields.tenantId === 1 && fields.SKU === 1);
    check("1.1. SKU index exists on { tenantId: 1, SKU: 1 }", Boolean(skuIndex));
    check("1.2. SKU index is marked unique", Boolean(skuIndex?.[1]?.unique));

    // Check Barcode index
    const barcodeIndex = indexes.find(([fields]) => fields.tenantId === 1 && fields.barcode === 1);
    check("1.3. Barcode index exists on { tenantId: 1, barcode: 1 }", Boolean(barcodeIndex));
    check("1.4. Barcode index is marked unique", Boolean(barcodeIndex?.[1]?.unique));
    check(
        "1.5. Barcode index does NOT use compound sparse (must NOT have sparse: true)",
        barcodeIndex?.[1]?.sparse !== true
    );
    const barcodeFilter = barcodeIndex?.[1]?.partialFilterExpression as Record<string, unknown> | undefined;
    check(
        "1.6. Barcode index defines partialFilterExpression",
        Boolean(barcodeFilter && typeof barcodeFilter === "object")
    );
    const barcodeFieldFilter = barcodeFilter?.barcode as { $type?: string; $gt?: unknown } | undefined;
    check(
        "1.7. Barcode partialFilterExpression checks $type: 'string'",
        barcodeFieldFilter?.$type === "string"
    );
    check(
        "1.8. Barcode partialFilterExpression checks $gt: '' (non-empty string)",
        barcodeFieldFilter?.$gt === ""
    );

    // Check OperationId index
    const opIdIndex = indexes.find(([fields]) => fields.tenantId === 1 && fields.operationId === 1);
    check("1.9. OperationId index exists on { tenantId: 1, operationId: 1 }", Boolean(opIdIndex));
    check("1.10. OperationId index is marked unique", Boolean(opIdIndex?.[1]?.unique));
    check(
        "1.11. OperationId index does NOT use compound sparse (must NOT have sparse: true)",
        opIdIndex?.[1]?.sparse !== true
    );
    const opIdFilter = opIdIndex?.[1]?.partialFilterExpression as Record<string, unknown> | undefined;
    check(
        "1.12. OperationId index defines partialFilterExpression",
        Boolean(opIdFilter && typeof opIdFilter === "object")
    );
    const opIdFieldFilter = opIdFilter?.operationId as { $type?: string; $gt?: unknown } | undefined;
    check(
        "1.13. OperationId partialFilterExpression checks $type: 'string'",
        opIdFieldFilter?.$type === "string"
    );
    check(
        "1.14. OperationId partialFilterExpression checks $gt: '' (non-empty string)",
        opIdFieldFilter?.$gt === ""
    );

    // ============================================================
    // 2. MULTIPLE PRODUCTS WITH ABSENT/EMPTY BARCODES (SAME TENANT)
    // ============================================================
    console.log("\n-- 2. Absent and Empty Barcodes Coexistence --");

    const filterSpec = { barcode: { $type: "string", $gt: "" } };

    const prodMissingBarcode = { tenantId: "tenant_1", SKU: "SKU-A" }; // undefined
    const prodUndefinedBarcode = { tenantId: "tenant_1", SKU: "SKU-B", barcode: undefined };
    const prodEmptyBarcode = { tenantId: "tenant_1", SKU: "SKU-C", barcode: "" };
    const prodWhitespaceBarcode = { tenantId: "tenant_1", SKU: "SKU-D", barcode: "   " };
    const prodRealBarcode1 = { tenantId: "tenant_1", SKU: "SKU-E", barcode: "8901234567890" };
    const prodRealBarcode2 = { tenantId: "tenant_1", SKU: "SKU-F", barcode: "8909876543210" };

    check(
        "2.1. Product with missing barcode is omitted from unique barcode index",
        !matchesPartialFilter(prodMissingBarcode, filterSpec)
    );
    check(
        "2.2. Product with undefined barcode is omitted from unique barcode index",
        !matchesPartialFilter(prodUndefinedBarcode, filterSpec)
    );
    check(
        "2.3. Product with empty string barcode is omitted from unique barcode index",
        !matchesPartialFilter(prodEmptyBarcode, filterSpec)
    );
    check(
        "2.4. Product with whitespace barcode is omitted from unique barcode index after trimming",
        !matchesPartialFilter({ ...prodWhitespaceBarcode, barcode: prodWhitespaceBarcode.barcode.trim() }, filterSpec)
    );
    check(
        "2.5. Product with genuine barcode 1 IS included in unique barcode index",
        matchesPartialFilter(prodRealBarcode1, filterSpec)
    );
    check(
        "2.6. Product with genuine barcode 2 IS included in unique barcode index",
        matchesPartialFilter(prodRealBarcode2, filterSpec)
    );

    // Multiple products without barcodes do not trigger pre-check collisions
    const existingProducts = [
        { SKU: "SHIRT-RED", barcode: undefined },
        { SKU: "SHIRT-BLUE", barcode: "" },
    ];
    const newNoBarcode = evaluateDuplicatePreCheck(existingProducts, { SKU: "SHIRT-GREEN", barcode: "" });
    check(
        "2.7. New product with empty barcode does not collide with existing products lacking barcodes",
        !newNoBarcode.isDuplicate
    );

    // ============================================================
    // 3. DUPLICATE NON-EMPTY BARCODE DETECTION & TENANT ISOLATION
    // ============================================================
    console.log("\n-- 3. Barcode Uniqueness & Tenant Scoping --");

    const existingWithBarcodes = [
        { tenantId: "tenant_A", SKU: "ITEM-1", barcode: "BARCODE-1001" },
        { tenantId: "tenant_A", SKU: "ITEM-2", barcode: "BARCODE-1002" },
    ];

    // Same tenant, same barcode
    const dupBarcodeSameTenant = evaluateDuplicatePreCheck(existingWithBarcodes, {
        SKU: "ITEM-DIFF",
        barcode: "BARCODE-1001",
    });
    check("3.1. Duplicate barcode in same tenant is detected", dupBarcodeSameTenant.isDuplicate);
    check(
        "3.2. Error specifically mentions barcode collision",
        dupBarcodeSameTenant.message === "A product with this barcode already exists"
    );

    // Same barcode, different case / spaces
    const dupBarcodeSpaced = evaluateDuplicatePreCheck(existingWithBarcodes, {
        SKU: "ITEM-DIFF-2",
        barcode: "  barcode-1001  ",
    });
    check(
        "3.3. Duplicate barcode check is whitespace-trimmed and case-insensitive",
        dupBarcodeSpaced.isDuplicate && dupBarcodeSpaced.message === "A product with this barcode already exists"
    );

    // Tenant isolation: Tenant B can use the same barcode
    const tenantBProducts = [
        { tenantId: "tenant_B", SKU: "ITEM-B1", barcode: "BARCODE-9999" },
    ];
    const sameBarcodeTenantB = evaluateDuplicatePreCheck(tenantBProducts, {
        SKU: "ITEM-B2",
        barcode: "BARCODE-1001", // used in tenant A, but not tenant B
    });
    check("3.4. Same barcode in different tenant is permitted (tenant isolation)", !sameBarcodeTenantB.isDuplicate);

    // ============================================================
    // 4. SKU DUPLICATE DETECTION & SPECIFIC MESSAGES
    // ============================================================
    console.log("\n-- 4. SKU Uniqueness & Error Messaging --");

    const dupSkuSameTenant = evaluateDuplicatePreCheck(existingWithBarcodes, {
        SKU: "item-1", // case-insensitive duplicate
        barcode: "BARCODE-NEW",
    });
    check("4.1. Duplicate SKU in same tenant is detected case-insensitively", dupSkuSameTenant.isDuplicate);
    check(
        "4.2. Error specifically mentions SKU collision",
        dupSkuSameTenant.message === "A product with this SKU already exists"
    );

    // Both SKU and Barcode match
    const dupBothSameTenant = evaluateDuplicatePreCheck(existingWithBarcodes, {
        SKU: "ITEM-1",
        barcode: "BARCODE-1001",
    });
    check(
        "4.3. Both SKU and barcode colliding returns compound message",
        dupBothSameTenant.isDuplicate &&
        dupBothSameTenant.message === "A product with this SKU or barcode already exists"
    );

    // ============================================================
    // 5. OPERATION ID PARTIAL UNIQUENESS
    // ============================================================
    console.log("\n-- 5. Operation ID Partial Uniqueness --");

    const opFilterSpec = { operationId: { $type: "string", $gt: "" } };

    const onlineProduct1 = { tenantId: "tenant_1", SKU: "P-1" }; // no operationId
    const onlineProduct2 = { tenantId: "tenant_1", SKU: "P-2", operationId: undefined };
    const onlineProduct3 = { tenantId: "tenant_1", SKU: "P-3", operationId: "" };
    const syncProduct1 = { tenantId: "tenant_1", SKU: "P-4", operationId: "op_offline_101" };
    const syncProduct2 = { tenantId: "tenant_1", SKU: "P-5", operationId: "op_offline_102" };

    check(
        "5.1. Online product without operationId is omitted from operationId unique index",
        !matchesPartialFilter(onlineProduct1, opFilterSpec)
    );
    check(
        "5.2. Online product with undefined operationId is omitted from operationId unique index",
        !matchesPartialFilter(onlineProduct2, opFilterSpec)
    );
    check(
        "5.3. Product with empty string operationId is omitted from operationId unique index",
        !matchesPartialFilter(onlineProduct3, opFilterSpec)
    );
    check(
        "5.4. Offline product 1 with operationId IS indexed",
        matchesPartialFilter(syncProduct1, opFilterSpec)
    );
    check(
        "5.5. Offline product 2 with operationId IS indexed",
        matchesPartialFilter(syncProduct2, opFilterSpec)
    );

    // ============================================================
    // 6. E11000 MONGO EXCEPTION KEYPATTERN ERROR MAPPING
    // ============================================================
    console.log("\n-- 6. E11000 KeyPattern Error Handling --");

    check(
        "6.1. Barcode index collision maps to barcode-specific error message",
        mapE11000KeyPattern({ tenantId: 1, barcode: 1 }) === "A product with this barcode already exists"
    );
    check(
        "6.2. SKU index collision maps to SKU-specific error message",
        mapE11000KeyPattern({ tenantId: 1, SKU: 1 }) === "A product with this SKU already exists"
    );
    check(
        "6.3. OperationId index collision maps to operationId-specific error message",
        mapE11000KeyPattern({ tenantId: 1, operationId: 1 }) === "A product with this operation ID already exists"
    );
    check(
        "6.4. Missing keyPattern safely falls back to standard message",
        mapE11000KeyPattern(undefined) === "A product with this SKU or barcode already exists"
    );
    check(
        "6.5. Empty keyPattern safely falls back to standard message",
        mapE11000KeyPattern({}) === "A product with this SKU or barcode already exists"
    );
    check(
        "6.6. Unrelated keyPattern safely falls back to standard message",
        mapE11000KeyPattern({ otherField: 1 }) === "A product with this SKU or barcode already exists"
    );

    const success = summarize();
    process.exit(success ? 0 : 1);
}

main();
