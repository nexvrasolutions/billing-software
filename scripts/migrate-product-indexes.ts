/*
 * Safe MongoDB Product Index Migration Script (billing_test ONLY).
 *
 * Replaces the flawed compound sparse indexes on `products`:
 *   - `tenantId_1_barcode_1`
 *   - `tenantId_1_operationId_1`
 * with unique partial indexes filtering for non-empty strings:
 *   `{ [field]: { $type: "string", $gt: "" } }`.
 *
 * Safety Invariants:
 * 1. Must run under NODE_ENV=test and ALLOW_INDEX_MIGRATION=YES.
 * 2. Refuses immediately before connecting if the target is not exactly `billing_test`.
 * 3. Inspects and classifies existing indexes; aborts if either index is UNEXPECTED or has competing definitions.
 * 4. Pre-checks for duplicate non-empty barcodes and operationIds per tenant; aborts if any exist.
 * 5. Explains non-atomic index replacements explicitly; reports unindexed state on creation failure.
 * 6. Verification uses a dedicated test tenant and tracks exact inserted document IDs for deletion.
 * 7. Incomplete cleanup or verification failure causes the migration to return failure.
 * 8. Never outputs environment variables, connection URIs, or credentials.
 *
 * Invocation (Requires separate explicit approval before running):
 *   NODE_ENV=test ALLOW_INDEX_MIGRATION=YES npx tsx scripts/migrate-product-indexes.ts
 */

import { assertTestDatabaseUri, TEST_DATABASE_NAME } from "./lib/testDatabaseGuard";

export type IndexClassification = "MISSING" | "OLD_SPARSE" | "INTENDED_PARTIAL" | "UNEXPECTED";

export interface IndexInspectionResult {
    name: string;
    classification: IndexClassification;
    details: string;
}

export interface RawIndexInfo {
    name?: string;
    key?: Record<string, unknown>;
    unique?: boolean;
    sparse?: boolean;
    partialFilterExpression?: Record<string, unknown>;
}

export interface CleanupOutcome {
    attempted: boolean;
    success: boolean;
    trackedCount: number;
    deletedCount: number;
    error?: string;
    warning?: string;
}

/**
 * Validates pre-flight environment guards before any database connection.
 * Pure function: unit testable without network or database access.
 */
export function validateMigrationGuards(env: {
    NODE_ENV?: string;
    ALLOW_INDEX_MIGRATION?: string;
    MONGODB_URI?: string;
}): { ok: true } | { ok: false; reason: string } {
    if (env.NODE_ENV === "production") {
        return { ok: false, reason: "Refusing to run: NODE_ENV is set to production." };
    }

    if (env.NODE_ENV !== "test") {
        return { ok: false, reason: "Refusing to run: NODE_ENV must be set to 'test'." };
    }

    if (env.ALLOW_INDEX_MIGRATION !== "YES") {
        return {
            ok: false,
            reason: "Refusing to run: ALLOW_INDEX_MIGRATION must be explicitly set to 'YES'.",
        };
    }

    try {
        assertTestDatabaseUri(env.MONGODB_URI);
    } catch (err) {
        return {
            ok: false,
            reason: err instanceof Error ? err.message : "Database URI validation failed.",
        };
    }

    return { ok: true };
}

/**
 * Validates that the index catalog does not contain competing, duplicate, or ambiguous indexes.
 * Pure function: unit testable with simulated index catalogs.
 */
export function inspectCatalogForField(
    indexes: RawIndexInfo[],
    fieldName: "barcode" | "operationId"
): { ok: true; targetIndex?: RawIndexInfo } | { ok: false; reason: string } {
    const matching = indexes.filter(
        (idx) => (idx.key && fieldName in idx.key) || idx.name === `tenantId_1_${fieldName}_1`
    );

    if (matching.length === 0) {
        return { ok: true, targetIndex: undefined };
    }

    if (matching.length > 1) {
        return {
            ok: false,
            reason: `Found ${matching.length} competing/ambiguous indexes involving '${fieldName}'.`,
        };
    }

    return { ok: true, targetIndex: matching[0] };
}

