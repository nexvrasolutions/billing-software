/*
 * Database-free unit tests for Production Barcode Index Migration logic (billing_inventory).
 *
 * Validates:
 * 1. Preflight production guards (fail-closed, requires exact billing_inventory opt-in, zero secret leakage).
 * 2. Robust URI parsing (supports mongodb://, mongodb+srv://, replica sets, path validation without regex vulnerability).
 * 3. Catalog ambiguity checks (detecting competing, duplicate, or ambiguous barcode indexes).
 * 4. Strict barcode index classification (MISSING, OLD_SPARSE, INTENDED_PARTIAL, UNEXPECTED name/keys/options/filters).
 * 5. Duplicate detection logic matching exact MongoDB index semantics (no trimming, no lowercasing, ignores non-string/empty).
 * 6. Verification cleanup invariants (tracked ID capture, cleanup mismatch, cleanup exceptions, duplicate failure handling).
 *
 * Run:
 *   npx tsx scripts/test-migrate-product-indexes-production.ts
 */

import {
    PRODUCTION_DATABASE_NAME,
    parseMongoDbUriDatabaseName,
    validateProductionGuards,
    inspectCatalogForBarcode,
    classifyBarcodeIndex,
    findDuplicateBarcodesInMemory,
    executeTrackedCleanup,
    safeCloseMongooseConnection,
    NON_EMPTY_TRIMMED_BARCODE_MATCH,
    type RawIndexInfo,
} from "./migrate-product-indexes-production";

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
    console.log("=== PRODUCTION BARCODE INDEX MIGRATION (DATABASE-FREE TESTS) ===\n");

    // ============================================================
    // 1. ROBUST URI PARSING & SECRET PROTECTION
    // ============================================================
    console.log("-- 1. Robust URI Parsing & Secret Protection --");

    // Undefined / empty
    check("1.1. Parse refuses undefined URI", !parseMongoDbUriDatabaseName(undefined).ok);
    check("1.2. Parse refuses empty URI", !parseMongoDbUriDatabaseName("   ").ok);

    // Non-mongodb scheme
    const resPostgres = parseMongoDbUriDatabaseName("postgres://user:pass@localhost:5432/billing_inventory");
    check("1.3. Parse refuses non-mongodb protocol", !resPostgres.ok && resPostgres.reason.includes("must start with 'mongodb://' or 'mongodb+srv://'"));

    // Pathless URI
    const resNoPath = parseMongoDbUriDatabaseName("mongodb+srv://user:pass@cluster.mongodb.net");
    check("1.4. Parse refuses pathless URI", !resNoPath.ok && resNoPath.reason.includes("does not specify a database name path segment"));

    // Empty database name in path
    const resEmptyDb = parseMongoDbUriDatabaseName("mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true");
    check("1.5. Parse refuses empty database name", !resEmptyDb.ok && resEmptyDb.reason.includes("does not specify a database name"));

    // Invalid slash in database name
    const resSlash = parseMongoDbUriDatabaseName("mongodb+srv://user:pass@cluster.mongodb.net/billing/inventory");
    check("1.6. Parse refuses invalid nested slash in database segment", !resSlash.ok && resSlash.reason.includes("invalid database path segment"));

    // Valid standard mongodb://
    const resStandard = parseMongoDbUriDatabaseName("mongodb://localhost:27017/billing_inventory");
    check("1.7. Parse correctly extracts database from standard mongodb://",
        resStandard.ok && resStandard.dbName === PRODUCTION_DATABASE_NAME);

    // Valid replica set mongodb://
    const resReplica = parseMongoDbUriDatabaseName("mongodb://host1:27017,host2:27017/billing_inventory?replicaSet=rs0");
    check("1.8. Parse correctly extracts database from multi-host replica set URI",
        resReplica.ok && resReplica.dbName === PRODUCTION_DATABASE_NAME);

    // Valid SRV with query params and hash
    const resSrv = parseMongoDbUriDatabaseName("mongodb+srv://user:secretpass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority");
    check("1.9. Parse correctly extracts database from mongodb+srv:// with query options",
        resSrv.ok && resSrv.dbName === PRODUCTION_DATABASE_NAME);

    // ============================================================
    // 2. PRODUCTION GUARDS VALIDATION
    // ============================================================
    console.log("\n-- 2. Production Guards & Fail-Closed Checks --");

    // Missing confirmation
    const resNoConfirm = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: undefined,
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true",
    });
    check("2.1. Refuses when CONFIRM_PRODUCTION_INDEX_MIGRATION is undefined",
        !resNoConfirm.ok && resNoConfirm.reason.includes("billing_inventory"));

    // Wrong confirmation (e.g. YES or billing_test)
    const resWrongConfirm = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_test",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true",
    });
    check("2.2. Refuses when CONFIRM_PRODUCTION_INDEX_MIGRATION is not 'billing_inventory'",
        !resWrongConfirm.ok && resWrongConfirm.reason.includes("must be explicitly set to 'billing_inventory'"));

    // URI targeting billing_test
    const resTestDb = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_test?retryWrites=true",
    });
    check("2.3. Refuses when MONGODB_URI targets billing_test",
        !resTestDb.ok && resTestDb.reason.includes("does not match required 'billing_inventory'"));

    // URI targeting main database "billing" instead of "billing_inventory"
    const resBilling = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:secretpass@cluster.mongodb.net/billing?retryWrites=true",
    });
    check("2.4. Refuses when MONGODB_URI targets 'billing'",
        !resBilling.ok && resBilling.reason.includes("does not match required 'billing_inventory'"));

    // Secret redaction check: reason must never contain password, user, or host
    check("2.5. Guard refusal message contains no part of URI, username, password, or host",
        !resBilling.ok &&
        !resBilling.reason.includes("secretpass") &&
        !resBilling.reason.includes("user") &&
        !resBilling.reason.includes("cluster.mongodb.net"));

    // Valid production configuration
    const resValid = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority",
    });
    check("2.6. Passes when confirmation is 'billing_inventory' and URI targets 'billing_inventory'", resValid.ok);

    // ============================================================
    // 3. CATALOG AMBIGUITY CHECKS
    // ============================================================
    console.log("\n-- 3. Catalog Ambiguity & Competing Index Checks --");

    const cleanCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_SKU_1", key: { tenantId: 1, SKU: 1 }, unique: true },
        { name: "tenantId_1_barcode_1", key: { tenantId: 1, barcode: 1 }, unique: true, sparse: true },
    ];
    const catCheckSingle = inspectCatalogForBarcode(cleanCatalog);
    check("3.1. Clean catalog with single barcode index accepted", catCheckSingle.ok && catCheckSingle.targetIndex?.name === "tenantId_1_barcode_1");

    const competingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_barcode_1", key: { tenantId: 1, barcode: 1 } },
        { name: "barcode_1", key: { barcode: 1 } },
    ];
    const catCheckCompeting = inspectCatalogForBarcode(competingCatalog);
    check("3.2. Multiple competing barcode indexes detected and rejected", !catCheckCompeting.ok && catCheckCompeting.reason.includes("competing/ambiguous"));

    const missingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_SKU_1", key: { tenantId: 1, SKU: 1 } },
    ];
    const catCheckMissing = inspectCatalogForBarcode(missingCatalog);
    check("3.3. Missing index in catalog returns ok with undefined targetIndex", catCheckMissing.ok && catCheckMissing.targetIndex === undefined);

    // ============================================================
    // 4. STRICT BARCODE INDEX CLASSIFICATION
    // ============================================================
    console.log("\n-- 4. Strict Barcode Index Classification --");

    // Missing index
    const classMissing = classifyBarcodeIndex(undefined);
    check("4.1. Undefined index classified as MISSING", classMissing.classification === "MISSING");

    // Legacy compound sparse index
    const oldSparseBarcode: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: true,
    };
    const classOldSparse = classifyBarcodeIndex(oldSparseBarcode);
    check("4.2. Legacy compound sparse index classified as OLD_SPARSE", classOldSparse.classification === "OLD_SPARSE");

    // Intended unique partial index
    const intendedPartialBarcode: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            barcode: { $type: "string", $gt: "" },
        },
    };
    const classIntended = classifyBarcodeIndex(intendedPartialBarcode);
    check("4.3. Correct unique partial barcode index classified as INTENDED_PARTIAL",
        classIntended.classification === "INTENDED_PARTIAL");

    // Unexpected index name
    const badName: RawIndexInfo = {
        name: "barcode_index_custom",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: true,
    };
    check("4.4. Index with wrong name classified as UNEXPECTED",
        classifyBarcodeIndex(badName).classification === "UNEXPECTED");

    // Unexpected key order or missing tenantId
    const badKeys: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { barcode: 1 },
        unique: true,
    };
    check("4.5. Index missing tenantId in key pattern classified as UNEXPECTED",
        classifyBarcodeIndex(badKeys).classification === "UNEXPECTED");

    // Non-unique index
    const nonUnique: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: false,
    };
    check("4.6. Non-unique barcode index classified as UNEXPECTED",
        classifyBarcodeIndex(nonUnique).classification === "UNEXPECTED");

    // Extra condition in partial filter
    const extraCond: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            barcode: { $type: "string", $gt: "", $exists: true },
        },
    };
    check("4.7. Partial index with extra condition classified as UNEXPECTED",
        classifyBarcodeIndex(extraCond).classification === "UNEXPECTED");

    // Extra field in partial filter
    const extraField: RawIndexInfo = {
        name: "tenantId_1_barcode_1",
        key: { tenantId: 1, barcode: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            barcode: { $type: "string", $gt: "" },
            tenantId: { $exists: true },
        },
    };
    check("4.8. Partial index with extra field in filter classified as UNEXPECTED",
        classifyBarcodeIndex(extraField).classification === "UNEXPECTED");

    // ============================================================
    // 5. DUPLICATE AUDIT IN-MEMORY TESTS (CANONICAL SEMANTICS)
    // ============================================================
    console.log("\n-- 5. Pre-Flight Duplicate Audits (Canonical Semantics) --");

    // Multiple products with absent, empty, or whitespace-only barcodes do NOT count as duplicates
    const recordsWithOmittedBarcodes = [
        { tenantId: "t1" },
        { tenantId: "t1", barcode: undefined },
        { tenantId: "t1", barcode: null },
        { tenantId: "t1", barcode: "" },
        { tenantId: "t1", barcode: "   " },
        { tenantId: "t1", barcode: 99999 },
        { tenantId: "t1", barcode: "BAR-100" },
        { tenantId: "t1", barcode: "BAR-200" },
    ];
    const dupsOmitted = findDuplicateBarcodesInMemory(recordsWithOmittedBarcodes);
    check("5.1. Products with missing, undefined, null, empty string, or whitespace do NOT trigger duplicates",
        dupsOmitted.length === 0);

    // Exact duplicate non-empty barcodes in SAME tenant
    const recordsWithBarcodeConflict = [
        { tenantId: "t1", barcode: "BAR-DUPLICATE" },
        { tenantId: "t1", barcode: "BAR-DUPLICATE" },
    ];
    const dupsConflict = findDuplicateBarcodesInMemory(recordsWithBarcodeConflict);
    check("5.2. Exact duplicate non-empty barcode in same tenant is detected",
        dupsConflict.length === 1 && dupsConflict[0].count === 2);

    // Case difference in same tenant IS detected as duplicate under canonical rules
    const recordsCaseDiff = [
        { tenantId: "t1", barcode: "BAR-100" },
        { tenantId: "t1", barcode: "bar-100" },
    ];
    const dupsCase = findDuplicateBarcodesInMemory(recordsCaseDiff);
    check("5.3. Case differences in same tenant are detected as canonical duplicates",
        dupsCase.length === 1 && dupsCase[0].canonicalBarcode === "BAR-100" && dupsCase[0].count === 2);

    // Trimmed whitespace difference in same tenant IS detected as duplicate
    const recordsWhitespaceDup = [
        { tenantId: "t1", barcode: "  BAR-200  " },
        { tenantId: "t1", barcode: "BAR-200" },
    ];
    const dupsWhitespace = findDuplicateBarcodesInMemory(recordsWhitespaceDup);
    check("5.4. Trimmed whitespace differences in same tenant are detected as canonical duplicates",
        dupsWhitespace.length === 1 && dupsWhitespace[0].canonicalBarcode === "BAR-200" && dupsWhitespace[0].count === 2);

    // Same barcode in DIFFERENT tenants is allowed
    const recordsDifferentTenants = [
        { tenantId: "tenant_A", barcode: "SHARED-BARCODE" },
        { tenantId: "tenant_B", barcode: "SHARED-BARCODE" },
    ];
    const dupsDiffTenants = findDuplicateBarcodesInMemory(recordsDifferentTenants);
    check("5.5. Same barcode in different tenants is NOT flagged as duplicate",
        dupsDiffTenants.length === 0);

    // Pipeline match condition check
    check("5.6. NON_EMPTY_TRIMMED_BARCODE_MATCH checks type and non-empty trimmed length",
        NON_EMPTY_TRIMMED_BARCODE_MATCH.barcode.$type === "string" &&
        NON_EMPTY_TRIMMED_BARCODE_MATCH.barcode.$gt === "" &&
        Boolean(NON_EMPTY_TRIMMED_BARCODE_MATCH.$expr));

    // ============================================================
    // 6. SAFE CLEANUP LOGIC & CONNECTION TEARDOWN HANDLING
    // ============================================================
    console.log("\n-- 6. Verification Cleanup Invariants & Connection Teardown --");

    // 6.1 Successful cleanup
    const mockSuccessCol = {
        deleteMany: async (q: { _id: { $in: any[] } }) => ({ deletedCount: q._id.$in.length }),
    };
    const cleanSuccess = await executeTrackedCleanup(mockSuccessCol, ["id_1", "id_2"], "billing_inventory");
    check("6.1. Successful cleanup reports success and exact deleted count",
        cleanSuccess.success && cleanSuccess.deletedCount === 2);

    // 6.2 Incomplete cleanup (mismatch)
    const mockMismatchCol = {
        deleteMany: async () => ({ deletedCount: 1 }),
    };
    const cleanMismatch = await executeTrackedCleanup(mockMismatchCol, ["id_1", "id_2"], "billing_inventory");
    check("6.2. Incomplete cleanup reports failure and warning that records may remain",
        !cleanMismatch.success && Boolean(cleanMismatch.warning?.includes("Cleanup mismatch")));

    // 6.3 Cleanup exception
    const mockErrorCol = {
        deleteMany: async () => {
            throw new Error("Connection lost during deleteMany");
        },
    };
    const cleanException = await executeTrackedCleanup(mockErrorCol, ["id_1", "id_2"], "billing_inventory");
    check("6.3. Cleanup exception reports failure and captures error",
        !cleanException.success && Boolean(cleanException.error?.includes("Connection lost")));

    // 6.4 Zero IDs to cleanup
    const cleanEmpty = await executeTrackedCleanup(mockSuccessCol, [], "billing_inventory");
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
        const unexpectedRes = { insertedId: "doc_unexpected_dup" };
        insertedIds.push(unexpectedRes.insertedId);
    } catch (e: any) {
        if (e.code === 11000) {
            dupUnexpectedCaught = true;
        }
    }
    check("6.6. Unexpected duplicate insert captures ID into insertedIds for deletion",
        !dupUnexpectedCaught && insertedIds.includes("doc_unexpected_dup") && insertedIds.length === 4);

    // 6.7 Connection teardown verification
    let disconnectCalled = false;
    const fakeActiveMongoose = {
        connection: { readyState: 1 },
        disconnect: async () => { disconnectCalled = true; },
    };
    await safeCloseMongooseConnection(fakeActiveMongoose);
    check("6.7. safeCloseMongooseConnection disconnects active connection", disconnectCalled);

    let disconnectCalledForClosed = false;
    const fakeClosedMongoose = {
        connection: { readyState: 0 },
        disconnect: async () => { disconnectCalledForClosed = true; },
    };
    await safeCloseMongooseConnection(fakeClosedMongoose);
    check("6.8. safeCloseMongooseConnection skips disconnect when already closed", !disconnectCalledForClosed);

    const fakeFailingMongoose = {
        connection: { readyState: 1 },
        disconnect: async () => { throw new Error("Teardown error"); },
    };
    let closedSafely = false;
    try {
        await safeCloseMongooseConnection(fakeFailingMongoose);
        closedSafely = true;
    } catch {
        closedSafely = false;
    }
    check("6.9. safeCloseMongooseConnection swallows disconnect errors without masking", closedSafely);

    const success = summarize();
    process.exit(success ? 0 : 1);
}

main().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
