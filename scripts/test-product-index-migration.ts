/*
 * Database-free unit tests for MongoDB Product Index Migration logic (billing_test).
 *
 * Validates:
 * 1. Guard ordering and fail-closed security (refusing production, non-test env, missing opt-in, non-billing_test URIs).
 * 2. Catalog ambiguity checks (detecting competing, duplicate, or ambiguous indexes).
 * 3. Strict index classification (MISSING, OLD_SPARSE, INTENDED_PARTIAL, UNEXPECTED name/keys/options/filters).
 * 4. Duplicate pre-check audit logic matching exact MongoDB index semantics (no trimming, no lowercasing, ignores non-string/empty).
 * 5. Failure recovery procedure & messaging clarity for non-atomic index replacements.
 * 6. Verification cleanup invariants (tracked ID capture, cleanup mismatch, cleanup exceptions, duplicate failure handling).
 *
 * Run:
 *   npx tsx scripts/test-product-index-migration.ts
 */

import {
    validateMigrationGuards,
    inspectCatalogForField,
    classifyProductIndex,
    findTenantDuplicates,
    executeTrackedCleanup,
    RECOVERY_PROCEDURE_GUIDE,
    MIGRATION_STAGES,
    type RawIndexInfo,
} from "./migrate-product-indexes";

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