/**
 * Classifies a single target index on the products collection.
 * Pure function: unit testable with simulated index catalog entries.
 */
export function classifyProductIndex(
    rawIndex: RawIndexInfo | undefined,
    fieldName: "barcode" | "operationId"
): IndexInspectionResult {
    const expectedIndexName = `tenantId_1_${fieldName}_1`;

    if (!rawIndex) {
        return {
            name: expectedIndexName,
            classification: "MISSING",
            details: `Index '${expectedIndexName}' does not exist on the collection.`,
        };
    }

    if (rawIndex.name !== expectedIndexName) {
        return {
            name: rawIndex.name || expectedIndexName,
            classification: "UNEXPECTED",
            details: `Index name '${rawIndex.name}' does not match expected name '${expectedIndexName}'.`,
        };
    }

    const key = rawIndex.key || {};
    const keyFields = Object.keys(key);
    const hasCorrectKeys =
        keyFields.length === 2 &&
        keyFields[0] === "tenantId" &&
        key["tenantId"] === 1 &&
        keyFields[1] === fieldName &&
        key[fieldName] === 1;

    if (!hasCorrectKeys) {
        return {
            name: rawIndex.name,
            classification: "UNEXPECTED",
            details: `Index '${rawIndex.name}' has unexpected key pattern: ${JSON.stringify(key)}.`,
        };
    }

    if (rawIndex.unique !== true) {
        return {
            name: rawIndex.name,
            classification: "UNEXPECTED",
            details: `Index '${rawIndex.name}' is not unique (unique: ${rawIndex.unique}).`,
        };
    }

    const isSparse = Boolean(rawIndex.sparse);
    const partialFilter = rawIndex.partialFilterExpression;

    // Check for legacy compound sparse index: unique, sparse, NO partialFilterExpression
    if (isSparse && !partialFilter) {
        return {
            name: expectedIndexName,
            classification: "OLD_SPARSE",
            details: `Index '${expectedIndexName}' has the legacy unique compound sparse option.`,
        };
    }

    // Check for intended partial index: unique, NOT sparse, strict partialFilterExpression
    if (!isSparse && partialFilter && typeof partialFilter === "object") {
        const partialKeys = Object.keys(partialFilter);
        if (partialKeys.length === 1 && partialKeys[0] === fieldName) {
            const fieldFilter = partialFilter[fieldName] as Record<string, unknown> | undefined;
            if (fieldFilter && typeof fieldFilter === "object") {
                const condKeys = Object.keys(fieldFilter);

                if (fieldName === "barcode") {
                    if (
                        condKeys.length === 2 &&
                        fieldFilter.$type === "string" &&
                        fieldFilter.$gt === ""
                    ) {
                        return {
                            name: expectedIndexName,
                            classification: "INTENDED_PARTIAL",
                            details: `Index '${expectedIndexName}' already has the intended unique partialFilterExpression.`,
                        };
                    }
                } else if (fieldName === "operationId") {
                    // Accepts either project convention: ($type: "string", $gt: "") OR ($exists: true)
                    const isTypeGt =
                        condKeys.length === 2 &&
                        fieldFilter.$type === "string" &&
                        fieldFilter.$gt === "";
                    const isExists =
                        condKeys.length === 1 &&
                        fieldFilter.$exists === true;

                    if (isTypeGt || isExists) {
                        return {
                            name: expectedIndexName,
                            classification: "INTENDED_PARTIAL",
                            details: `Index '${expectedIndexName}' already has the intended unique partialFilterExpression.`,
                        };
                    }
                }
            }
        }
    }

    return {
        name: rawIndex.name,
        classification: "UNEXPECTED",
        details: `Index '${rawIndex.name}' has unexpected options (unique: ${rawIndex.unique}, sparse: ${isSparse}, partialFilter: ${Boolean(partialFilter)}).`,
    };
}

/**
 * Scans in-memory records for duplicate non-empty strings per tenant.
 * Matches MongoDB partialFilterExpression { [fieldName]: { $type: "string", $gt: "" } }.
 * Does not lowercase or trim values.
 */
