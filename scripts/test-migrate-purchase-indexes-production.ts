/*
 * Database-free unit tests for Production Purchase Index Migration logic (billing_inventory).
 *
 * Validates:
 * 1. Preflight production guards (fail-closed, requires exact billing_inventory opt-in, zero secret leakage).
 * 2. Execution mode resolution: Defaults to DRY-RUN; requires explicit --apply flag to enable DDL.
 * 3. Robust URI parsing (supports mongodb://, mongodb+srv://, replica sets, path validation without regex vulnerability).
 * 4. Catalog ambiguity & index isolation checks (detecting competing indexes, preserving unrelated indexes).
 * 5. Strict purchase operationId index classification:
 *    - MISSING
 *    - OLD_EXISTS_PARTIAL ({ operationId: { $exists: true } } - live Atlas state)
 *    - OLD_SPARSE (legacy sparse compound)
 *    - INTENDED_PARTIAL ({ operationId: { $type: "string", $gt: "" } })
 *    - UNEXPECTED (malformed, bad keys, non-unique, unrecognized filters)
 * 6. Document audit & duplicate detection logic matching exact MongoDB index semantics:
 *    - Accurately tracks missing, null, empty string, whitespace-only, valid non-empty string, and non-string operationIds.
 *    - Detects per-tenant duplicate non-empty canonical operationIds.
 * 7. Index definition verification function (checks name, compound key, uniqueness, partialFilterExpression, not sparse).
 *    - Reject indexes with $exists: true filter when verifying against target model.
 * 8. Dry-run behavior and planner logic (verifies NOOP, REPLACE, CREATE, ABORT scenarios; zero writes executed).
 * 9. Concurrency & IndexOptionsConflict advisory documentation checks.
 * 10. Connection teardown invariants.
 *
 * Run:
 *   npx tsx scripts/test-migrate-purchase-indexes-production.ts
 */

