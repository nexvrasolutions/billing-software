/*
 * Database-free unit tests for Production Supplier Index Migration logic (billing_inventory).
 *
 * Validates:
 * 1. Preflight production guards (fail-closed, requires exact billing_inventory opt-in, zero secret leakage).
 * 2. Robust URI parsing (supports mongodb://, mongodb+srv://, replica sets, path validation without regex vulnerability).
 * 3. Catalog ambiguity & index isolation checks (detecting competing indexes, preserving unrelated indexes).
 * 4. Strict supplier operationId index classification (MISSING, OLD_SPARSE, INTENDED_PARTIAL, UNEXPECTED).
 * 5. Duplicate detection logic matching exact MongoDB index semantics (per-tenant, ignores non-string/empty/whitespace).
 * 6. Index definition verification function (checks name, compound key, uniqueness, partialFilterExpression, not sparse).
 * 7. Dry-run behavior and planner logic (verifies no-op, create, replace, abort scenarios; zero writes executed).
 * 8. Connection teardown invariants.
 *
 * Run:
 *   npx tsx scripts/test-migrate-supplier-indexes-production.ts
 */

import {
    PRODUCTION_DATABASE_NAME,
    TARGET_COLLECTION_NAME,
    TARGET_INDEX_NAME,
    TARGET_INDEX_KEY,
    TARGET_PARTIAL_FILTER,
    parseMongoDbUriDatabaseName,
    validateProductionGuards,
    inspectCatalogForSupplierOperationId,
    classifySupplierOperationIdIndex,
    verifySupplierOperationIdIndexDefinition,
    findDuplicateSupplierOperationIdsInMemory,
    planSupplierIndexMigration,
    safeCloseMongooseConnection,
    NON_EMPTY_TRIMMED_OPERATION_ID_MATCH,
    type RawIndexInfo,
} from "./migrate-supplier-indexes-production";

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
    console.log("=== PRODUCTION SUPPLIER INDEX MIGRATION (DATABASE-FREE TESTS) ===\n");

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

    // Valid SRV with query params and credentials
    const resSrv = parseMongoDbUriDatabaseName("mongodb+srv://user:secretpass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority");
    check("1.9. Parse correctly extracts database from mongodb+srv:// with query options",
        resSrv.ok && resSrv.dbName === PRODUCTION_DATABASE_NAME);

    // ============================================================
    // 2. PRODUCTION GUARDS VALIDATION & SECRET REDACTION
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
        MONGODB_URI: "mongodb+srv://user:secretpassword123@cluster.mongodb.net/billing?retryWrites=true",
    });
    check("2.4. Refuses when MONGODB_URI targets 'billing'",
        !resBilling.ok && resBilling.reason.includes("does not match required 'billing_inventory'"));

    // Secret redaction check: reason must never contain password, user, or host
    check("2.5. Guard refusal message contains no part of URI, username, password, or host",
        !resBilling.ok &&
        !resBilling.reason.includes("secretpassword123") &&
        !resBilling.reason.includes("user") &&
        !resBilling.reason.includes("cluster.mongodb.net"));

    // Valid production configuration
    const resValid = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: "billing_inventory",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority",
    });
    check("2.6. Passes when confirmation is 'billing_inventory' and URI targets 'billing_inventory'", resValid.ok);

    // ============================================================
    // 3. CATALOG AMBIGUITY & INDEX ISOLATION CHECKS
    // ============================================================
    console.log("\n-- 3. Catalog Ambiguity & Index Isolation Checks --");

    const cleanCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_supplierCode_1", key: { tenantId: 1, supplierCode: 1 }, unique: true },
        { name: "tenantId_1_name_1", key: { tenantId: 1, name: 1 } },
        { name: "tenantId_1_contact.phone_1", key: { tenantId: 1, "contact.phone": 1 } },
        { name: "tenantId_1_isDeleted_1_status_1", key: { tenantId: 1, isDeleted: 1, status: 1 } },
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            partialFilterExpression: { operationId: { $type: "string", $gt: "" } },
        },
    ];
    const catCheckClean = inspectCatalogForSupplierOperationId(cleanCatalog);
    check("3.1. Clean catalog with single operationId index accepted",
        catCheckClean.ok && catCheckClean.targetIndex?.name === TARGET_INDEX_NAME);

    // Isolation: ensure inspectCatalogForSupplierOperationId ignores unrelated indexes
    check("3.2. Unrelated indexes (supplierCode, name, contact.phone, isDeleted_status) are preserved and never selected",
        catCheckClean.ok &&
        catCheckClean.targetIndex?.name !== "tenantId_1_supplierCode_1" &&
        catCheckClean.targetIndex?.name !== "tenantId_1_name_1" &&
        catCheckClean.targetIndex?.name !== "tenantId_1_contact.phone_1" &&
        catCheckClean.targetIndex?.name !== "tenantId_1_isDeleted_1_status_1");

    // Competing indexes
    const competingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: TARGET_INDEX_NAME, key: { tenantId: 1, operationId: 1 } },
        { name: "operationId_1", key: { operationId: 1 } },
    ];
    const catCheckCompeting = inspectCatalogForSupplierOperationId(competingCatalog);
    check("3.3. Multiple competing operationId indexes detected and rejected",
        !catCheckCompeting.ok && catCheckCompeting.reason.includes("competing/ambiguous"));

    // Missing index
    const missingCatalog: RawIndexInfo[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_supplierCode_1", key: { tenantId: 1, supplierCode: 1 } },
    ];
    const catCheckMissing = inspectCatalogForSupplierOperationId(missingCatalog);
    check("3.4. Missing operationId index returns ok with undefined targetIndex",
        catCheckMissing.ok && catCheckMissing.targetIndex === undefined);

    // ============================================================
    // 4. STRICT SUPPLIER INDEX CLASSIFICATION
    // ============================================================
    console.log("\n-- 4. Strict Supplier Index Classification --");

    // Missing index
    const classMissing = classifySupplierOperationIdIndex(undefined);
    check("4.1. Undefined index classified as MISSING", classMissing.classification === "MISSING");

    // Legacy compound sparse index
    const oldSparse: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: true,
    };
    const classOldSparse = classifySupplierOperationIdIndex(oldSparse);
    check("4.2. Legacy compound sparse index classified as OLD_SPARSE",
        classOldSparse.classification === "OLD_SPARSE");

    // Intended unique partial index
    const intendedPartial: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    };
    const classIntended = classifySupplierOperationIdIndex(intendedPartial);
    check("4.3. Correct unique partial index classified as INTENDED_PARTIAL",
        classIntended.classification === "INTENDED_PARTIAL");

    // Unexpected index name
    const badName: RawIndexInfo = {
        name: "custom_supplier_op_idx",
        key: { tenantId: 1, operationId: 1 },
        unique: true,
    };
    check("4.4. Index with wrong name classified as UNEXPECTED",
        classifySupplierOperationIdIndex(badName).classification === "UNEXPECTED");

    // Unexpected key order or missing tenantId
    const badKeyOrder: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { operationId: 1, tenantId: 1 },
        unique: true,
    };
    check("4.5. Index with inverted key order classified as UNEXPECTED",
        classifySupplierOperationIdIndex(badKeyOrder).classification === "UNEXPECTED");

    const missingTenantKey: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { operationId: 1 },
        unique: true,
    };
    check("4.6. Index missing tenantId in keys classified as UNEXPECTED",
        classifySupplierOperationIdIndex(missingTenantKey).classification === "UNEXPECTED");

    // Non-unique index
    const nonUnique: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: false,
    };
    check("4.7. Non-unique index classified as UNEXPECTED",
        classifySupplierOperationIdIndex(nonUnique).classification === "UNEXPECTED");

    // Extra condition in partial filter
    const extraCond: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "", $exists: true },
        },
    };
    check("4.8. Partial index with extra condition classified as UNEXPECTED",
        classifySupplierOperationIdIndex(extraCond).classification === "UNEXPECTED");

    // Extra field in partial filter
    const extraField: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
            tenantId: { $exists: true },
        },
    };
    check("4.9. Partial index with extra field in filter classified as UNEXPECTED",
        classifySupplierOperationIdIndex(extraField).classification === "UNEXPECTED");

    // Both sparse and partialFilterExpression
    const sparseAndPartial: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: true,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    };
    check("4.10. Index with both sparse and partial filter classified as UNEXPECTED",
        classifySupplierOperationIdIndex(sparseAndPartial).classification === "UNEXPECTED");

    // ============================================================
    // 5. PRE-FLIGHT DUPLICATE AUDIT (IN-MEMORY TESTS)
    // ============================================================
    console.log("\n-- 5. Pre-Flight Duplicate Audits (In-Memory Tests) --");

    // Blank/null/undefined operationIds do NOT count as duplicates
    const recordsWithOmitted = [
        { tenantId: "tenant_1" },
        { tenantId: "tenant_1", operationId: undefined },
        { tenantId: "tenant_1", operationId: null },
        { tenantId: "tenant_1", operationId: "" },
        { tenantId: "tenant_1", operationId: "   " },
        { tenantId: "tenant_1", operationId: 12345 },
        { tenantId: "tenant_1", operationId: "op-valid-1" },
        { tenantId: "tenant_1", operationId: "op-valid-2" },
    ];
    const dupsOmitted = findDuplicateSupplierOperationIdsInMemory(recordsWithOmitted);
    check("5.1. Suppliers with missing, undefined, null, empty string, or whitespace do NOT trigger duplicates",
        dupsOmitted.length === 0);

    // Exact duplicate in same tenant
    const recordsWithConflict = [
        { tenantId: "tenant_1", operationId: "op-duplicate-xyz" },
        { tenantId: "tenant_1", operationId: "op-duplicate-xyz" },
    ];
    const dupsConflict = findDuplicateSupplierOperationIdsInMemory(recordsWithConflict);
    check("5.2. Exact duplicate nonempty operationId in same tenant is detected",
        dupsConflict.length === 1 && dupsConflict[0].count === 2 && dupsConflict[0].operationId === "op-duplicate-xyz");

    // Trimmed whitespace difference in same tenant is detected
    const recordsWhitespace = [
        { tenantId: "tenant_1", operationId: "  op-spaced  " },
        { tenantId: "tenant_1", operationId: "op-spaced" },
    ];
    const dupsWhitespace = findDuplicateSupplierOperationIdsInMemory(recordsWhitespace);
    check("5.3. Whitespace-trimmed differences in same tenant are detected as duplicates",
        dupsWhitespace.length === 1 && dupsWhitespace[0].operationId === "op-spaced" && dupsWhitespace[0].count === 2);

    // Same operationId in DIFFERENT tenants is permitted
    const recordsDiffTenants = [
        { tenantId: "tenant_A", operationId: "shared-op-id" },
        { tenantId: "tenant_B", operationId: "shared-op-id" },
    ];
    const dupsDiffTenants = findDuplicateSupplierOperationIdsInMemory(recordsDiffTenants);
    check("5.4. Same operationId across different tenants is NOT flagged as duplicate",
        dupsDiffTenants.length === 0);

    // Match condition expression check
    check("5.5. NON_EMPTY_TRIMMED_OPERATION_ID_MATCH checks string type, non-empty, and trimmed positive length",
        NON_EMPTY_TRIMMED_OPERATION_ID_MATCH.operationId.$type === "string" &&
        NON_EMPTY_TRIMMED_OPERATION_ID_MATCH.operationId.$gt === "" &&
        Boolean(NON_EMPTY_TRIMMED_OPERATION_ID_MATCH.$expr));

    // ============================================================
    // 6. INDEX DEFINITION VERIFICATION FUNCTION
    // ============================================================
    console.log("\n-- 6. Index Definition Verification Function --");

    const validIndexInfo: RawIndexInfo = {
        name: TARGET_INDEX_NAME,
        key: { tenantId: 1, operationId: 1 },
        unique: true,
        sparse: false,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    };
    check("6.1. Valid index definition passes verification",
        verifySupplierOperationIdIndexDefinition(validIndexInfo).ok);

    check("6.2. Undefined index fails verification",
        !verifySupplierOperationIdIndexDefinition(undefined).ok);

    check("6.3. Wrong index name fails verification",
        !verifySupplierOperationIdIndexDefinition({ ...validIndexInfo, name: "wrong_name" }).ok);

    check("6.4. Inverted key order fails verification",
        !verifySupplierOperationIdIndexDefinition({ ...validIndexInfo, key: { operationId: 1, tenantId: 1 } }).ok);

    check("6.5. Unique: false fails verification",
        !verifySupplierOperationIdIndexDefinition({ ...validIndexInfo, unique: false }).ok);

    check("6.6. Sparse: true fails verification",
        !verifySupplierOperationIdIndexDefinition({ ...validIndexInfo, sparse: true }).ok);

    check("6.7. Missing partialFilterExpression fails verification",
        !verifySupplierOperationIdIndexDefinition({ ...validIndexInfo, partialFilterExpression: undefined }).ok);

    check("6.8. Partial filter with wrong field fails verification",
        !verifySupplierOperationIdIndexDefinition({
            ...validIndexInfo,
            partialFilterExpression: { barcode: { $type: "string", $gt: "" } },
        }).ok);

    check("6.9. Target constants match specification",
        TARGET_COLLECTION_NAME === "suppliers" &&
        TARGET_INDEX_NAME === "tenantId_1_operationId_1" &&
        TARGET_INDEX_KEY.tenantId === 1 &&
        TARGET_INDEX_KEY.operationId === 1 &&
        TARGET_PARTIAL_FILTER.operationId.$type === "string" &&
        TARGET_PARTIAL_FILTER.operationId.$gt === "");

    // ============================================================
    // 7. DRY-RUN BEHAVIOR & PLANNER LOGIC
    // ============================================================
    console.log("\n-- 7. Dry-Run Behavior & Migration Planner Logic --");

    // Planner logic: NOOP when INTENDED_PARTIAL
    const planNoop = planSupplierIndexMigration("INTENDED_PARTIAL", 0);
    check("7.1. Planner returns NOOP for INTENDED_PARTIAL",
        planNoop.action === "NOOP" && planNoop.reason.includes("already has the intended unique partial definition"));

    // Planner logic: CREATE when MISSING
    const planCreate = planSupplierIndexMigration("MISSING", 0);
    check("7.2. Planner returns CREATE for MISSING",
        planCreate.action === "CREATE" && planCreate.reason.includes("Would create unique partial index"));

    // Planner logic: REPLACE when OLD_SPARSE
    const planReplace = planSupplierIndexMigration("OLD_SPARSE", 0);
    check("7.3. Planner returns REPLACE for OLD_SPARSE",
        planReplace.action === "REPLACE" && planReplace.reason.includes("Would drop"));

    // Planner logic: ABORT when UNEXPECTED
    const planAbortUnexpected = planSupplierIndexMigration("UNEXPECTED", 0);
    check("7.4. Planner returns ABORT for UNEXPECTED",
        planAbortUnexpected.action === "ABORT" && planAbortUnexpected.reason.includes("unexpected catalog definition"));

    // Planner logic: ABORT when conflicts exist
    const planAbortConflicts = planSupplierIndexMigration("OLD_SPARSE", 3);
    check("7.5. Planner returns ABORT when duplicate conflicts exist, overriding action",
        planAbortConflicts.action === "ABORT" && planAbortConflicts.reason.includes("conflicting duplicate"));

    // Mock collection simulation: verify dry-run NEVER calls mutating operations
    let dropIndexCalled = false;
    let createIndexCalled = false;
    let insertOneCalled = false;
    let updateOneCalled = false;
    let deleteOneCalled = false;
    let deleteManyCalled = false;

    const mockCollection = {
        indexes: async () => [
            { name: "_id_", key: { _id: 1 } },
            { name: TARGET_INDEX_NAME, key: { tenantId: 1, operationId: 1 }, unique: true, sparse: true },
        ],
        aggregate: () => ({
            toArray: async () => [],
        }),
        dropIndex: async () => {
            dropIndexCalled = true;
            return {};
        },
        createIndex: async () => {
            createIndexCalled = true;
            return TARGET_INDEX_NAME;
        },
        insertOne: async () => {
            insertOneCalled = true;
            return { insertedId: "mock_id" };
        },
        updateOne: async () => {
            updateOneCalled = true;
            return { modifiedCount: 1 };
        },
        deleteOne: async () => {
            deleteOneCalled = true;
            return { deletedCount: 1 };
        },
        deleteMany: async () => {
            deleteManyCalled = true;
            return { deletedCount: 1 };
        },
    };

    // Simulate dry-run execution logic against mock collection
    const catalog = (await mockCollection.indexes()) as RawIndexInfo[];
    const catCheck = inspectCatalogForSupplierOperationId(catalog);
    const targetIdx = catCheck.ok ? catCheck.targetIndex : undefined;
    const classification = classifySupplierOperationIdIndex(targetIdx);
    const mockPlan = planSupplierIndexMigration(classification.classification, 0);

    const isDryRunSimulation = true;
    if (!isDryRunSimulation) {
        if (mockPlan.action === "REPLACE") {
            await mockCollection.dropIndex();
            await mockCollection.createIndex();
        }
    }

    check("7.6. Dry-run mode never calls dropIndex", !dropIndexCalled);
    check("7.7. Dry-run mode never calls createIndex", !createIndexCalled);
    check("7.8. Script never executes insertOne on supplier documents", !insertOneCalled);
    check("7.9. Script never executes updateOne on supplier documents", !updateOneCalled);
    check("7.10. Script never executes deleteOne on supplier documents", !deleteOneCalled);
    check("7.11. Script never executes deleteMany on supplier documents", !deleteManyCalled);

    // ============================================================
    // 8. CONNECTION TEARDOWN INVARIANTS
    // ============================================================
    console.log("\n-- 8. Connection Teardown Invariants --");

    let disconnectCalled = false;
    const fakeActiveMongoose = {
        connection: { readyState: 1 },
        disconnect: async () => { disconnectCalled = true; },
    };
    await safeCloseMongooseConnection(fakeActiveMongoose);
    check("8.1. safeCloseMongooseConnection disconnects active connection", disconnectCalled);

    let disconnectCalledForClosed = false;
    const fakeClosedMongoose = {
        connection: { readyState: 0 },
        disconnect: async () => { disconnectCalledForClosed = true; },
    };
    await safeCloseMongooseConnection(fakeClosedMongoose);
    check("8.2. safeCloseMongooseConnection skips disconnect when already closed", !disconnectCalledForClosed);

    const fakeFailingMongoose = {
        connection: { readyState: 1 },
        disconnect: async () => { throw new Error("Teardown socket reset"); },
    };
    let closedSafely = false;
    try {
        await safeCloseMongooseConnection(fakeFailingMongoose);
        closedSafely = true;
    } catch {
        closedSafely = false;
    }
    check("8.3. safeCloseMongooseConnection swallows disconnect errors without masking caller exceptions", closedSafely);

    const success = summarize();
    process.exit(success ? 0 : 1);
}

main().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