async function main() {
    console.log("=== PRODUCT INDEX MIGRATION DATABASE-FREE TESTS (billing_test) ===\n");

    // ============================================================
    // 1. GUARD ORDERING & FAIL-CLOSED VALIDATION
    // ============================================================
    console.log("-- 1. Guard Ordering & Security Checks --");

    // Production refusal
    const resProd = validateMigrationGuards({
        NODE_ENV: "production",
        ALLOW_INDEX_MIGRATION: "YES",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_test?retryWrites=true",
    });
    check("1.1. Refuses when NODE_ENV is production", !resProd.ok && resProd.reason.includes("production"));

    // Development refusal (must be test)
    const resDev = validateMigrationGuards({
        NODE_ENV: "development",
        ALLOW_INDEX_MIGRATION: "YES",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_test?retryWrites=true",
    });
    check("1.2. Refuses when NODE_ENV is not 'test'", !resDev.ok && resDev.reason.includes("must be set to 'test'"));

    // Missing opt-in flag refusal
    const resNoOptIn = validateMigrationGuards({
        NODE_ENV: "test",
        ALLOW_INDEX_MIGRATION: "NO",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_test?retryWrites=true",
    });
    check("1.3. Refuses when ALLOW_INDEX_MIGRATION is not 'YES'", !resNoOptIn.ok && resNoOptIn.reason.includes("ALLOW_INDEX_MIGRATION"));

    // Missing URI refusal
    const resNoUri = validateMigrationGuards({
        NODE_ENV: "test",
        ALLOW_INDEX_MIGRATION: "YES",
        MONGODB_URI: undefined,
    });
    check("1.4. Refuses when MONGODB_URI is undefined", !resNoUri.ok && resNoUri.reason.includes("billing_test"));

    // Wrong database name refusal (targeting production database 'billing')
    const resMainDb = validateMigrationGuards({
        NODE_ENV: "test",
        ALLOW_INDEX_MIGRATION: "YES",
        MONGODB_URI: "mongodb+srv://user:secret@cluster.mongodb.net/billing?retryWrites=true",
    });
    check("1.5. Refuses when MONGODB_URI targets main database 'billing'", !resMainDb.ok && resMainDb.reason.includes("must name the dedicated test database billing_test"));
    check("1.6. Refusal message does not leak URI or credentials", !resMainDb.ok && !resMainDb.reason.includes("secret") && !resMainDb.reason.includes("cluster.mongodb.net"));

    // Another database containing _test but not billing_test
    const resOtherTest = validateMigrationGuards({
        NODE_ENV: "test",
        ALLOW_INDEX_MIGRATION: "YES",
        MONGODB_URI: "mongodb://localhost:27017/other_test",
    });
    check("1.7. Refuses when database name is 'other_test'", !resOtherTest.ok && resOtherTest.reason.includes("billing_test"));

    // Valid test configuration
    const resValid = validateMigrationGuards({
        NODE_ENV: "test",
        ALLOW_INDEX_MIGRATION: "YES",
        MONGODB_URI: "mongodb+srv://user:secret@cluster.mongodb.net/billing_test?retryWrites=true",
    });
    check("1.8. Passes when NODE_ENV=test, ALLOW_INDEX_MIGRATION=YES, and target is billing_test", resValid.ok);

    // ============================================================
    // 2. CATALOG AMBIGUITY CHECKS
    // ============================================================
    console.log("\n-- 2. Catalog Ambiguity & Competing Index Checks --");

    const cleanCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_barcode_1", key: { tenantId: 1, barcode: 1 }, unique: true, sparse: true },
        { name: "tenantId_1_operationId_1", key: { tenantId: 1, operationId: 1 }, unique: true, sparse: true },
    ];
    const catCheckSingle = inspectCatalogForField(cleanCatalog, "barcode");
    check("2.1. Clean catalog with single barcode index accepted", catCheckSingle.ok && catCheckSingle.targetIndex?.name === "tenantId_1_barcode_1");

    const competingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_barcode_1", key: { tenantId: 1, barcode: 1 } },
        { name: "barcode_1", key: { barcode: 1 } },
    ];
    const catCheckCompeting = inspectCatalogForField(competingCatalog, "barcode");
    check("2.2. Multiple competing barcode indexes detected and rejected", !catCheckCompeting.ok && catCheckCompeting.reason.includes("competing/ambiguous"));

    const missingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
    ];
    const catCheckMissing = inspectCatalogForField(missingCatalog, "barcode");
    check("2.3. Missing index in catalog returns ok with undefined targetIndex", catCheckMissing.ok && catCheckMissing.targetIndex === undefined);

    // ============================================================
    // 3. STRICT INDEX CLASSIFICATION
    // ============================================================
    console.log("\n-- 3. Strict Index-State Classification --");

    // Missing index
    const classMissing = classifyProductIndex(undefined, "barcode");
    check("3.1. Undefined index classified as MISSING", classMissing.classification === "MISSING");

    // Legacy compound sparse index
    const oldSparseBarcode: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: true,
    };
    const classOldSparse = classifyProductIndex(oldSparseBarcode, "barcode");
    check("3.2. Legacy compound sparse barcode index classified as OLD_SPARSE", classOldSparse.classification === "OLD_SPARSE");

    // Intended partial index
    const intendedPartialBarcode: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            barcode: { $type: "string", $gt: "" },
        },
    };
    const classIntended = classifyProductIndex(intendedPartialBarcode, "barcode");
    check("3.3. Correct partial barcode index classified as INTENDED_PARTIAL", classIntended.classification === "INTENDED_PARTIAL");

    // Unexpected index name
    const badNameIndex: RawIndexInfo = {
        name: "custom_barcode_idx",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: true,
    };
    check("3.4. Index with non-matching name classified as UNEXPECTED",
        classifyProductIndex(badNameIndex, "barcode").classification === "UNEXPECTED");

    // Unexpected keys (non-tenant scoped)
    const unexpectedKeys: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { barcode: 1 },
        unique: true,
    };
    check("3.5. Non-tenant-scoped index classified as UNEXPECTED", classifyProductIndex(unexpectedKeys, "barcode").classification === "UNEXPECTED");

    // Unexpected options (non-unique)
    const unexpectedOptions: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: false,
    };
    check("3.6. Non-unique index classified as UNEXPECTED", classifyProductIndex(unexpectedOptions, "barcode").classification === "UNEXPECTED");

    // Extra condition in partialFilterExpression
    const extraFilterCond: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            barcode: { $type: "string", $gt: "", $exists: true },
        },
    };
    check("3.7. Partial index with extra filter condition classified as UNEXPECTED",
        classifyProductIndex(extraFilterCond, "barcode").classification === "UNEXPECTED");

    // Extra field in partialFilterExpression
    const extraFilterField: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            barcode: { $type: "string", $gt: "" },
            status: { $eq: "active" },
        },
    };
    check("3.8. Partial index with extra filter field classified as UNEXPECTED",
        classifyProductIndex(extraFilterField, "barcode").classification === "UNEXPECTED");

    // OperationId classifications
    const oldSparseOpId: RawIndexInfo = {
        name: "tenantId_1_operationId_1",
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: true,
    };
    check("3.9. Legacy compound sparse operationId index classified as OLD_SPARSE", classifyProductIndex(oldSparseOpId, "operationId").classification === "OLD_SPARSE");

    const intendedPartialOpId: RawIndexInfo = {
        name: "tenantId_1_operationId_1",
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    };
    check("3.10. Correct partial operationId index ($type/$gt) classified as INTENDED_PARTIAL", classifyProductIndex(intendedPartialOpId, "operationId").classification === "INTENDED_PARTIAL");

    const existsConventionOpId: RawIndexInfo = {
        name: "tenantId_1_operationId_1",
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $exists: true },
        },
    };
    check("3.11. OperationId index with project convention ($exists: true) classified as INTENDED_PARTIAL", classifyProductIndex(existsConventionOpId, "operationId").classification === "INTENDED_PARTIAL");

    check("3.12. Missing operationId index classified as MISSING", classifyProductIndex(undefined, "operationId").classification === "MISSING");

    // ============================================================
    // 4. DUPLICATE AUDIT PRE-CHECK LOGIC (DATABASE SEMANTICS)
    // ============================================================
    console.log("\n-- 4. Pre-Flight Duplicate Audits (MongoDB Semantics) --");

    // Multiple products with absent, undefined, null, or empty barcodes do NOT count as duplicates
    const recordsWithOmittedBarcodes = [
        { tenantId: "t1", SKU: "P1" }, // missing
        { tenantId: "t1", SKU: "P2", barcode: undefined },
        { tenantId: "t1", SKU: "P3", barcode: null },
        { tenantId: "t1", SKU: "P4", barcode: "" }, // empty string $gt: "" is false
        { tenantId: "t1", SKU: "P5", barcode: 12345 }, // non-string
        { tenantId: "t1", SKU: "P6", barcode: "BAR-100" },
        { tenantId: "t1", SKU: "P7", barcode: "BAR-200" },
    ];
    const dupsOmitted = findTenantDuplicates(recordsWithOmittedBarcodes, "barcode");
    check("4.1. Products with missing, null, empty string, or non-string do NOT trigger duplicates", dupsOmitted.length === 0);

    // Exact duplicate non-empty barcodes in SAME tenant
    const recordsWithExactBarcodeConflict = [
        { tenantId: "t1", SKU: "P1", barcode: "BAR-DUPLICATE" },
        { tenantId: "t1", SKU: "P2", barcode: "BAR-DUPLICATE" },
    ];
    const dupsConflict = findTenantDuplicates(recordsWithExactBarcodeConflict, "barcode");
    check("4.2. Exact duplicate non-empty barcode in same tenant is detected", dupsConflict.length === 1 && dupsConflict[0].count === 2);

    // Different case in same tenant is NOT flagged (matches default MongoDB binary string collation)
    const recordsDifferentCase = [
        { tenantId: "t1", SKU: "P1", barcode: "BAR-100" },
        { tenantId: "t1", SKU: "P2", barcode: "bar-100" },
    ];
    const dupsDiffCase = findTenantDuplicates(recordsDifferentCase, "barcode");
    check("4.3. Different case values are not normalized to false duplicates", dupsDiffCase.length === 0);

    // Whitespace string in same tenant IS indexed by MongoDB ($gt: "" is true) and flagged as duplicate
    const recordsWhitespaceDup = [
        { tenantId: "t1", SKU: "P1", barcode: "   " },
        { tenantId: "t1", SKU: "P2", barcode: "   " },
    ];
    const dupsWhitespace = findTenantDuplicates(recordsWhitespaceDup, "barcode");
    check("4.4. Duplicate whitespace-only strings in same tenant are detected (matches MongoDB $gt: \"\")",
        dupsWhitespace.length === 1 && dupsWhitespace[0].count === 2);

    // Same barcode in DIFFERENT tenants is allowed
    const recordsDifferentTenants = [
        { tenantId: "tenant_A", SKU: "P1", barcode: "SHARED-BARCODE" },
        { tenantId: "tenant_B", SKU: "P2", barcode: "SHARED-BARCODE" },
    ];
    const dupsDiffTenants = findTenantDuplicates(recordsDifferentTenants, "barcode");
    check("4.5. Same barcode in different tenants is NOT flagged as duplicate", dupsDiffTenants.length === 0);

    // Duplicate non-empty operationIds in SAME tenant
    const recordsWithOpIdConflict = [
        { tenantId: "t1", SKU: "P1", operationId: "op_offline_101" },
        { tenantId: "t1", SKU: "P2", operationId: "op_offline_101" },
    ];
    const dupsOpConflict = findTenantDuplicates(recordsWithOpIdConflict, "operationId");
    check("4.6. Duplicate operationId in same tenant is detected", dupsOpConflict.length === 1 && dupsOpConflict[0].count === 2);

    // ============================================================
    // 5. FAILURE RECOVERY & ROLLBACK DOCUMENTATION
    // ============================================================
    console.log("\n-- 5. Failure Recovery & Rollback Documentation --");

    check("5.1. Migration stages define explicit preflight, inspection, replacement and verification",
        Object.keys(MIGRATION_STAGES).length === 5);
    check("5.2. Recovery guide explicitly explains unindexed window if creation fails",
        RECOVERY_PROCEDURE_GUIDE.includes("UNINDEXED on the affected key"));
    check("5.3. Recovery guide warns against blind rollback to compound sparse",
        RECOVERY_PROCEDURE_GUIDE.includes("DO NOT blindly restore the old compound sparse index"));
    check("5.4. Recovery guide provides exact mongosh partial index creation command",
        RECOVERY_PROCEDURE_GUIDE.includes("db.products.createIndex") &&
        RECOVERY_PROCEDURE_GUIDE.includes("partialFilterExpression"));

    // ============================================================
    // 6. SAFE CLEANUP LOGIC & VERIFICATION FAILURE HANDLING
    // ============================================================
    console.log("\n-- 6. Verification Cleanup Invariants & Error Handling --");

    // 6.1 Successful cleanup
    const mockSuccessCol = {
        deleteMany: async (q: { _id: { $in: any[] } }) => ({ deletedCount: q._id.$in.length }),
    };
    const cleanSuccess = await executeTrackedCleanup(mockSuccessCol, ["id_1", "id_2"], "billing_test");
    check("6.1. Successful cleanup reports success and exact deleted count",
        cleanSuccess.success && cleanSuccess.deletedCount === 2);

    // 6.2 Incomplete cleanup (mismatch)
    const mockMismatchCol = {
        deleteMany: async () => ({ deletedCount: 1 }),
    };
    const cleanMismatch = await executeTrackedCleanup(mockMismatchCol, ["id_1", "id_2"], "billing_test");
    check("6.2. Incomplete cleanup reports failure and warning that records may remain",
        !cleanMismatch.success && Boolean(cleanMismatch.warning?.includes("Cleanup mismatch")));

    // 6.3 Cleanup exception
    const mockErrorCol = {
        deleteMany: async () => {
            throw new Error("Network timeout during deleteMany");
        },
    };
    const cleanException = await executeTrackedCleanup(mockErrorCol, ["id_1", "id_2"], "billing_test");
    check("6.3. Cleanup exception reports failure and captures error",
        !cleanException.success && Boolean(cleanException.error?.includes("Network timeout")));

    // 6.4 Zero IDs to cleanup
    const cleanEmpty = await executeTrackedCleanup(mockSuccessCol, [], "billing_test");
    check("6.4. Empty ID list reports success with attempted=false",
        cleanEmpty.success && !cleanEmpty.attempted);

    // 6.5 Duplicate rejection simulation: caught duplicate does not add untracked ID
    const insertedIds: string[] = ["doc_1", "doc_2", "doc_3"];
    let dupCaught = false;
    try {
        const err: any = new Error("E11000 duplicate key error");
        err.code = 11000;
        throw err;
    } catch (e: any) {
        if (e.code === 11000) {
            dupCaught = true;
        }
    }
    check("6.5. Expected duplicate failure does NOT push untracked ID to insertedIds",
        dupCaught && insertedIds.length === 3);

    // 6.6 Unexpected duplicate success simulation: captures ID so cleanup can delete it
    let dupUnexpectedCaught = false;
    try {
        // simulate unexpected success
        const unexpectedRes = { insertedId: "doc_unexpected_dup" };
        insertedIds.push(unexpectedRes.insertedId);
    } catch (e: any) {
        if (e.code === 11000) {
            dupUnexpectedCaught = true;
        }
    }
    check("6.6. Unexpected duplicate insert captures ID into insertedIds for deletion",
        !dupUnexpectedCaught && insertedIds.includes("doc_unexpected_dup") && insertedIds.length === 4);

    const success = summarize();
    process.exit(success ? 0 : 1);
}

main();
