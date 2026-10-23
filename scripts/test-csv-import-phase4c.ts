/**
 * Database-Free Test Suite: Phase 4C — Fix CSV Product Import Idempotency
 * (NO MONGODB, NO ATLAS, NO LIVE SERVERS, NO BROWSER STORAGE MUTATIONS)
 *
 * Covers:
 * 1. Two different import batches containing the same SKU get different operation IDs.
 * 2. Retries within one batch retain the same operation ID across trims and casing.
 * 3. Duplicate normalized SKUs within one CSV file are detected and rejected at parse time with clear row numbers.
 * 4. Failed rows (400, 409, 500, network error) do NOT increment the success count and capture row details.
 * 5. A successful alreadyProcessed response for the SAME batch is counted correctly as success.
 * 6. Cross-batch duplicate SKU hits server 409 and is recorded as a failure rather than alreadyProcessed.
 * 7. Existing CSV parsing, opening-stock validation, and SKU normalization continue to pass.
 *
 * Run:
 *   npx tsx scripts/test-csv-import-phase4c.ts
 */

import { parseCsv, parseProductCsv, getCsvRowOperationId } from "../lib/csv";

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
    console.log(`PHASE 4C TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

async function run() {
    console.log("=== PHASE 4C: CSV PRODUCT IMPORT IDEMPOTENCY TESTS ===\n");

    // ============================================================
    // SECTION 1: Batch-Scoped Operation ID Differentiation
    // ============================================================
    console.log("-- 1. Batch-Scoped Operation ID Differentiation --");

    const batch1 = "batch-uuid-1111";
    const batch2 = "batch-uuid-2222";
    const sku = "SHIRT-001";

    const opBatch1 = getCsvRowOperationId(batch1, sku);
    const opBatch2 = getCsvRowOperationId(batch2, sku);

    check("1.1. Operation ID includes batch ID and normalized SKU", opBatch1 === "csv-import:batch-uuid-1111:SHIRT-001");
    check("1.2. Two different import batches get different operation IDs for same SKU", opBatch1 !== opBatch2);
    check("1.3. Batch 2 operation ID properly formatted", opBatch2 === "csv-import:batch-uuid-2222:SHIRT-001");

    // ============================================================
    // SECTION 2: Batch Retries Retain Stable Operation ID
    // ============================================================
    console.log("\n-- 2. Batch Retries Retain Stable Operation ID --");

    const opRetryExact = getCsvRowOperationId(batch1, "SHIRT-001");
    const opRetryLower = getCsvRowOperationId(batch1, "shirt-001");
    const opRetrySpaced = getCsvRowOperationId(batch1, "  Shirt-001  ");

    check("2.1. Exact retry within same batch produces identical operation ID", opRetryExact === opBatch1);
    check("2.2. Lowercase variation within same batch produces identical operation ID", opRetryLower === opBatch1);
    check("2.3. Whitespace-padded variation within same batch produces identical operation ID", opRetrySpaced === opBatch1);

    // ============================================================
    // SECTION 3: Duplicate Normalized SKUs Within One File
    // ============================================================
    console.log("\n-- 3. Duplicate Normalized SKUs Within One File --");

    const csvWithDuplicateSku = `name,SKU,sellingPrice
Product 1,SHIRT-01,100
Product 2,SHIRT-02,150
Product 3,shirt-01,120`;

    const dupResult = parseProductCsv(csvWithDuplicateSku);
    check("3.1. CSV with duplicate SKUs fails parsing", dupResult.success === false);
    check("3.2. No rows returned when duplicate SKUs exist", dupResult.rows.length === 0);
    check("3.3. Error identifies row 4 as duplicate", dupResult.errors.some((e) => e.includes("Row 4: Duplicate SKU \"SHIRT-01\"")));
    check("3.4. Error identifies row 2 as first occurrence", dupResult.errors.some((e) => e.includes("already appears on row 2")));

    const csvWithMultipleDuplicates = `name,SKU,sellingPrice
Item A,A-01,50
Item B,B-01,60
Item A Duplicate,a-01,55
Item B Duplicate,  B-01  ,65`;

    const multiDupResult = parseProductCsv(csvWithMultipleDuplicates);
    check("3.5. Multiple duplicate SKUs both reported", multiDupResult.errors.length === 2);
    check("3.6. First duplicate reports row 4 colliding with row 2", multiDupResult.errors.some((e) => e.includes("Row 4") && e.includes("A-01") && e.includes("row 2")));
    check("3.7. Second duplicate reports row 5 colliding with row 3", multiDupResult.errors.some((e) => e.includes("Row 5") && e.includes("B-01") && e.includes("row 3")));

    // Non-duplicate CSV parses successfully
    const csvDistinct = `name,SKU,sellingPrice
Item 1,SKU-1,10
Item 2,SKU-2,20
Item 3,SKU-3,30`;
    const distinctResult = parseProductCsv(csvDistinct);
    check("3.8. Distinct SKUs parse successfully", distinctResult.success === true && distinctResult.rows.length === 3);
    check("3.9. Row numbers preserved on parsed rows", distinctResult.rows[0].rowNumber === 2 && distinctResult.rows[1].rowNumber === 3 && distinctResult.rows[2].rowNumber === 4);

    // ============================================================
    // SECTION 4: Simulation of Import Execution & Outcome Reporting
    // ============================================================
    console.log("\n-- 4. Import Execution Outcome Reporting Simulation --");

    // In-memory simulation of the handleExecuteImport loop in app/catalog/import/page.tsx
    interface SimulatedProduct {
        _id: string;
        tenantId: string;
        SKU: string;
        operationId: string;
    }

    const serverProducts: SimulatedProduct[] = [];

    async function simulateServerCreate(tenantId: string, payload: any) {
        const { SKU, operationId } = payload;
        const normSku = SKU.trim().toUpperCase();

        // 1. Idempotency pre-check by operationId
        if (operationId) {
            const existingOp = serverProducts.find(
                (p) => p.tenantId === tenantId && p.operationId === operationId
            );
            if (existingOp) {
                return {
                    status: 200,
                    ok: true,
                    data: {
                        success: true,
                        message: "Product created successfully",
                        product: existingOp,
                        alreadyProcessed: true,
                    },
                };
            }
        }

        // 2. SKU duplicate check
        const existingSku = serverProducts.find(
            (p) => p.tenantId === tenantId && p.SKU === normSku
        );
        if (existingSku) {
            return {
                status: 409,
                ok: false,
                data: {
                    success: false,
                    message: "A product with this SKU already exists",
                },
            };
        }

        // 3. Validation failure simulation
        if (payload.sellingPrice < 0 || !payload.categoryId) {
            return {
                status: 400,
                ok: false,
                data: {
                    success: false,
                    message: "Invalid product data",
                    errors: [{ message: "Price cannot be negative" }],
                },
            };
        }

        // 4. Create product
        const newProduct = {
            _id: `prod_${serverProducts.length + 1}`,
            tenantId,
            SKU: normSku,
            operationId,
        };
        serverProducts.push(newProduct);
        return {
            status: 201,
            ok: true,
            data: {
                success: true,
                message: "Product created successfully",
                product: newProduct,
            },
        };
    }

    async function simulateExecuteImport(
        batchId: string,
        rows: Array<{ name: string; SKU: string; sellingPrice: number; categoryId?: string; rowNumber?: number }>,
        simulateNetworkErrorOnSku?: string
    ) {
        let importedCount = 0;
        let failedCount = 0;
        const failureDetails: string[] = [];
        const succeededSkus = new Set<string>();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = row.rowNumber ?? i + 2;
            const normalizedSku = row.SKU.trim().toUpperCase();
            const operationId = getCsvRowOperationId(batchId, normalizedSku);

            try {
                if (simulateNetworkErrorOnSku && normalizedSku === simulateNetworkErrorOnSku) {
                    throw new Error("Simulated socket drop");
                }

                const res = await simulateServerCreate("tenant-1", {
                    name: row.name,
                    SKU: row.SKU,
                    categoryId: row.categoryId ?? "cat-valid",
                    sellingPrice: row.sellingPrice,
                    operationId,
                });

                const data = res.data;

                if (res.ok && data?.success) {
                    importedCount++;
                    succeededSkus.add(normalizedSku);
                } else {
                    failedCount++;
                    const reason =
                        data?.message ||
                        (Array.isArray((data as any)?.errors)
                            ? (data as any).errors.map((e: any) => e.message).join(", ")
                            : null) ||
                        `HTTP error ${res.status}`;
                    failureDetails.push(`Row ${rowNumber} (${row.SKU}): ${reason}`);
                }
            } catch (err: any) {
                failedCount++;
                failureDetails.push(
                    `Row ${rowNumber} (${row.SKU}): Network error (${err?.message || "connection failed"})`
                );
            }
        }

        const remainingRows = rows.filter((r) => !succeededSkus.has(r.SKU.trim().toUpperCase()));
        return { importedCount, failedCount, failureDetails, remainingRows };
    }

    // 4.1 First batch execution creates products
    serverProducts.length = 0;
    const batchAId = "batch-alpha";
    const batchARows = [
        { name: "Alpha 1", SKU: "ALP-01", sellingPrice: 100, rowNumber: 2 },
        { name: "Alpha 2", SKU: "ALP-02", sellingPrice: 200, rowNumber: 3 },
    ];

    const runA1 = await simulateExecuteImport(batchAId, batchARows);
    check("4.1.1. First batch imports all rows successfully", runA1.importedCount === 2 && runA1.failedCount === 0);
    check("4.1.2. Remaining preview rows is empty after complete success", runA1.remainingRows.length === 0);
    check("4.1.3. Server has 2 products created", serverProducts.length === 2);

    // 4.2 Retry within the SAME batch counts alreadyProcessed as success without duplicating
    const runA2 = await simulateExecuteImport(batchAId, batchARows);
    check("4.2.1. Retry of same batch returns 2 successes", runA2.importedCount === 2 && runA2.failedCount === 0);
    check("4.2.2. Retry does not create duplicate products in server", serverProducts.length === 2);

    // 4.3 Second DIFFERENT batch containing the SAME SKU hits 409 Conflict and counts as FAILURE
    const batchBId = "batch-beta";
    const batchBRows = [
        { name: "New Attempt", SKU: "ALP-01", sellingPrice: 150, rowNumber: 2 },
    ];
    const runB = await simulateExecuteImport(batchBId, batchBRows);
    check("4.3.1. Different batch importing existing SKU is NOT treated as alreadyProcessed", runB.importedCount === 0);
    check("4.3.2. Different batch reports 1 failed item", runB.failedCount === 1);
    check("4.3.3. Failure message clearly reports SKU conflict", runB.failureDetails[0].includes("A product with this SKU already exists"));
    check("4.3.4. Failed row remains in preview for user to inspect", runB.remainingRows.length === 1);

    // 4.4 Partial failure with network drop and retry
    const batchCId = "batch-gamma";
    const batchCRows = [
        { name: "Gamma 1", SKU: "GAM-01", sellingPrice: 100, rowNumber: 2 },
        { name: "Gamma 2", SKU: "GAM-02", sellingPrice: 200, rowNumber: 3 },
    ];

    // Simulate network error on GAM-02
    const runC1 = await simulateExecuteImport(batchCId, batchCRows, "GAM-02");
    check("4.4.1. Row with network error increments failedCount", runC1.failedCount === 1);
    check("4.4.2. Succeeded row increments importedCount", runC1.importedCount === 1);
    check("4.4.3. Failed row network error captured with row number", runC1.failureDetails[0].includes("Row 3 (GAM-02): Network error"));
    check("4.4.4. Preview retains only the 1 failed row", runC1.remainingRows.length === 1 && runC1.remainingRows[0].SKU === "GAM-02");

    // Retry remaining failed row using SAME batch ID (network recovered)
    const runC2 = await simulateExecuteImport(batchCId, runC1.remainingRows);
    check("4.4.5. Retrying remaining failed row succeeds", runC2.importedCount === 1 && runC2.failedCount === 0);
    check("4.4.6. All rows now completed, remaining is 0", runC2.remainingRows.length === 0);
    check("4.4.7. Server contains GAM-01 and GAM-02 exactly once", serverProducts.filter((p) => p.SKU.startsWith("GAM-")).length === 2);

    // 4.5 Validation error does not increment success
    const batchDId = "batch-delta";
    const batchDRows = [
        { name: "Bad Row", SKU: "BAD-01", sellingPrice: -10, rowNumber: 2 },
    ];
    const runD = await simulateExecuteImport(batchDId, batchDRows);
    check("4.5.1. Validation error does not increment success count", runD.importedCount === 0);
    check("4.5.2. Validation error increments failure count", runD.failedCount === 1);
    check("4.5.3. Error message reports validation issue", runD.failureDetails[0].includes("Price cannot be negative") || runD.failureDetails[0].includes("Invalid product data"));

    // ============================================================
    // SECTION 5: CSV Text Edit State Invalidation (Phase 4C.1)
    // Simulates the contract enforced by CatalogImportPage textarea.onChange:
    // 1. Updates csvText
    // 2. Resets batchIdRef to null
    // 3. Clears parsedRows (prevents importing stale preview rows)
    // 4. Clears importStatus
    // ============================================================
    console.log("\n-- 5. CSV Text Edit State Invalidation Contract (Phase 4C.1) --");

    interface ComponentStateSimulation {
        csvText: string;
        batchIdRef: string | null;
        parsedRows: Array<{ name: string; SKU: string; sellingPrice: number }>;
        importStatus: string | null;
        importError: string | null;
    }

    const state: ComponentStateSimulation = {
        csvText: "name,SKU,sellingPrice\nOld Item,OLD-01,100",
        batchIdRef: null,
        parsedRows: [],
        importStatus: null,
        importError: null,
    };

    function handleParse(s: ComponentStateSimulation) {
        s.importError = null;
        s.importStatus = null;
        s.batchIdRef = "batch-initial-parsed";
        const res = parseProductCsv(s.csvText);
        if (res.success) {
            s.parsedRows = res.rows.map((r) => ({ name: r.name, SKU: r.SKU, sellingPrice: r.sellingPrice }));
            s.importStatus = `Parsed ${res.rows.length} product(s). Ready to import.`;
        } else {
            s.parsedRows = [];
            s.importError = res.errors.join("\n");
        }
    }

    // Matching app/catalog/import/page.tsx line 284 textarea.onChange handler
    function handleCsvTextChange(s: ComponentStateSimulation, nextText: string) {
        s.csvText = nextText;
        s.batchIdRef = null;
        s.parsedRows = [];
        s.importStatus = null;
    }

    // 5.1 Parse initial CSV
    handleParse(state);
    check("5.1.1. Parse populates parsedRows", state.parsedRows.length === 1 && state.parsedRows[0].SKU === "OLD-01");
    check("5.1.2. Parse sets batchIdRef", state.batchIdRef === "batch-initial-parsed");
    check("5.1.3. Parse sets importStatus", state.importStatus !== null);

    // 5.2 User edits CSV text in textarea
    handleCsvTextChange(state, "name,SKU,sellingPrice\nNew Item,NEW-01,200");
    check("5.2.1. Text edit updates csvText", state.csvText.includes("NEW-01"));
    check("5.2.2. Text edit resets batchIdRef to null", state.batchIdRef === null);
    check("5.2.3. Text edit clears parsedRows (stale rows discarded)", state.parsedRows.length === 0);
    check("5.2.4. Text edit clears previous importStatus", state.importStatus === null);

    // 5.3 Attempting to execute import without re-parsing is blocked by empty parsedRows
    const canExecuteWithoutReparse = state.parsedRows.length > 0;
    check("5.3. Import button disabled / execution prevented when parsedRows is empty", !canExecuteWithoutReparse);

    // 5.4 Re-parsing new text produces fresh parsed rows and fresh batch
    handleParse(state);
    check("5.4.1. Re-parsing new text populates fresh rows", state.parsedRows.length === 1 && state.parsedRows[0].SKU === "NEW-01");
    check("5.4.2. Stale SKU OLD-01 is completely gone", !state.parsedRows.some((r) => r.SKU === "OLD-01"));

    return summarize();
}

run()
    .then((success) => {
        process.exit(success ? 0 : 1);
    })
    .catch((err) => {
        console.error("Test execution failed:", err);
        process.exit(1);
    });
