/**
 * Database-Free Test Suite: Phase 3 — Product Numeric Validation and CSV Parsing
 * (NO MONGODB, NO ATLAS, NO LIVE SERVERS, NO BROWSER STORAGE MUTATIONS)
 *
 * Covers:
 * 1. Numeric validation & finite parsing (lib/validations/product.ts):
 *    - Valid finite numbers (0, positive floats, scientific notation).
 *    - Valid numeric strings ("0", "0.00", "42.5", "100").
 *    - Rejection of non-finite numbers (Infinity, -Infinity, NaN).
 *    - Rejection of non-finite strings ("Infinity", "-Infinity", "+Infinity", "NaN").
 *    - Rejection of malformed strings ("", "   ", "abc", "12abc", "0x10").
 *    - Rejection of non-numeric types (null, undefined, boolean, object, array).
 * 2. RFC 4180 CSV parser (lib/csv.ts):
 *    - Commas inside quoted fields ("Product A, Large").
 *    - Escaped double quotes ("Product ""Special""" -> Product "Special").
 *    - Quoted fields containing CRLF and LF line breaks.
 *    - Line endings: CRLF (\r\n), LF (\n), and mixed.
 *    - Empty fields (middle empty) and trailing empty columns.
 *    - Clear errors for malformed quoting (unclosed quote at EOF, stray character after closing quote).
 * 3. Product CSV parser (lib/csv.ts):
 *    - Complete valid CSV import rows.
 *    - Preservation of valid zero selling price and purchase price.
 *    - Rejection of missing required headers (name, SKU, sellingPrice).
 *    - Rejection of missing required row fields (name, SKU, sellingPrice).
 *    - Strict non-conversion of malformed prices (does NOT silently turn "abc" or "-10" to 0).
 *    - Barcode normalization (uppercase, trimmed, undefined when empty).
 * 4. Product sync numeric validation (ProductSyncService.createProductFromSync):
 *    - Rejection of non-finite sellingPrice (Infinity, -Infinity, NaN, "abc", "", negative).
 *    - Acceptance of valid sellingPrice (0, positive numbers, numeric strings).
 *    - Rejection of non-finite purchasePrice (Infinity, -Infinity, NaN, "invalid", negative).
 *    - Acceptance of valid purchasePrice (0, positive numbers, omitted).
 *    - Rejection of non-finite taxRate (Infinity, -Infinity, NaN, "abc", negative, > 100).
 *    - Acceptance of boundary taxRate (0, 18, 100, omitted).
 *    - Rejection of non-finite initialStock / openingStock (Infinity, -Infinity, NaN, "bad", negative).
 *    - Acceptance of valid initialStock / openingStock (0, positive numbers, omitted).
 *    - Rejection of non-finite stockQuantity and reorderLevel when passed in payload.
 *    - Safe failure: invalid payloads create no products, audit logs, or stock movements.
 *    - Idempotency: retries with existing operationId return alreadyProcessed: true.
 * 5. Dexie offline product cache (savePendingOfflineProduct):
 *    - Rejection of non-finite sellingPrice, stockQuantity, taxRate.
 *    - Acceptance of finite values and valid 0.
 *
 * Run:
 *   npx tsx scripts/test-product-validation-phase3.ts
 */