import {
    PRODUCTION_DATABASE_NAME,
    TARGET_COLLECTION_NAME,
    TARGET_INDEX_NAME,
    TARGET_INDEX_KEY,
    TARGET_PARTIAL_FILTER,
    OLD_EXISTS_PARTIAL_FILTER,
    parseMongoDbUriDatabaseName,
    validateProductionGuards,
    resolveExecutionMode,
    inspectCatalogForPurchaseOperationId,
    classifyPurchaseOperationIdIndex,
    verifyPurchaseOperationIdIndexDefinition,
    auditPurchaseDocumentsInMemory,
    planPurchaseIndexMigration,
    safeCloseMongooseConnection,
    NON_EMPTY_TRIMMED_OPERATION_ID_MATCH,
    WRITE_PAUSE_ADVISORY,
    RECOVERY_PROCEDURE_GUIDE,
    type RawIndexInfo,
} from "./migrate-purchase-indexes-production";

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
    console.log("=== PRODUCTION PURCHASE INDEX MIGRATION (DATABASE-FREE TESTS) ===\n");

    // ============================================================
    // 1. ROBUST URI PARSING & SECRET PROTECTION
    // ============================================================
    console.log("-- 1. Robust URI Parsing & Secret Protection --");

    check("1.1. Parse refuses undefined URI", !parseMongoDbUriDatabaseName(undefined).ok);
    check("1.2. Parse refuses empty URI", !parseMongoDbUriDatabaseName("   ").ok);

    const resPostgres = parseMongoDbUriDatabaseName("postgres://user:pass@localhost:5432/billing_inventory");
    check("1.3. Parse refuses non-mongodb protocol", !resPostgres.ok && resPostgres.reason.includes("must start with 'mongodb://' or 'mongodb+srv://'"));

    const resNoPath = parseMongoDbUriDatabaseName("mongodb+srv://user:pass@cluster.mongodb.net");
    check("1.4. Parse refuses pathless URI", !resNoPath.ok && resNoPath.reason.includes("does not specify a database name path segment"));

    const resEmptyDb = parseMongoDbUriDatabaseName("mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true");
    check("1.5. Parse refuses empty database name", !resEmptyDb.ok && resEmptyDb.reason.includes("does not specify a database name"));

    const resSlash = parseMongoDbUriDatabaseName("mongodb+srv://user:pass@cluster.mongodb.net/billing/inventory");
    check("1.6. Parse refuses invalid nested slash in database segment", !resSlash.ok && resSlash.reason.includes("invalid database path segment"));

    const resStandard = parseMongoDbUriDatabaseName("mongodb://localhost:27017/billing_inventory");
    check("1.7. Parse correctly extracts database from standard mongodb://",
        resStandard.ok && resStandard.dbName === PRODUCTION_DATABASE_NAME);

    const resReplica = parseMongoDbUriDatabaseName("mongodb://host1:27017,host2:27017/billing_inventory?replicaSet=rs0");
    check("1.8. Parse correctly extracts database from multi-host replica set URI",
        resReplica.ok && resReplica.dbName === PRODUCTION_DATABASE_NAME);

    const resSrv = parseMongoDbUriDatabaseName("mongodb+srv://user:secretpass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority");
    check("1.9. Parse correctly extracts database from mongodb+srv:// with query options",
        resSrv.ok && resSrv.dbName === PRODUCTION_DATABASE_NAME);

    // ============================================================
    // 2. PRODUCTION GUARDS & FAIL-CLOSED CHECKS
    // ============================================================
    console.log("\n-- 2. Production Guards & Fail-Closed Checks --");

    const resNoConfirm = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: undefined,
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true",
    });
    check("2.1. Refuses when CONFIRM_PRODUCTION_INDEX_MIGRATION is undefined",
        !resNoConfirm.ok && resNoConfirm.reason.includes("billing_inventory"));

    const resWrongConfirm = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_test",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true",
    });
    check("2.2. Refuses when CONFIRM_PRODUCTION_INDEX_MIGRATION is not 'billing_inventory'",
        !resWrongConfirm.ok && resWrongConfirm.reason.includes("must be explicitly set to 'billing_inventory'"));

    const resTestDb = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_test?retryWrites=true",
    });
    check("2.3. Refuses when MONGODB_URI targets billing_test",
        !resTestDb.ok && resTestDb.reason.includes("does not match required 'billing_inventory'"));

    const resBilling = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:secretpassword123@cluster.mongodb.net/billing?retryWrites=true",
    });
    check("2.4. Refuses when MONGODB_URI targets 'billing'",
        !resBilling.ok && resBilling.reason.includes("does not match required 'billing_inventory'"));

    check("2.5. Guard refusal message contains no part of URI, username, password, or host",
        !resBilling.ok &&
        !resBilling.reason.includes("secretpassword123") &&
        !resBilling.reason.includes("user") &&
        !resBilling.reason.includes("cluster.mongodb.net"));

    const resValid = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority",
    });
    check("2.6. Passes when confirmation is 'billing_inventory' and URI targets 'billing_inventory'", resValid.ok);

    // ============================================================
    // 3. EXECUTION MODE RESOLUTION (DRY-RUN DEFAULT & APPLY FLAG)
    // ============================================================
    console.log("\n-- 3. Execution Mode: Dry-Run Default & Apply Flag --");

    // 3.1 Default with empty inputs -> DRY RUN
    const modeDefault = resolveExecutionMode({}, [], {});
    check("3.1. Default execution mode is strictly DRY-RUN", !modeDefault.isApply && modeDefault.modeDescription.includes("DRY-RUN"));

    // 3.2 Explicit --dry-run CLI arg -> DRY RUN
    const modeArgDryRun = resolveExecutionMode({}, ["--dry-run"], {});
    check("3.2. Explicit --dry-run flag resolves to DRY-RUN", !modeArgDryRun.isApply);

    // 3.3 DRY_RUN env variable -> DRY RUN
    const modeEnvDryRun = resolveExecutionMode({}, [], { DRY_RUN: "true" });
    check("3.3. DRY_RUN=true env resolves to DRY-RUN", !modeEnvDryRun.isApply);

    // 3.4 Valid production guard present but NO --apply flag -> still DRY RUN
    const modeGuardNoApply = resolveExecutionMode({}, [], { CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory" });
    check("3.4. Missing --apply flag defaults to DRY-RUN even if confirmation guard is set", !modeGuardNoApply.isApply);

    // 3.5 Explicit --apply CLI flag -> LIVE APPLY
    const modeApplyArg = resolveExecutionMode({}, ["--apply"], {});
    check("3.5. Explicit --apply CLI flag resolves to LIVE APPLY", modeApplyArg.isApply && modeApplyArg.modeDescription.includes("LIVE APPLY"));

    // 3.6 Programmatic options.apply -> LIVE APPLY
    const modeOptApply = resolveExecutionMode({ apply: true }, [], {});
    check("3.6. Programmatic options.apply resolves to LIVE APPLY", modeOptApply.isApply);

    // 3.7 Explicit APPLY_PRODUCTION_INDEX_MIGRATION env -> LIVE APPLY
    const modeEnvApply = resolveExecutionMode({}, [], { APPLY_PRODUCTION_INDEX_MIGRATION: "true" });
    check("3.7. APPLY_PRODUCTION_INDEX_MIGRATION=true resolves to LIVE APPLY", modeEnvApply.isApply);

    // 3.8 Conflict: both --apply and --dry-run passed -> DRY RUN wins safely
    const modeConflict = resolveExecutionMode({ apply: true, dryRun: true }, ["--apply", "--dry-run"], {});
    check("3.8. Conflicting apply and dry-run flags safely resolve to DRY-RUN", !modeConflict.isApply);

    // ============================================================
    // 4. CATALOG AMBIGUITY & INDEX ISOLATION CHECKS
    // ============================================================
    console.log("\n-- 4. Catalog Ambiguity & Index Isolation Checks --");

    const cleanCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_purchaseNo_1", key: { tenantId: 1, purchaseNo: 1 }, unique: true },
        { name: "tenantId_1_supplierId_1", key: { tenantId: 1, supplierId: 1 } },
        { name: "tenantId_1_purchaseDate_-1", key: { tenantId: 1, purchaseDate: -1 } },
        { name: "tenantId_1_paymentStatus_1", key: { tenantId: 1, paymentStatus: 1 } },
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            partialFilterExpression: { operationId: { $exists: true } },
        },
    ];

    const catCheckClean = inspectCatalogForPurchaseOperationId(cleanCatalog);
    check("4.1. Clean catalog with single operationId index accepted",
        catCheckClean.ok && catCheckClean.targetIndex?.name === TARGET_INDEX_NAME);

    check("4.2. Unrelated purchase indexes (purchaseNo, supplierId, purchaseDate, paymentStatus) are ignored and preserved",
        catCheckClean.ok &&
        catCheckClean.targetIndex?.name !== "tenantId_1_purchaseNo_1" &&
        catCheckClean.targetIndex?.name !== "tenantId_1_supplierId_1" &&
        catCheckClean.targetIndex?.name !== "tenantId_1_purchaseDate_-1" &&
        catCheckClean.targetIndex?.name !== "tenantId_1_paymentStatus_1");

    const competingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: TARGET_INDEX_NAME, key: { tenantId: 1, operationId: 1 } },
        { name: "operationId_1", key: { operationId: 1 } },
    ];
    const catCheckCompeting = inspectCatalogForPurchaseOperationId(competingCatalog);
    check("4.3. Multiple competing operationId indexes detected and rejected",
        !catCheckCompeting.ok && catCheckCompeting.reason.includes("competing/ambiguous"));

    const missingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_purchaseNo_1", key: { tenantId: 1, purchaseNo: 1 } },
    ];
    const catCheckMissing = inspectCatalogForPurchaseOperationId(missingCatalog);
    check("4.4. Missing operationId index returns ok with undefined targetIndex",
        catCheckMissing.ok && catCheckMissing.targetIndex === undefined);

    // ============================================================
    // 5. STRICT PURCHASE INDEX CLASSIFICATION
    // ============================================================
    console.log("\n-- 5. Strict Purchase Index Classification --");

    // 5.1 Missing
    const classMissing = classifyPurchaseOperationIdIndex(undefined);
    check("5.1. Undefined index classified as MISSING", classMissing.classification === "MISSING");

    // 5.2 Live Atlas state: OLD_EXISTS_PARTIAL { operationId: { $exists: true } }
    const liveAtlasIndex: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $exists: true },
        },
    };
    const classLive = classifyPurchaseOperationIdIndex(liveAtlasIndex);
    check("5.2. Live Atlas index with { operationId: { $exists: true } } classified as OLD_EXISTS_PARTIAL",
        classLive.classification === "OLD_EXISTS_PARTIAL");

    // 5.3 Legacy compound sparse
    const oldSparse: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: true,
    };
    const classOldSparse = classifyPurchaseOperationIdIndex(oldSparse);
    check("5.3. Legacy compound sparse index classified as OLD_SPARSE",
        classOldSparse.classification === "OLD_SPARSE");

    // 5.4 Intended unique partial
    const intendedPartial: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    };
    const classIntended = classifyPurchaseOperationIdIndex(intendedPartial);
    check("5.4. Correct unique partial index classified as INTENDED_PARTIAL",
        classIntended.classification === "INTENDED_PARTIAL");

    // 5.5 Unexpected name
    const badName: RawIndexInfo = {
        name: "custom_purchase_op_idx",
        key: { tenantId: 1, operationId: 1 },
        unique: true,
    };
    check("5.5. Index with wrong name classified as UNEXPECTED",
        classifyPurchaseOperationIdIndex(badName).classification === "UNEXPECTED");

    // 5.6 Inverted key order
    const badKeyOrder: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { operationId: 1, tenantId: 1 },
        unique: true,
    };
    check("5.6. Index with inverted key order classified as UNEXPECTED",
        classifyPurchaseOperationIdIndex(badKeyOrder).classification === "UNEXPECTED");

    // 5.7 Missing tenantId
    const missingTenant: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { operationId: 1 },
        unique: true,
    };
    check("5.7. Index missing tenantId classified as UNEXPECTED",
        classifyPurchaseOperationIdIndex(missingTenant).classification === "UNEXPECTED");

    // 5.8 Non-unique index
    const notUnique: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: false,
    };
    check("5.8. Non-unique index classified as UNEXPECTED",
        classifyPurchaseOperationIdIndex(notUnique).classification === "UNEXPECTED");

    // 5.9 Unexpected partial filter
    const badPartial: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        partialFilterExpression: { operationId: { $ne: null } },
    };
    check("5.9. Index with unrecognized partial filter classified as UNEXPECTED",
        classifyPurchaseOperationIdIndex(badPartial).classification === "UNEXPECTED");

    // 5.10 Sparse + partial filter conflict
    const sparseAndPartial: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: true,
        partialFilterExpression: { operationId: { $type: "string", $gt: "" } },
    };
    check("5.10. Index with both sparse and partial filter classified as UNEXPECTED",
        classifyPurchaseOperationIdIndex(sparseAndPartial).classification === "UNEXPECTED");

    // ============================================================
    // 6. INDEX DEFINITION VERIFICATION FUNCTION
    // ============================================================
    console.log("\n-- 6. Index Definition Verification Function --");

    check("6.1. Valid intended index definition passes verification",
        verifyPurchaseOperationIdIndexDefinition(intendedPartial).ok);

    check("6.2. Undefined index fails verification",
        !verifyPurchaseOperationIdIndexDefinition(undefined).ok);

    check("6.3. Wrong index name fails verification",
        !verifyPurchaseOperationIdIndexDefinition(badName).ok);

    check("6.4. Inverted key order fails verification",
        !verifyPurchaseOperationIdIndexDefinition(badKeyOrder).ok);

    check("6.5. Unique: false fails verification",
        !verifyPurchaseOperationIdIndexDefinition(notUnique).ok);

    check("6.6. Sparse: true fails verification",
        !verifyPurchaseOperationIdIndexDefinition(oldSparse).ok);

    check("6.7. Live index with { $exists: true } fails verification against target model",
        !verifyPurchaseOperationIdIndexDefinition(liveAtlasIndex).ok);

    check("6.8. Missing partialFilterExpression fails verification",
        !verifyPurchaseOperationIdIndexDefinition({
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
        }).ok);

    check("6.9. Target constants match specification",
        TARGET_COLLECTION_NAME === "purchases" &&
        TARGET_INDEX_NAME === "tenantId_1_operationId_1" &&
        TARGET_INDEX_KEY.tenantId === 1 &&
        TARGET_INDEX_KEY.operationId === 1 &&
        TARGET_PARTIAL_FILTER.operationId.$type === "string" &&
        TARGET_PARTIAL_FILTER.operationId.$gt === "" &&
        OLD_EXISTS_PARTIAL_FILTER.operationId.$exists === true);

    // ============================================================
    // 7. DOCUMENT AUDIT & DUPLICATE DETECTION (IN-MEMORY TESTS)
    // ============================================================
    console.log("\n-- 7. Document Audit & Duplicate Detection --");

    // 7.1 Mixed documents matching all 6 categories
    const mockDataset = [
        { tenantId: "T1", operationId: "op-valid-1" },
        { tenantId: "T1", operationId: "op-valid-2" },
        { tenantId: "T1" }, // missing
        { tenantId: "T1", operationId: undefined }, // missing
        { tenantId: "T1", operationId: null }, // nullValue
        { tenantId: "T1", operationId: "" }, // emptyString
        { tenantId: "T1", operationId: "   " }, // whitespaceOnly
        { tenantId: "T1", operationId: 12345 }, // nonString
        { tenantId: "T2", operationId: "op-valid-1" }, // valid across different tenant
    ];

    const audit1 = auditPurchaseDocumentsInMemory(mockDataset);
    check("7.1. Total documents matches input length", audit1.stats.totalDocuments === 9);
    check("7.2. Valid non-empty string count is accurate", audit1.stats.validNonEmptyString === 3);
    check("7.3. Missing operationId count is accurate", audit1.stats.missing === 2);
    check("7.4. Null operationId count is accurate", audit1.stats.nullValue === 1);
    check("7.5. Empty string count is accurate", audit1.stats.emptyString === 1);
    check("7.6. Whitespace-only count is accurate", audit1.stats.whitespaceOnly === 1);
    check("7.7. Non-string count is accurate", audit1.stats.nonString === 1);
    check("7.8. Sum of categorized stats strictly equals total documents",
        audit1.stats.validNonEmptyString +
        audit1.stats.missing +
        audit1.stats.nullValue +
        audit1.stats.emptyString +
        audit1.stats.whitespaceOnly +
        audit1.stats.nonString === audit1.stats.totalDocuments);

    check("7.9. Same operationId across different tenants does NOT flag as duplicate",
        audit1.duplicates.length === 0);

    // 7.10 Exact duplicate within same tenant
    const duplicateDataset = [
        { tenantId: "T1", operationId: "op-dup-1" },
        { tenantId: "T1", operationId: "op-dup-1" },
        { tenantId: "T1", operationId: "op-other" },
    ];
    const audit2 = auditPurchaseDocumentsInMemory(duplicateDataset);
    check("7.10. Exact duplicate nonempty operationId within same tenant is detected",
        audit2.duplicates.length === 1 &&
        audit2.duplicates[0].tenantId === "T1" &&
        audit2.duplicates[0].operationId === "op-dup-1" &&
        audit2.duplicates[0].count === 2);

    // 7.11 Whitespace-trimmed canonical collision
    const whitespaceCollisionDataset = [
        { tenantId: "T1", operationId: "  op-collision-1 " },
        { tenantId: "T1", operationId: "op-collision-1" },
    ];
    const audit3 = auditPurchaseDocumentsInMemory(whitespaceCollisionDataset);
    check("7.11. Canonical whitespace-trimmed collisions are detected as duplicates",
        audit3.duplicates.length === 1 && audit3.duplicates[0].count === 2);

    // 7.12 Production audit baseline representation (9 valid purchase documents, 0 duplicates)
    const productionAuditRep = [
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-1" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-2" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-3" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-4" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-5" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-6" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-7" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-8" },
        { tenantId: "650000000000000000000001", operationId: "SYNC-P-9" },
    ];
    const auditProd = auditPurchaseDocumentsInMemory(productionAuditRep);
    check("7.12. Live production representation: 9 documents, 9 valid, 0 duplicates, 0 null/empty",
        auditProd.stats.totalDocuments === 9 &&
        auditProd.stats.validNonEmptyString === 9 &&
        auditProd.stats.missing === 0 &&
        auditProd.stats.nullValue === 0 &&
        auditProd.stats.emptyString === 0 &&
        auditProd.stats.whitespaceOnly === 0 &&
        auditProd.stats.nonString === 0 &&
        auditProd.duplicates.length === 0);

    check("7.13. NON_EMPTY_TRIMMED_OPERATION_ID_MATCH checks string type, non-empty, and positive trimmed length",
        NON_EMPTY_TRIMMED_OPERATION_ID_MATCH.operationId.$type === "string" &&
        NON_EMPTY_TRIMMED_OPERATION_ID_MATCH.operationId.$gt === "" &&
        Boolean(NON_EMPTY_TRIMMED_OPERATION_ID_MATCH.$expr));

    // ============================================================
    // 8. DRY-RUN BEHAVIOR & MIGRATION PLANNER LOGIC
    // ============================================================
    console.log("\n-- 8. Dry-Run Behavior & Migration Planner Logic --");

    const planNoop = planPurchaseIndexMigration("INTENDED_PARTIAL", 0);
    check("8.1. Planner returns NOOP for INTENDED_PARTIAL",
        planNoop.action === "NOOP" && planNoop.classification === "INTENDED_PARTIAL");

    const planReplaceLive = planPurchaseIndexMigration("OLD_EXISTS_PARTIAL", 0);
    check("8.2. Planner returns REPLACE for OLD_EXISTS_PARTIAL (live production state)",
        planReplaceLive.action === "REPLACE" && planReplaceLive.classification === "OLD_EXISTS_PARTIAL");

    const planReplaceSparse = planPurchaseIndexMigration("OLD_SPARSE", 0);
    check("8.3. Planner returns REPLACE for OLD_SPARSE",
        planReplaceSparse.action === "REPLACE");

    const planCreate = planPurchaseIndexMigration("MISSING", 0);
    check("8.4. Planner returns CREATE for MISSING",
        planCreate.action === "CREATE");

    const planAbortUnexpected = planPurchaseIndexMigration("UNEXPECTED", 0);
    check("8.5. Planner returns ABORT for UNEXPECTED",
        planAbortUnexpected.action === "ABORT");

    const planConflictAbort = planPurchaseIndexMigration("OLD_EXISTS_PARTIAL", 2);
    check("8.6. Planner returns ABORT when duplicate conflicts exist, overriding REPLACE",
        planConflictAbort.action === "ABORT" && planConflictAbort.conflictsCount === 2);

    // ============================================================
    // 9. CONCURRENCY ADVISORY & RECOVERY GUIDE CHECKS
    // ============================================================
    console.log("\n-- 9. Concurrency Advisory & Recovery Guide Checks --");

    check("9.1. WRITE_PAUSE_ADVISORY documents IndexOptionsConflict constraint",
        WRITE_PAUSE_ADVISORY.includes("IndexOptionsConflict") &&
        WRITE_PAUSE_ADVISORY.includes("pause incoming purchase creation and sync"));

    check("9.2. RECOVERY_PROCEDURE_GUIDE includes exact mongosh manual remediation command",
        RECOVERY_PROCEDURE_GUIDE.includes("db.purchases.createIndex") &&
        RECOVERY_PROCEDURE_GUIDE.includes(TARGET_INDEX_NAME) &&
        RECOVERY_PROCEDURE_GUIDE.includes('$type: "string", $gt: ""'));

    // ============================================================
    // 10. CONNECTION TEARDOWN INVARIANTS
    // ============================================================
    console.log("\n-- 10. Connection Teardown Invariants --");

    let disconnectCalled = false;
    const mockMongooseOpen = {
        connection: { readyState: 1 },
        disconnect: async () => { disconnectCalled = true; },
    };
    const disconnected1 = await safeCloseMongooseConnection(mockMongooseOpen);
    check("10.1. safeCloseMongooseConnection disconnects active connection", disconnected1 && disconnectCalled);

    const mockMongooseClosed = {
        connection: { readyState: 0 },
        disconnect: async () => {},
    };
    const disconnected2 = await safeCloseMongooseConnection(mockMongooseClosed);
    check("10.2. safeCloseMongooseConnection skips disconnect when already closed", !disconnected2);

    const mockMongooseError = {
        connection: { readyState: 1 },
        disconnect: async () => { throw new Error("Teardown network error"); },
    };
    const disconnected3 = await safeCloseMongooseConnection(mockMongooseError);
    check("10.3. safeCloseMongooseConnection swallows disconnect errors without throwing", !disconnected3);

    return summarize();
}

main().then((ok) => {
    process.exit(ok ? 0 : 1);
}).catch((err) => {
    console.error("Test execution error:", err);
    process.exit(1);
});
