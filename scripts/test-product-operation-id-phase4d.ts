/**
 * Database-Free Test Suite: Phase 4D — Online Product Form Operation-ID Lifecycle
 * (NO MONGODB, NO ATLAS, NO LIVE SERVERS, NO BROWSER STORAGE MUTATIONS)
 *
 * Covers:
 * 1. Initial product submission generates a fresh operation ID.
 * 2. Retrying the same logical submission (after timeout / uncertain network error) preserves the exact operation ID.
 * 3. Non-semantic whitespace differences normalize to the same fingerprint, preserving the operation ID.
 * 4. Changing SKU (different product) changes the fingerprint and generates a brand new operation ID.
 * 5. Changing other product fields (name, price, category, opening stock) generates a brand new operation ID.
 * 6. Successful creation clears the submission record so subsequent products get fresh operation IDs.
 * 7. Server simulation confirms retrying with preserved operation ID succeeds via alreadyProcessed: true.
 * 8. Server simulation confirms a changed product submission with a fresh operation ID does not collide with prior attempt.
 *
 * Run:
 *   npx tsx scripts/test-product-operation-id-phase4d.ts
 */

import {
    getProductSubmissionFingerprint,
    resolveProductOperationId,
    type ProductSubmissionRecord,
    type ProductSubmissionFingerprintInput,
} from "../lib/catalog/productOperationId";

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
    console.log(`PHASE 4D TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

async function run() {
    console.log("=== PHASE 4D: ONLINE PRODUCT FORM OPERATION-ID LIFECYCLE TESTS ===\n");

    let idCounter = 1000;
    const mockIdGenerator = () => `op-test-${++idCounter}`;

    const baseInput: ProductSubmissionFingerprintInput = {
        name: "Classic Oxford Shirt",
        SKU: "SHIRT-OXF-01",
        barcode: "8901234567890",
        categoryId: "650000000000000000000001",
        unitId: "650000000000000000000002",
        sellingPrice: 799,
        purchasePrice: 450,
        taxRate: 18,
        hsnCode: "6205",
        openingStock: 25,
    };

    // ============================================================
    // SECTION 1: Deterministic Fingerprint Generation & Normalization
    // ============================================================
    console.log("-- 1. Deterministic Fingerprint Normalization --");

    const fp1 = getProductSubmissionFingerprint(baseInput);

    // Variation with extraneous whitespace and lowercasing
    const baseInputSpaced: ProductSubmissionFingerprintInput = {
        ...baseInput,
        name: "  Classic Oxford Shirt  ",
        SKU: "  shirt-oxf-01  ",
        barcode: "  8901234567890  ",
        hsnCode: "  6205  ",
    };
    const fpSpaced = getProductSubmissionFingerprint(baseInputSpaced);

    check("1.1. Base input produces valid non-empty fingerprint", typeof fp1 === "string" && fp1.length > 0);
    check("1.2. Whitespace and lowercase SKU/barcode normalize to identical fingerprint", fp1 === fpSpaced);

    // ============================================================
    // SECTION 2: Initial Submission vs. Retry Lifecycle
    // ============================================================
    console.log("\n-- 2. Initial Submission vs. Retry Lifecycle --");

    let lastSubmission: ProductSubmissionRecord | null = null;

    // 2.1 First-time submission
    const res1 = resolveProductOperationId(lastSubmission, fp1, mockIdGenerator);
    check("2.1.1. Initial submission is not a retry", res1.isRetry === false);
    check("2.1.2. Initial submission generates new operation ID", res1.operationId === "op-test-1001");

    // Record submission
    lastSubmission = { operationId: res1.operationId, fingerprint: fp1 };

    // 2.2 Network timeout / error occurs -> user clicks retry with same form data
    const res2 = resolveProductOperationId(lastSubmission, fp1, mockIdGenerator);
    check("2.2.1. Retry with identical fingerprint is identified as retry", res2.isRetry === true);
    check("2.2.2. Retry retains identical operation ID", res2.operationId === res1.operationId);
    check("2.2.3. No new operation ID was consumed", idCounter === 1001);

    // 2.3 User made a harmless whitespace edit during retry
    const res2Spaced = resolveProductOperationId(lastSubmission, fpSpaced, mockIdGenerator);
    check("2.3.1. Retry with normalized whitespace equivalence preserves operation ID", res2Spaced.operationId === res1.operationId);

    // ============================================================
    // SECTION 3: Form Edited to Describe a Different Product
    // ============================================================
    console.log("\n-- 3. Form Edited to Describe a Different Product --");

    // 3.1 Changing SKU
    const inputDifferentSku: ProductSubmissionFingerprintInput = {
        ...baseInput,
        SKU: "PANTS-CHINO-01",
    };
    const fpDiffSku = getProductSubmissionFingerprint(inputDifferentSku);
    const res3Sku = resolveProductOperationId(lastSubmission, fpDiffSku, mockIdGenerator);
    check("3.1.1. Different SKU produces different fingerprint", fp1 !== fpDiffSku);
    check("3.1.2. Changed SKU generates a NEW operation ID", res3Sku.operationId === "op-test-1002");
    check("3.1.3. Changed SKU is not marked as retry", res3Sku.isRetry === false);
    check("3.1.4. Old operation ID is NOT reused for different SKU", res3Sku.operationId !== res1.operationId);

    // 3.2 Changing product name
    const inputDifferentName: ProductSubmissionFingerprintInput = {
        ...baseInput,
        name: "Linen Casual Shirt",
    };
    const fpDiffName = getProductSubmissionFingerprint(inputDifferentName);
    const res3Name = resolveProductOperationId(lastSubmission, fpDiffName, mockIdGenerator);
    check("3.2.1. Changed name generates a NEW operation ID", res3Name.operationId === "op-test-1003");
    check("3.2.2. Changed name is not marked as retry", res3Name.isRetry === false);

    // 3.3 Changing selling price
    const inputDifferentPrice: ProductSubmissionFingerprintInput = {
        ...baseInput,
        sellingPrice: 999,
    };
    const fpDiffPrice = getProductSubmissionFingerprint(inputDifferentPrice);
    const res3Price = resolveProductOperationId(lastSubmission, fpDiffPrice, mockIdGenerator);
    check("3.3.1. Changed price generates a NEW operation ID", res3Price.operationId === "op-test-1004");

    // 3.4 Changing opening stock
    const inputDifferentStock: ProductSubmissionFingerprintInput = {
        ...baseInput,
        openingStock: 50,
    };
    const fpDiffStock = getProductSubmissionFingerprint(inputDifferentStock);
    const res3Stock = resolveProductOperationId(lastSubmission, fpDiffStock, mockIdGenerator);
    check("3.4.1. Changed opening stock generates a NEW operation ID", res3Stock.operationId === "op-test-1005");

    // ============================================================
    // SECTION 4: Successful Submission Clears State
    // ============================================================
    console.log("\n-- 4. Successful Submission Lifecycle Transition --");

    // Simulate successful submission completion
    lastSubmission = null; // Cleared on res.ok && data?.success

    // Next product creation starts completely fresh
    const res4 = resolveProductOperationId(lastSubmission, fp1, mockIdGenerator);
    check("4.1. Next submission after success is not marked as retry", res4.isRetry === false);
    check("4.2. Next submission receives a brand new operation ID", res4.operationId === "op-test-1006");

    // ============================================================
    // SECTION 5: End-to-End Server Idempotency Simulation
    // ============================================================
    console.log("\n-- 5. End-to-End Server Idempotency Simulation --");

    interface ServerProduct {
        _id: string;
        name: string;
        SKU: string;
        operationId: string;
        openingStock: number;
    }
    const serverDb: ServerProduct[] = [];

    function simulateServerPost(payload: any) {
        // 1. Idempotency pre-check by operationId (matches app/api/products/route.ts line 193)
        if (payload.operationId) {
            const existing = serverDb.find((p) => p.operationId === payload.operationId);
            if (existing) {
                return {
                    status: 200,
                    data: {
                        success: true,
                        message: "Product created successfully",
                        product: existing,
                        alreadyProcessed: true,
                    },
                };
            }
        }

        // 2. Duplicate SKU check (matches app/api/products/route.ts line 265)
        const existingSku = serverDb.find((p) => p.SKU === payload.SKU);
        if (existingSku) {
            return {
                status: 409,
                data: {
                    success: false,
                    message: "A product with this SKU already exists",
                },
            };
        }

        // 3. Create product
        const created: ServerProduct = {
            _id: `prod_${serverDb.length + 1}`,
            name: payload.name,
            SKU: payload.SKU,
            operationId: payload.operationId,
            openingStock: payload.openingStock ?? 0,
        };
        serverDb.push(created);
        return {
            status: 201,
            data: {
                success: true,
                message: "Product created successfully",
                product: created,
            },
        };
    }

    // Step A: User submits Product A ("SHIRT-A")
    const fpA = getProductSubmissionFingerprint({ ...baseInput, SKU: "SHIRT-A" });
    const opA = resolveProductOperationId(null, fpA, mockIdGenerator);
    let stateRef: ProductSubmissionRecord | null = { operationId: opA.operationId, fingerprint: fpA };

    // Request 1 reaches server and commits
    const srvRes1 = simulateServerPost({ ...baseInput, SKU: "SHIRT-A", operationId: opA.operationId });
    check("5.1. Initial server creation returns 201 Created", srvRes1.status === 201);
    check("5.2. Server has 1 product stored", serverDb.length === 1);

    // Suppose socket dropped before response reached client.
    // Client state retains stateRef. User clicks retry for Product A.
    const retryA = resolveProductOperationId(stateRef, fpA, mockIdGenerator);
    const srvRetryRes = simulateServerPost({ ...baseInput, SKU: "SHIRT-A", operationId: retryA.operationId });
    check("5.3. Retry sends same operation ID", retryA.operationId === opA.operationId);
    check("5.4. Server idempotently returns 200 alreadyProcessed: true", srvRetryRes.status === 200 && srvRetryRes.data.alreadyProcessed === true);
    check("5.5. Server still has exactly 1 product (no duplicate)", serverDb.length === 1);

    // Step B: Now suppose after the network drop, the user had changed the form to Product B ("SHIRT-B")
    const fpB = getProductSubmissionFingerprint({ ...baseInput, SKU: "SHIRT-B" });
    const opB = resolveProductOperationId(stateRef, fpB, mockIdGenerator);
    check("5.6. Changed product to SHIRT-B does NOT reuse opA", opB.operationId !== opA.operationId);

    // Request for Product B reaches server with opB
    const srvResB = simulateServerPost({ ...baseInput, SKU: "SHIRT-B", operationId: opB.operationId });
    check("5.7. Server creates Product B successfully (201)", srvResB.status === 201);
    check("5.8. Server has both Product A and Product B safely stored", serverDb.length === 2 && serverDb[0].SKU === "SHIRT-A" && serverDb[1].SKU === "SHIRT-B");

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