export function findTenantDuplicates(
    records: { tenantId: unknown; [key: string]: unknown }[],
    fieldName: string
): { tenantId: string; value: string; count: number }[] {
    const counts = new Map<string, number>();

    for (const r of records) {
        const tenantId = String(r.tenantId || "").trim();
        const val = r[fieldName];
        if (typeof val === "string" && val.length > 0) {
            const key = `${tenantId}:::${val}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    const duplicates: { tenantId: string; value: string; count: number }[] = [];
    for (const [key, count] of counts.entries()) {
        if (count > 1) {
            const [tenantId, value] = key.split(":::");
            duplicates.push({ tenantId, value, count });
        }
    }

    return duplicates;
}

/**
 * Executes cleanup targeting only the exact tracked inserted document IDs.
 * Unit testable with mock collections.
 */
export async function executeTrackedCleanup(
    collection: { deleteMany: (query: { _id: { $in: any[] } }) => Promise<{ deletedCount?: number }> },
    insertedIds: any[],
    targetDbName: string
): Promise<CleanupOutcome> {
    if (insertedIds.length === 0) {
        return { attempted: false, success: true, trackedCount: 0, deletedCount: 0 };
    }

    try {
        const res = await collection.deleteMany({ _id: { $in: insertedIds } });
        const deletedCount = res.deletedCount || 0;
        if (deletedCount !== insertedIds.length) {
            const warning =
                `Cleanup mismatch: expected to remove ${insertedIds.length} verification document(s), but removed ${deletedCount}. ` +
                `Verification records may remain in ${targetDbName}. Manual inspection is required. DO NOT assume database is clean.`;
            return {
                attempted: true,
                success: false,
                trackedCount: insertedIds.length,
                deletedCount,
                warning,
            };
        }
        return {
            attempted: true,
            success: true,
            trackedCount: insertedIds.length,
            deletedCount,
        };
    } catch (err) {
        const error =
            `Cleanup exception: ${err instanceof Error ? err.message : String(err)}. ` +
            `Failed to execute cleanup query for ${insertedIds.length} tracked IDs. ` +
            `Verification records may remain in ${targetDbName}. Manual inspection is required.`;
        return {
            attempted: true,
            success: false,
            trackedCount: insertedIds.length,
            deletedCount: 0,
            error,
        };
    }
}

/**
 * Migration execution stages definition and recovery guide.
 */
export const MIGRATION_STAGES = {
    STAGE_1_PREFLIGHT_GUARDS: "1. Pre-flight Environment & Database Name Guards",
    STAGE_2_INDEX_CLASSIFICATION: "2. Target Index Classification & Duplicate Pre-Audit",
    STAGE_3_BARCODE_INDEX_REPLACEMENT: "3. Barcode Index Controlled Replacement",
    STAGE_4_OPERATION_ID_INDEX_REPLACEMENT: "4. OperationId Index Controlled Replacement",
    STAGE_5_POST_MIGRATION_VERIFICATION: "5. Isolated Verification & Exact ID Cleanup",
} as const;

export const RECOVERY_PROCEDURE_GUIDE = `
================================================================================
MANUAL RECOVERY PROCEDURE (IF REPLACEMENT CREATION FAILS POST-DROP)
================================================================================
If an index was dropped but creation of the replacement index failed:
1. The collection is currently UNINDEXED on the affected key.
   - Products can still be created, but tenant-scoped uniqueness is unconstrained
     at the database level for that field until the index is restored.
2. DO NOT blindly restore the old compound sparse index if documents with missing
   barcodes exist in the same tenant, as MongoDB will throw duplicate key errors.
3. Review the creation error (e.g., existing uncleaned duplicates).
4. Resolve duplicate records in the affected tenant if any exist.
5. Manually create the partial index via mongosh against billing_test:
     db.products.createIndex(
       { tenantId: 1, barcode: 1 },
       {
         name: "tenantId_1_barcode_1",
         unique: true,
         partialFilterExpression: { barcode: { $type: "string", $gt: "" } }
       }
     );
================================================================================
`;

/**
 * Main migration runner.
 * Executed only when explicitly invoked with approved credentials.
 */
export async function runProductIndexMigration(): Promise<boolean> {
    console.log(`=== SAFE PRODUCT INDEX MIGRATION (${TEST_DATABASE_NAME} ONLY) ===\n`);

    // Load test environment configuration (.env.test.local when NODE_ENV=test)
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

    // STAGE 1: Pre-flight Guards
    console.log("[STAGE 1] Checking guards...");
    const guardCheck = validateMigrationGuards({
        NODE_ENV: process.env.NODE_ENV,
        ALLOW_INDEX_MIGRATION: process.env.ALLOW_INDEX_MIGRATION,
        MONGODB_URI: process.env.MONGODB_URI,
    });

    if (!guardCheck.ok) {
        console.error(`ABORTED: ${guardCheck.reason}`);
        return false;
    }
    console.log(`PASS: Guards verified (NODE_ENV=test, ALLOW_INDEX_MIGRATION=YES, target=${TEST_DATABASE_NAME}).\n`);

    const { connectDB } = await import("../lib/db/mongodb");
    const mongoose = (await import("mongoose")).default;

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
        console.error("ABORTED: Database connection handle is not available.");
        return false;
    }

    const actualDbName = db.databaseName;
    if (actualDbName !== TEST_DATABASE_NAME) {
        console.error(`ABORTED: Active database connection '${actualDbName}' is not '${TEST_DATABASE_NAME}'.`);
        return false;
    }

    const collection = db.collection("products");

    // STAGE 2: Index Classification & Duplicate Pre-Audit
    console.log("[STAGE 2] Inspecting current indexes and data integrity...");
    const existingRawIndexes = (await collection.indexes()) as RawIndexInfo[];

    // 2.1 Inspect catalog for competing/ambiguous indexes
    const barcodeCatalog = inspectCatalogForField(existingRawIndexes, "barcode");
    if (!barcodeCatalog.ok) {
        console.error(`\nABORTED: Barcode index catalog check failed: ${barcodeCatalog.reason} Aborting before modifying any index.`);
        return false;
    }

    const opIdCatalog = inspectCatalogForField(existingRawIndexes, "operationId");
    if (!opIdCatalog.ok) {
        console.error(`\nABORTED: OperationId index catalog check failed: ${opIdCatalog.reason} Aborting before modifying any index.`);
        return false;
    }

    // 2.2 Classify target indexes
    const barcodeStatus = classifyProductIndex(barcodeCatalog.targetIndex, "barcode");
    const opIdStatus = classifyProductIndex(opIdCatalog.targetIndex, "operationId");

    console.log(`  - Barcode Index status: [${barcodeStatus.classification}] ${barcodeStatus.details}`);
    console.log(`  - OperationId Index status: [${opIdStatus.classification}] ${opIdStatus.details}`);

    if (barcodeStatus.classification === "UNEXPECTED") {
        console.error(`\nABORTED: Barcode index has unexpected definition: ${barcodeStatus.details}. Aborting before modifying any index.`);
        return false;
    }

    if (opIdStatus.classification === "UNEXPECTED") {
        console.error(`\nABORTED: OperationId index has unexpected definition: ${opIdStatus.details}. Aborting before modifying any index.`);
        return false;
    }

    if (barcodeStatus.classification === "MISSING") {
        console.error(`\nABORTED: Barcode index is MISSING. Aborting before modifying any index.`);
        return false;
    }

    // 2.3 Pre-check for duplicate non-empty barcodes per tenant
    const barcodeDuplicates = await collection
        .aggregate([
            { $match: { barcode: { $type: "string", $gt: "" } } },
            { $group: { _id: { tenantId: "$tenantId", barcode: "$barcode" }, count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
        ])
        .toArray();

    if (barcodeDuplicates.length > 0) {
        console.error(
            `\nABORTED: Found ${barcodeDuplicates.length} duplicate non-empty barcode conflict(s) across tenants. Resolve conflicts before migrating.`
        );
        return false;
    }

    // 2.4 Pre-check for duplicate non-empty operationIds per tenant (if operationId index is old sparse)
    if (opIdStatus.classification === "OLD_SPARSE") {
        const opIdDuplicates = await collection
            .aggregate([
                { $match: { operationId: { $type: "string", $gt: "" } } },
                { $group: { _id: { tenantId: "$tenantId", operationId: "$operationId" }, count: { $sum: 1 } } },
                { $match: { count: { $gt: 1 } } },
            ])
            .toArray();

        if (opIdDuplicates.length > 0) {
            console.error(
                `\nABORTED: Found ${opIdDuplicates.length} duplicate non-empty operationId conflict(s) across tenants. Resolve conflicts before migrating.`
            );
            return false;
        }
    }
    console.log("PASS: No duplicate non-empty barcodes or operationIds found.\n");

    // STAGE 3: Barcode Index Controlled Replacement
    console.log("[STAGE 3] Migrating barcode index...");
    console.log("  NOTE: Non-atomic replacement risk: Dropping an index and creating its replacement are separate operations. If creation fails post-drop, the collection will temporarily remain UNINDEXED on this key.");

    if (barcodeStatus.classification === "INTENDED_PARTIAL") {
        console.log("  - Barcode index already has intended partial filter. Preserving index and skipping replacement.");
    } else if (barcodeStatus.classification === "OLD_SPARSE") {
        console.log("  - Dropping legacy compound sparse index 'tenantId_1_barcode_1'...");
        await collection.dropIndex("tenantId_1_barcode_1");

        console.log("  - Creating unique partial index 'tenantId_1_barcode_1'...");
        try {
            await collection.createIndex(
                { tenantId: 1, barcode: 1 },
                {
                    name: "tenantId_1_barcode_1",
                    unique: true,
                    partialFilterExpression: { barcode: { $type: "string", $gt: "" } },
                }
            );
            console.log("  - Barcode partial index created successfully.");
        } catch (createErr) {
            console.error("\nCRITICAL FAILURE: Failed to create new barcode partial index after dropping 'tenantId_1_barcode_1'!");
            console.error("State: The index 'tenantId_1_barcode_1' was dropped, but creation failed. The collection is currently UNINDEXED on this key.");
            console.error(createErr instanceof Error ? createErr.message : String(createErr));
            console.error(RECOVERY_PROCEDURE_GUIDE);
            return false;
        }
    }

    // STAGE 4: OperationId Index Controlled Replacement
    console.log("\n[STAGE 4] Checking operationId index...");
    if (opIdStatus.classification === "INTENDED_PARTIAL") {
        console.log("  - OperationId index already has intended partial filter. Preserving index and skipping replacement.");
    } else if (opIdStatus.classification === "OLD_SPARSE") {
        console.log("  - Confirmed legacy compound sparse index 'tenantId_1_operationId_1'. Dropping legacy index...");
        await collection.dropIndex("tenantId_1_operationId_1");

        console.log("  - Creating unique partial index 'tenantId_1_operationId_1'...");
        try {
            await collection.createIndex(
                { tenantId: 1, operationId: 1 },
                {
                    name: "tenantId_1_operationId_1",
                    unique: true,
                    partialFilterExpression: { operationId: { $type: "string", $gt: "" } },
                }
            );
            console.log("  - OperationId partial index created successfully.");
        } catch (createErr) {
            console.error("\nCRITICAL FAILURE: Failed to create new operationId partial index after dropping 'tenantId_1_operationId_1'!");
            console.error("State: The index 'tenantId_1_operationId_1' was dropped, but creation failed. The collection is currently UNINDEXED on this key.");
            console.error(createErr instanceof Error ? createErr.message : String(createErr));
            console.error(RECOVERY_PROCEDURE_GUIDE);
            return false;
        }
    } else if (opIdStatus.classification === "MISSING") {
        console.log("  - OperationId index 'tenantId_1_operationId_1' is MISSING on target database. Preserving missing state (no index created).");
    }

    // STAGE 5: Isolated Verification & Exact ID Cleanup
    console.log(`\n[STAGE 5] Running isolated verification against ${TEST_DATABASE_NAME}...`);
    const insertedIds: any[] = [];
    let verificationError: Error | null = null;

    const testTenantId = new mongoose.Types.ObjectId();
    const testCategoryId = new mongoose.Types.ObjectId();
    const testUnitId = new mongoose.Types.ObjectId();

    try {
        // Test 5.1: Multiple products without barcodes in the same tenant must both succeed
        const res1 = await collection.insertOne({
            tenantId: testTenantId,
            name: "Migration Test Prod 1",
            SKU: `MIG-TEST-1-${Date.now()}`,
            categoryId: testCategoryId,
            unitId: testUnitId,
            sellingPrice: 100,
            purchasePrice: 50,
            stockQuantity: 10,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        insertedIds.push(res1.insertedId);

        const res2 = await collection.insertOne({
            tenantId: testTenantId,
            name: "Migration Test Prod 2",
            SKU: `MIG-TEST-2-${Date.now()}`,
            categoryId: testCategoryId,
            unitId: testUnitId,
            sellingPrice: 150,
            purchasePrice: 75,
            stockQuantity: 5,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        insertedIds.push(res2.insertedId);
        console.log("  - Check 1: Multiple products with absent barcode created successfully without E11000 collision.");

        // Test 5.2: Product with non-empty barcode succeeds
        const barcodeVal = `MIG-BAR-${Date.now()}`;
        const res3 = await collection.insertOne({
            tenantId: testTenantId,
            name: "Migration Test Prod 3",
            SKU: `MIG-TEST-3-${Date.now()}`,
            barcode: barcodeVal,
            categoryId: testCategoryId,
            unitId: testUnitId,
            sellingPrice: 200,
            purchasePrice: 100,
            stockQuantity: 20,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        insertedIds.push(res3.insertedId);

        // Test 5.3: Duplicate non-empty barcode in same tenant must throw E11000
        let duplicateCaught = false;
        try {
            const res4 = await collection.insertOne({
                tenantId: testTenantId,
                name: "Migration Test Prod 4 Dup",
                SKU: `MIG-TEST-4-${Date.now()}`,
                barcode: barcodeVal,
                categoryId: testCategoryId,
                unitId: testUnitId,
                sellingPrice: 250,
                purchasePrice: 120,
                stockQuantity: 15,
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            // If it unexpectedly SUCCEEDED: capture ID for cleanup, but fail verification
            insertedIds.push(res4.insertedId);
        } catch (e: any) {
            if (e && e.code === 11000) {
                duplicateCaught = true;
            } else {
                throw e;
            }
        }
        if (!duplicateCaught) {
            throw new Error("Expected duplicate barcode insertion to fail with E11000, but it succeeded!");
        }
        console.log("  - Check 2: Duplicate non-empty barcode correctly rejected by partial index with E11000.");
    } catch (err) {
        verificationError = err instanceof Error ? err : new Error(String(err));
        console.error(`  - Verification check failed: ${verificationError.message}`);
    } finally {
        const cleanupOutcome = await executeTrackedCleanup(collection, insertedIds, TEST_DATABASE_NAME);
        if (cleanupOutcome.attempted) {
            if (cleanupOutcome.success) {
                console.log(`  - Cleanup: Successfully removed all ${cleanupOutcome.deletedCount} verification test record(s).`);
            } else {
                console.error(`\nCRITICAL CLEANUP FAILURE: ${cleanupOutcome.error || cleanupOutcome.warning}`);
            }
        }

        if (verificationError) {
            console.error(`\nMIGRATION FAILED: Verification phase encountered an error: ${verificationError.message}`);
            if (!cleanupOutcome.success) {
                console.error(`Additionally, cleanup failed: ${cleanupOutcome.error || cleanupOutcome.warning}`);
            }
            return false;
        }

        if (!cleanupOutcome.success) {
            console.error(`\nMIGRATION FAILED: Verification checks succeeded, but cleanup failed: ${cleanupOutcome.error || cleanupOutcome.warning}`);
            return false;
        }
    }

    console.log("\n============================================================");
    console.log("PRODUCT INDEX MIGRATION COMPLETED SUCCESSFULLY.");
    console.log("============================================================\n");
    return true;
}

// Self-execute only when run as main script (not imported in tests)
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/migrate-product-indexes.ts")) {
    runProductIndexMigration()
        .then((ok) => {
            process.exit(ok ? 0 : 1);
        })
        .catch((err) => {
            console.error("Unexpected migration error:", err);
            process.exit(1);
        });
}