import mongoose from "mongoose";
import { parseFiniteNumber } from "../lib/validations/product";
import { parseCsv, parseProductCsv, CsvParseError } from "../lib/csv";
import { Product } from "../lib/models/Product";
import { Category } from "../lib/models/Category";
import { Unit } from "../lib/models/Unit";
import { AuditLogService } from "../lib/services/AuditLogService";
import { StockService } from "../lib/services/StockService";
import { ProductSyncService } from "../lib/services/ProductSyncService";
import { SyncProcessError } from "../lib/services/SyncErrors";
import { savePendingOfflineProduct } from "../lib/offline/productCatalogueCache";
import type { OfflineDatabase } from "../lib/offline/db";

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
    console.log(`PHASE 3 TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory mock Dexie database for testing savePendingOfflineProduct
function createMemoryOfflineDb() {
    const cachedProductsMap = new Map<string, any>();

    const db = {
        cachedProducts: {
            get: async (id: string) => cachedProductsMap.get(id),
            put: async (record: any) => {
                cachedProductsMap.set(record.id, record);
                return record.id;
            },
            where: (field: string) => ({
                equals: (val: any) => ({
                    toArray: async () => {
                        return Array.from(cachedProductsMap.values()).filter((p) => p[field] === val);
                    },
                }),
            }),
        },
        transaction: async (_mode: string, _table: any, callback: () => Promise<any>) => {
            return await callback();
        },
    } as unknown as OfflineDatabase;

    return { db, cachedProductsMap };
}

async function runTests() {
    console.log("=== PHASE 3: PRODUCT NUMERIC VALIDATION AND CSV PARSING TESTS ===\n");

    // ============================================================
    // SECTION 1: Numeric Parsing & Finite Validation
    // ============================================================
    console.log("-- 1. parseFiniteNumber Unit Tests --");

    // 1.1 Valid finite numbers
    check("1.1.1. Zero number (0) is valid and returns 0", parseFiniteNumber(0) === 0);
    check("1.1.2. Positive integer (42) returns 42", parseFiniteNumber(42) === 42);
    check("1.1.3. Positive float (99.95) returns 99.95", parseFiniteNumber(99.95) === 99.95);
    check("1.1.4. Negative number (-10) returns -10", parseFiniteNumber(-10) === -10);

    // 1.2 Valid numeric strings
    check("1.2.1. Zero string '0' returns 0", parseFiniteNumber("0") === 0);
    check("1.2.2. Decimal zero string '0.00' returns 0", parseFiniteNumber("0.00") === 0);
    check("1.2.3. Integer string '100' returns 100", parseFiniteNumber("100") === 100);
    check("1.2.4. Float string '12.34' returns 12.34", parseFiniteNumber("12.34") === 12.34);
    check("1.2.5. Whitespace padded string '  50.5  ' returns 50.5", parseFiniteNumber("  50.5  ") === 50.5);
    check("1.2.6. Scientific notation '1e3' returns 1000", parseFiniteNumber("1e3") === 1000);
    check("1.2.7. Negative string '-5' returns -5", parseFiniteNumber("-5") === -5);

    // 1.3 Non-finite numbers rejected
    check("1.3.1. Infinity returns null", parseFiniteNumber(Infinity) === null);
    check("1.3.2. -Infinity returns null", parseFiniteNumber(-Infinity) === null);
    check("1.3.3. NaN returns null", parseFiniteNumber(NaN) === null);

    // 1.4 Non-finite strings rejected
    check("1.4.1. String 'Infinity' returns null", parseFiniteNumber("Infinity") === null);
    check("1.4.2. String '+Infinity' returns null", parseFiniteNumber("+Infinity") === null);
    check("1.4.3. String '-Infinity' returns null", parseFiniteNumber("-Infinity") === null);
    check("1.4.4. String 'NaN' returns null", parseFiniteNumber("NaN") === null);

    // 1.5 Malformed strings rejected
    check("1.5.1. Empty string '' returns null", parseFiniteNumber("") === null);
    check("1.5.2. Whitespace-only string '   ' returns null", parseFiniteNumber("   ") === null);
    check("1.5.3. Alpha string 'abc' returns null", parseFiniteNumber("abc") === null);
    check("1.5.4. Suffix garbage '100abc' returns null", parseFiniteNumber("100abc") === null);
    check("1.5.5. Prefix garbage 'abc100' returns null", parseFiniteNumber("abc100") === null);
    check("1.5.6. Hex string '0x10' returns null", parseFiniteNumber("0x10") === null);
    check("1.5.7. Double sign '--10' returns null", parseFiniteNumber("--10") === null);

    // 1.6 Non-numeric types rejected
    check("1.6.1. null returns null", parseFiniteNumber(null) === null);
    check("1.6.2. undefined returns null", parseFiniteNumber(undefined) === null);
    check("1.6.3. Boolean true returns null", parseFiniteNumber(true) === null);
    check("1.6.4. Boolean false returns null", parseFiniteNumber(false) === null);
    check("1.6.5. Object {} returns null", parseFiniteNumber({}) === null);
    check("1.6.6. Array [] returns null", parseFiniteNumber([]) === null);

    // ============================================================
    // SECTION 2: RFC 4180 CSV Parser (lib/csv.ts)
    // ============================================================
    console.log("\n-- 2. RFC 4180 parseCsv Unit Tests --");

    // 2.1 Basic rows
    const basicCsv = "name,SKU,price\nApple,APPL,10\nBanana,BANA,5";
    const basicGrid = parseCsv(basicCsv);
    check("2.1.1. Basic CSV parsed with 3 rows", basicGrid.length === 3);
    check("2.1.2. Row 0 columns correct", basicGrid[0].join(",") === "name,SKU,price");
    check("2.1.3. Row 1 values correct", basicGrid[1].join(",") === "Apple,APPL,10");

    // 2.2 Quoted fields containing commas
    const quotedCommaCsv = 'name,SKU,price\n"Product A, Large",SKU-001,110\n"Product B, Medium",SKU-002,90';
    const quotedCommaGrid = parseCsv(quotedCommaCsv);
    check("2.2.1. Quoted field with comma parses correctly", quotedCommaGrid[1][0] === "Product A, Large");
    check("2.2.2. Row contains expected number of columns (3)", quotedCommaGrid[1].length === 3);

    // 2.3 Escaped double quotes ("" -> ")
    const escapedQuoteCsv = 'name,SKU,price\n"Product ""Special""",SKU-003,150';
    const escapedQuoteGrid = parseCsv(escapedQuoteCsv);
    check("2.3.1. Escaped quote resolves to single quote", escapedQuoteGrid[1][0] === 'Product "Special"');

    // 2.4 Quoted fields containing line breaks
    const multiLineCsv = 'name,SKU,price\n"Multi-line\nProduct\nDescription",SKU-004,200';
    const multiLineGrid = parseCsv(multiLineCsv);
    check("2.4.1. Embedded newline preserved inside quoted field", multiLineGrid[1][0] === "Multi-line\nProduct\nDescription");
    check("2.4.2. Entire multiline item stays in single row", multiLineGrid.length === 2);

    // 2.5 CRLF and LF line endings
    const crlfCsv = "name,SKU\r\nA,SKU-A\r\nB,SKU-B\r\n";
    const crlfGrid = parseCsv(crlfCsv);
    check("2.5.1. CRLF line endings parse cleanly", crlfGrid.length === 3);
    check("2.5.2. CRLF trailing newline does not create extra blank row", crlfGrid[2][0] === "B");

    const mixedCsv = "name,SKU\r\nA,SKU-A\nB,SKU-B";
    const mixedGrid = parseCsv(mixedCsv);
    check("2.5.3. Mixed CRLF and LF line endings handled seamlessly", mixedGrid.length === 3);

    // 2.6 Empty fields and trailing empty columns
    const emptyColsCsv = "name,SKU,price,barcode\nApple,APPL-1,,\n";
    const emptyColsGrid = parseCsv(emptyColsCsv);
    check("2.6.1. Middle empty field parsed as empty string", emptyColsGrid[1][2] === "");
    check("2.6.2. Trailing empty column parsed as empty string", emptyColsGrid[1][3] === "");
    check("2.6.3. Row preserves exact 4 column count", emptyColsGrid[1].length === 4);

    // 2.7 Malformed quoting error reporting
    let unclosedError: CsvParseError | null = null;
    try {
        parseCsv('name,SKU\n"Unclosed Product,SKU-001');
    } catch (e: any) {
        unclosedError = e;
    }
    check("2.7.1. Unclosed quote throws CsvParseError", unclosedError instanceof CsvParseError);
    check("2.7.2. Unclosed quote error specifies unclosed quote", Boolean(unclosedError?.message.includes("Unclosed quoted field")));

    let strayCharError: CsvParseError | null = null;
    try {
        parseCsv('name,SKU\n"Product"Extra,SKU-001');
    } catch (e: any) {
        strayCharError = e;
    }
    check("2.7.3. Stray characters after closing quote throws CsvParseError", strayCharError instanceof CsvParseError);
    check("2.7.4. Stray character error mentions unexpected character", Boolean(strayCharError?.message.includes("after closing quote")));

    // ============================================================
    // SECTION 3: Product CSV Parser (parseProductCsv)
    // ============================================================
    console.log("\n-- 3. Product CSV Parser (parseProductCsv) Unit Tests --");

    // 3.1 Complete valid CSV with quotes and optional columns
    const fullValidCsv = `name,SKU,purchasePrice,sellingPrice,barcode
"Basmati Rice, 1kg",RICE-001,80,110,"8901234567890"
"Sunflower Oil ""Premium""",OIL-001,120,150,
"Organic Sugar",SUGAR-001,,45,8901234567892`;

    const fullValidResult = parseProductCsv(fullValidCsv);
    check("3.1.1. Valid CSV parses with success: true", fullValidResult.success === true);
    check("3.1.2. 3 products parsed", fullValidResult.rows.length === 3);
    check("3.1.3. Quoted comma in name parsed", fullValidResult.rows[0].name === "Basmati Rice, 1kg");
    check("3.1.4. Escaped quotes in name parsed", fullValidResult.rows[1].name === 'Sunflower Oil "Premium"');
    check("3.1.5. Trailing empty barcode resolves to undefined", fullValidResult.rows[1].barcode === undefined);
    check("3.1.6. Omitted purchasePrice defaults to 0", fullValidResult.rows[2].purchasePrice === 0);
    check("3.1.7. Selling price 45 parsed as number", fullValidResult.rows[2].sellingPrice === 45);

    // 3.2 Valid zero prices preserved
    const zeroPriceCsv = `name,SKU,purchasePrice,sellingPrice
"Free Sample",FREE-001,0,0
"Promotion Item",PROMO-001,10,0.00`;
    const zeroResult = parseProductCsv(zeroPriceCsv);
    check("3.2.1. Zero selling price parsed as 0 (not rejected)", zeroResult.success === true && zeroResult.rows[0].sellingPrice === 0);
    check("3.2.2. Zero purchase price parsed as 0", zeroResult.rows[0].purchasePrice === 0);
    check("3.2.3. Decimal zero '0.00' parsed as 0", zeroResult.rows[1].sellingPrice === 0);

    // 3.3 Rejection of missing required headers
    const missingHeaderCsv = "name,purchasePrice\nApple,50";
    const missingHeaderResult = parseProductCsv(missingHeaderCsv);
    check("3.3.1. Missing SKU and sellingPrice headers rejected", missingHeaderResult.success === false);
    check("3.3.2. Clear header error returned", missingHeaderResult.errors[0].includes("CSV header must include at least"));

    // 3.4 Rejection of missing row data
    const missingDataCsv = `name,SKU,sellingPrice
,SKU-MISSING,50
Valid Name,,50
Valid Name,SKU-OK,`;
    const missingDataResult = parseProductCsv(missingDataCsv);
    check("3.4.1. Missing data rows produce errors", missingDataResult.success === false);
    check("3.4.2. Empty name caught", missingDataResult.errors.some((e) => e.includes("Product name is required")));
    check("3.4.3. Empty SKU caught", missingDataResult.errors.some((e) => e.includes("Product SKU is required")));
    check("3.4.4. Empty selling price caught", missingDataResult.errors.some((e) => e.includes("Selling price is required")));

    // 3.5 Malformed prices NOT silently converted to zero
    const malformedPriceCsv = `name,SKU,purchasePrice,sellingPrice
Item A,SKU-A,50,invalid
Item B,SKU-B,bad,100
Item C,SKU-C,0,-15
Item D,SKU-D,0,Infinity`;
    const malformedPriceResult = parseProductCsv(malformedPriceCsv);
    check("3.5.1. Malformed prices rejected (not converted to 0)", malformedPriceResult.success === false);
    check("3.5.2. 'invalid' selling price rejected", malformedPriceResult.errors.some((e) => e.includes('Invalid selling price "invalid"')));
    check("3.5.3. 'bad' purchase price rejected", malformedPriceResult.errors.some((e) => e.includes('Invalid purchase price "bad"')));
    check("3.5.4. Negative selling price rejected", malformedPriceResult.errors.some((e) => e.includes('Invalid selling price "-15"')));
    check("3.5.5. 'Infinity' selling price rejected", malformedPriceResult.errors.some((e) => e.includes('Invalid selling price "Infinity"')));

    // 3.6 Barcode normalization
    const barcodeCsv = `name,SKU,sellingPrice,barcode
Item Lower,SKU-L,10,abc123xyz
Item Spaced,SKU-S,20,"  bar-456  "
Item Blank,SKU-B,30,"   "`;
    const barcodeResult = parseProductCsv(barcodeCsv);
    check("3.6.1. Lowercase barcode uppercased", barcodeResult.rows[0].barcode === "ABC123XYZ");
    check("3.6.2. Spaced barcode trimmed and uppercased", barcodeResult.rows[1].barcode === "BAR-456");
    check("3.6.3. Blank barcode resolves to undefined", barcodeResult.rows[2].barcode === undefined);

    // ============================================================
    // SECTION 4: ProductSyncService Server-Side Numeric Validation
    // ============================================================
    console.log("\n-- 4. ProductSyncService Server-Side Numeric Validation Tests --");

    const tenantId = new mongoose.Types.ObjectId("670c11111111111111111111");
    const userId = new mongoose.Types.ObjectId("670c22222222222222222222");
    const validCategoryId = new mongoose.Types.ObjectId("670c33333333333333333333");
    const validUnitId = new mongoose.Types.ObjectId("670c44444444444444444444");

    const userContext = { tenantId, userId };

    const mockProducts: any[] = [];
    const mockAuditLogs: any[] = [];
    const mockStockMovements: any[] = [];

    // Setup DB-free mocks for Mongoose models
    Product.findOne = ((query: any) => {
        let match: any = null;
        if (query.operationId) {
            match = mockProducts.find(
                (p) => p.tenantId.equals(query.tenantId) && p.operationId === query.operationId
            );
        } else if (query.$or) {
            match = mockProducts.find((p) => {
                if (!p.tenantId.equals(query.tenantId)) return false;
                for (const cond of query.$or) {
                    if (cond.SKU && p.SKU === cond.SKU) return true;
                    if (cond.barcode && p.barcode === cond.barcode) return true;
                }
                return false;
            });
        }
        return {
            select: () => ({
                lean: async () => match ? { ...match } : null,
            }),
            then: (resolve: any) => resolve(match ? { ...match } : null),
        };
    }) as any;

    Category.findOne = ((_query: any) => ({
        select: () => ({
            lean: async () => ({ _id: validCategoryId }),
        }),
    })) as any;

    Unit.findOne = ((_query: any) => ({
        select: () => ({
            lean: async () => ({ _id: validUnitId }),
        }),
    })) as any;

    mongoose.startSession = (async () => ({
        withTransaction: async (cb: () => Promise<any>) => await cb(),
        endSession: async () => {},
    })) as any;

    Product.create = (async (docs: any[]) => {
        const created = docs.map((d) => {
            const doc = {
                _id: new mongoose.Types.ObjectId(),
                ...d,
            };
            mockProducts.push(doc);
            return doc;
        });
        return created;
    }) as any;

    AuditLogService.createAuditLog = (async (ctx: any, log: any) => {
        mockAuditLogs.push({ ctx, log });
        return { _id: new mongoose.Types.ObjectId() };
    }) as any;

    StockService.changeStock = (async (ctx: any, input: any, _session: any, opId: string) => {
        mockStockMovements.push({ ctx, input, opId });
        return { _id: new mongoose.Types.ObjectId() };
    }) as any;

    const baseValidPayload = {
        name: "Test Product",
        SKU: "TEST-SKU-1",
        categoryId: validCategoryId.toString(),
        unitId: validUnitId.toString(),
        sellingPrice: 100,
        purchasePrice: 60,
    };

    // Helper to test rejection
    async function assertSyncRejection(
        testName: string,
        payloadOverrides: Record<string, unknown>,
        expectedMsgSubstring: string
    ) {
        const opId = `op_test_${Math.random().toString(36).substring(2, 9)}`;
        const productsBefore = mockProducts.length;
        const auditBefore = mockAuditLogs.length;
        const stockBefore = mockStockMovements.length;

        let thrownError: any = null;
        try {
            await ProductSyncService.createProductFromSync(
                userContext,
                { ...baseValidPayload, ...payloadOverrides },
                opId
            );
        } catch (e) {
            thrownError = e;
        }

        const isSyncError = thrownError instanceof SyncProcessError;
        const status422 = thrownError?.httpStatus === 422;
        const permanent = thrownError?.code === "PERMANENT_FAILURE";
        const messageMatch = thrownError?.message.includes(expectedMsgSubstring);
        const noProductCreated = mockProducts.length === productsBefore;
        const noAuditLogged = mockAuditLogs.length === auditBefore;
        const noStockMoved = mockStockMovements.length === stockBefore;

        const passed = isSyncError && status422 && permanent && messageMatch && noProductCreated && noAuditLogged && noStockMoved;
        check(
            testName,
            passed,
            !passed
                ? `Error: ${thrownError?.message || "No error"} (status: ${thrownError?.httpStatus}, created: ${mockProducts.length - productsBefore})`
                : undefined
        );
    }

    // 4.1 Reject non-finite sellingPrice
    await assertSyncRejection("4.1.1. sellingPrice: Infinity rejected with 422 PERMANENT_FAILURE", { sellingPrice: Infinity }, "selling price");
    await assertSyncRejection("4.1.2. sellingPrice: -Infinity rejected with 422 PERMANENT_FAILURE", { sellingPrice: -Infinity }, "selling price");
    await assertSyncRejection("4.1.3. sellingPrice: NaN rejected with 422 PERMANENT_FAILURE", { sellingPrice: NaN }, "selling price");
    await assertSyncRejection("4.1.4. sellingPrice: 'abc' rejected with 422 PERMANENT_FAILURE", { sellingPrice: "abc" }, "selling price");
    await assertSyncRejection("4.1.5. sellingPrice: '' rejected with 422 PERMANENT_FAILURE", { sellingPrice: "" }, "selling price");
    await assertSyncRejection("4.1.6. sellingPrice: '   ' rejected with 422 PERMANENT_FAILURE", { sellingPrice: "   " }, "selling price");
    await assertSyncRejection("4.1.7. sellingPrice: -10 rejected with 422 PERMANENT_FAILURE", { sellingPrice: -10 }, "selling price");

    // 4.2 Reject non-finite purchasePrice
    await assertSyncRejection("4.2.1. purchasePrice: Infinity rejected with 422 PERMANENT_FAILURE", { purchasePrice: Infinity }, "purchase price");
    await assertSyncRejection("4.2.2. purchasePrice: -Infinity rejected with 422 PERMANENT_FAILURE", { purchasePrice: -Infinity }, "purchase price");
    await assertSyncRejection("4.2.3. purchasePrice: NaN rejected with 422 PERMANENT_FAILURE", { purchasePrice: NaN }, "purchase price");
    await assertSyncRejection("4.2.4. purchasePrice: 'invalid' rejected with 422 PERMANENT_FAILURE", { purchasePrice: "invalid" }, "purchase price");
    await assertSyncRejection("4.2.5. purchasePrice: -5 rejected with 422 PERMANENT_FAILURE", { purchasePrice: -5 }, "purchase price");

    // 4.3 Reject non-finite taxRate
    await assertSyncRejection("4.3.1. taxRate: Infinity rejected with 422 PERMANENT_FAILURE", { taxRate: Infinity }, "Tax rate must be between 0 and 100");
    await assertSyncRejection("4.3.2. taxRate: -Infinity rejected with 422 PERMANENT_FAILURE", { taxRate: -Infinity }, "Tax rate must be between 0 and 100");
    await assertSyncRejection("4.3.3. taxRate: NaN rejected with 422 PERMANENT_FAILURE", { taxRate: NaN }, "Tax rate must be between 0 and 100");
    await assertSyncRejection("4.3.4. taxRate: 'abc' rejected with 422 PERMANENT_FAILURE", { taxRate: "abc" }, "Tax rate must be between 0 and 100");
    await assertSyncRejection("4.3.5. taxRate: 100.5 rejected with 422 PERMANENT_FAILURE", { taxRate: 100.5 }, "Tax rate must be between 0 and 100");
    await assertSyncRejection("4.3.6. taxRate: -1 rejected with 422 PERMANENT_FAILURE", { taxRate: -1 }, "Tax rate must be between 0 and 100");

    // 4.4 Reject non-finite initialStock / openingStock
    await assertSyncRejection("4.4.1. initialStock: Infinity rejected with 422 PERMANENT_FAILURE", { initialStock: Infinity }, "Opening stock");
    await assertSyncRejection("4.4.2. initialStock: -Infinity rejected with 422 PERMANENT_FAILURE", { initialStock: -Infinity }, "Opening stock");
    await assertSyncRejection("4.4.3. initialStock: NaN rejected with 422 PERMANENT_FAILURE", { initialStock: NaN }, "Opening stock");
    await assertSyncRejection("4.4.4. initialStock: 'bad' rejected with 422 PERMANENT_FAILURE", { initialStock: "bad" }, "Opening stock");
    await assertSyncRejection("4.4.5. initialStock: -1 rejected with 422 PERMANENT_FAILURE", { initialStock: -1 }, "Opening stock");
    await assertSyncRejection("4.4.6. openingStock: Infinity rejected with 422 PERMANENT_FAILURE", { openingStock: Infinity }, "Opening stock");

    // 4.5 Reject non-finite stockQuantity and reorderLevel
    await assertSyncRejection("4.5.1. stockQuantity: Infinity rejected with 422 PERMANENT_FAILURE", { stockQuantity: Infinity }, "Stock quantity");
    await assertSyncRejection("4.5.2. stockQuantity: -5 rejected with 422 PERMANENT_FAILURE", { stockQuantity: -5 }, "Stock quantity");
    await assertSyncRejection("4.5.3. reorderLevel: Infinity rejected with 422 PERMANENT_FAILURE", { reorderLevel: Infinity }, "Reorder level");
    await assertSyncRejection("4.5.4. reorderLevel: -1 rejected with 422 PERMANENT_FAILURE", { reorderLevel: -1 }, "Reorder level");

    // 4.6 Accept valid values and zero
    const validZeroRes = await ProductSyncService.createProductFromSync(
        userContext,
        {
            ...baseValidPayload,
            SKU: "SKU-ZERO-1",
            sellingPrice: 0,
            purchasePrice: 0,
            taxRate: 0,
            initialStock: 0,
        },
        "op_valid_zero_1"
    );
    check("4.6.1. Product created with valid 0 values for price, tax, and stock", Boolean(validZeroRes?._id));

    const validNonZeroRes = await ProductSyncService.createProductFromSync(
        userContext,
        {
            ...baseValidPayload,
            SKU: "SKU-VALID-2",
            sellingPrice: "149.99",
            purchasePrice: "89.50",
            taxRate: 18,
            initialStock: 25,
        },
        "op_valid_nonzero_2"
    );
    check("4.6.2. Product created with valid numeric strings and tax rate 18", Boolean(validNonZeroRes?._id));
    check("4.6.3. Stock movement created for positive initialStock", mockStockMovements.some((m) => m.opId.includes("op_valid_nonzero_2")));

    // 4.7 Idempotency check with valid/retry op
    const retryRes = await ProductSyncService.createProductFromSync(
        userContext,
        { ...baseValidPayload, SKU: "SKU-VALID-2" },
        "op_valid_nonzero_2"
    );
    check("4.7.1. Retry with same operationId returns alreadyProcessed: true", retryRes.alreadyProcessed === true);
    check("4.7.2. Same product ID returned", retryRes._id === validNonZeroRes._id);

    // ============================================================
    // SECTION 5: Dexie Offline Product Cache (savePendingOfflineProduct)
    // ============================================================
    console.log("\n-- 5. Dexie Offline Product Cache (savePendingOfflineProduct) Unit Tests --");

    const { db } = createMemoryOfflineDb();

    // 5.1 Reject non-finite sellingPrice in offline cache
    let offlineErr1: any = null;
    try {
        await savePendingOfflineProduct({
            tenantId: tenantId.toString(),
            productId: "prod_offline_1",
            name: "Bad Price Product",
            SKU: "BAD-1",
            sellingPrice: Infinity,
            operationId: "op_offline_1",
        }, db);
    } catch (e: any) {
        offlineErr1 = e;
    }
    check("5.1.1. savePendingOfflineProduct rejects Infinity sellingPrice", Boolean(offlineErr1));

    let offlineErr2: any = null;
    try {
        await savePendingOfflineProduct({
            tenantId: tenantId.toString(),
            productId: "prod_offline_2",
            name: "Bad Tax Product",
            SKU: "BAD-2",
            sellingPrice: 100,
            taxRate: 150,
            operationId: "op_offline_2",
        }, db);
    } catch (e: any) {
        offlineErr2 = e;
    }
    check("5.1.2. savePendingOfflineProduct rejects taxRate > 100", Boolean(offlineErr2));

    // 5.2 Accept valid offline product with zero price
    const validOfflineProduct = await savePendingOfflineProduct({
        tenantId: tenantId.toString(),
        productId: "prod_offline_ok",
        name: "Valid Offline Product",
        SKU: "OK-1",
        sellingPrice: 0,
        stockQuantity: 10,
        taxRate: 5,
        operationId: "op_offline_ok",
    }, db);
    check("5.2.1. savePendingOfflineProduct accepts valid finite numbers and sellingPrice 0", validOfflineProduct.sellingPrice === 0);
    check("5.2.2. Offline product saved with PENDING syncStatus", validOfflineProduct.syncStatus === "PENDING");

    return summarize();
}

runTests().then((success) => {
    process.exit(success ? 0 : 1);
});
