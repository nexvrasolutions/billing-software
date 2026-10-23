/*
 * Safe MongoDB Product Barcode Index Migration Script (billing_inventory ONLY).
 *
 * Replaces the flawed legacy compound sparse index:
 *   - `tenantId_1_barcode_1`
 * with the intended unique partial index filtering for non-empty strings:
 *   `{ barcode: { $type: "string", $gt: "" } }`.
 *
 * Safety Invariants:
 * 1. Must run with CONFIRM_PRODUCTION_INDEX_MIGRATION="billing_inventory".
 * 2. Pre-flight parses MONGODB_URI without regex reliance or credential logging;
 *    fails closed if database is not exactly "billing_inventory".
 * 3. Asserts connected databaseName is exactly "billing_inventory" before any query or write.
 * 4. Inspects index catalog:
 *    - Aborts if multiple competing/ambiguous barcode indexes are detected.
 *    - INTENDED_PARTIAL: Skips safely (idempotent).
 *    - OLD_SPARSE: Eligible for migration.
 *    - UNEXPECTED / MISSING: Hard abort before any write.
 * 5. Pre-audits collection for duplicate non-empty barcodes per tenant; aborts if conflicts exist.
 * 6. Preserves all business documents and unrelated indexes.
 * 7. Explains non-atomic replacement risk; provides explicit recovery steps.
 * 8. Conducts isolated ephemeral verification with strict ID tracking and guaranteed cleanup.
 * 9. Treats incomplete cleanup or verification failures as migration failure.
 * 10. Does not log connection URIs, passwords, or credentials.
 *
 * Invocation:
 *   CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory npx tsx scripts/migrate-product-indexes-production.ts
 */

export const PRODUCTION_DATABASE_NAME = "billing_inventory";

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
 * Robust MongoDB URI database name parser.
 * Does not rely solely on regex. Fails closed without leaking credentials or URIs.
 */
export function parseMongoDbUriDatabaseName(uri: string | undefined): { ok: true; dbName: string } | { ok: false; reason: string } {
    if (!uri || typeof uri !== "string") {
        return { ok: false, reason: "Refusing to run: MONGODB_URI is not defined." };
    }

    const trimmed = uri.trim();
    if (trimmed.length === 0) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI is empty." };
    }

    // Protocol check
    const hasStandardPrefix = trimmed.startsWith("mongodb://");
    const hasSrvPrefix = trimmed.startsWith("mongodb+srv://");
    if (!hasStandardPrefix && !hasSrvPrefix) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI must start with 'mongodb://' or 'mongodb+srv://'." };
    }

    const schemeEnd = trimmed.indexOf("://");
    const afterScheme = trimmed.slice(schemeEnd + 3);

    // Locate the first '/' separating host(s)/authority from path
    const firstSlash = afterScheme.indexOf("/");
    if (firstSlash === -1) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI does not specify a database name path segment." };
    }

    const pathAndQuery = afterScheme.slice(firstSlash + 1);
    // Find where database name ends: at '?', '#', or end of string
    const queryOrHashIndex = pathAndQuery.search(/[?#]/);
    const rawDbName = queryOrHashIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryOrHashIndex);

    if (rawDbName.length === 0) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI does not specify a database name." };
    }

    // A valid database name cannot contain another slash
    if (rawDbName.includes("/")) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI contains an invalid database path segment." };
    }

    let decodedDbName: string;
    try {
        decodedDbName = decodeURIComponent(rawDbName);
    } catch {
        return { ok: false, reason: "Refusing to run: MONGODB_URI contains an undecodable database path segment." };
    }

    if (!decodedDbName || decodedDbName.trim() !== decodedDbName) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI database name is invalid." };
    }

    return { ok: true, dbName: decodedDbName };
}

/**
 * Validates pre-flight production environment guards.
 * Pure function: fails closed without leaking connection strings or credentials.
 */
export function validateProductionGuards(env: {
    CONFIRM_PRODUCTION_INDEX_MIGRATION?: string;
    MONGODB_URI?: string;
}): { ok: true } | { ok: false; reason: string } {
    if (env.CONFIRM_PRODUCTION_INDEX_MIGRATION !== PRODUCTION_DATABASE_NAME) {
        return {
            ok: false,
            reason: `Refusing to run: CONFIRM_PRODUCTION_INDEX_MIGRATION must be explicitly set to '${PRODUCTION_DATABASE_NAME}'.`,
        };
    }

    const parsed = parseMongoDbUriDatabaseName(env.MONGODB_URI);
    if (!parsed.ok) {
        return {
            ok: false,
            reason: parsed.reason,
        };
    }

    if (parsed.dbName !== PRODUCTION_DATABASE_NAME) {
        return {
            ok: false,
            reason: `Refusing to run: Target database in MONGODB_URI does not match required '${PRODUCTION_DATABASE_NAME}'.`,
        };
    }

    return { ok: true };
}

/**
 * Validates that the index catalog does not contain competing, duplicate, or ambiguous barcode indexes.
 * Pure function: unit testable with simulated index catalogs.
 */
export function inspectCatalogForBarcode(
    indexes: RawIndexInfo[]
): { ok: true; targetIndex?: RawIndexInfo } | { ok: false; reason: string } {
    const matching = indexes.filter(
        (idx) => (idx.key && "barcode" in idx.key) || idx.name === "tenantId_1_barcode_1"
    );

    if (matching.length === 0) {
        return { ok: true, targetIndex: undefined };
    }

    if (matching.length > 1) {
        return {
            ok: false,
            reason: `Found ${matching.length} competing/ambiguous indexes involving 'barcode'.`,
        };
    }

    return { ok: true, targetIndex: matching[0] };
}

/**
 * Classifies the barcode index on the products collection.
 * Pure function: unit testable with simulated index catalog entries.
 */
export function classifyBarcodeIndex(rawIndex: RawIndexInfo | undefined): IndexInspectionResult {
    const expectedIndexName = "tenantId_1_barcode_1";

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
        keyFields[1] === "barcode" &&
        key["barcode"] === 1;

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
        if (partialKeys.length === 1 && partialKeys[0] === "barcode") {
            const fieldFilter = partialFilter.barcode as Record<string, unknown> | undefined;
            if (fieldFilter && typeof fieldFilter === "object") {
                const condKeys = Object.keys(fieldFilter);
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
 * MongoDB match condition that filters out missing, null, empty, and whitespace-only barcodes.
 * Pure condition: index-friendly while ensuring trimmed length is strictly positive.
 */
export const NON_EMPTY_TRIMMED_BARCODE_MATCH = {
    barcode: { $type: "string", $gt: "" },
    $expr: { $gt: [{ $strLenCP: { $trim: { input: "$barcode" } } }, 0] },
};

/**
 * Reliable Mongoose disconnect helper.
 * Swallows disconnect errors so original migration outcomes or exceptions are preserved.
 */
export async function safeCloseMongooseConnection(mongooseInstance: {
    connection: { readyState: number };
    disconnect: () => Promise<void>;
}): Promise<boolean> {
    if (mongooseInstance && mongooseInstance.connection.readyState !== 0) {
        try {
            await mongooseInstance.disconnect();
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Scans in-memory records for duplicate non-empty canonical barcodes per tenant.
 * Matches canonical normalization rules: trim whitespace, uppercase, and exclude blank/whitespace-only values.
 */
export function findDuplicateBarcodesInMemory(
    records: { tenantId: unknown; barcode?: unknown }[]
): { tenantId: string; canonicalBarcode: string; count: number }[] {
    const counts = new Map<string, number>();

    for (const r of records) {
        const tenantId = String(r.tenantId || "").trim();
        const val = r.barcode;
        if (typeof val === "string" && val.trim().length > 0) {
            const canonical = val.trim().toUpperCase();
            const key = `${tenantId}:::${canonical}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    const duplicates: { tenantId: string; canonicalBarcode: string; count: number }[] = [];
    for (const [key, count] of counts.entries()) {
        if (count > 1) {
            const [tenantId, canonicalBarcode] = key.split(":::");
            duplicates.push({ tenantId, canonicalBarcode, count });
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

export const RECOVERY_PROCEDURE_GUIDE = `
================================================================================
MANUAL RECOVERY PROCEDURE (IF REPLACEMENT CREATION FAILS POST-DROP)
================================================================================
1. The collection is currently UNINDEXED on { tenantId: 1, barcode: 1 }.
2. DO NOT restore the old compound sparse index if multiple blank barcodes exist.
3. Review the creation error output (e.g. conflicting non-empty barcodes).
4. Run mongosh against ${PRODUCTION_DATABASE_NAME}:
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

export async function runProductionBarcodeIndexMigration(): Promise<boolean> {
    console.log(`=== SAFE PRODUCTION BARCODE INDEX MIGRATION (${PRODUCTION_DATABASE_NAME}) ===\n`);

    // 1. Load environment configuration without leaking secrets
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

    // 2. STAGE 1: Pre-flight Guards
    console.log("[STAGE 1] Checking production guards...");
    const guardCheck = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: process.env.CONFIRM_PRODUCTION_INDEX_MIGRATION,
        MONGODB_URI: process.env.MONGODB_URI,
    });

    if (!guardCheck.ok) {
        console.error(`ABORTED: ${guardCheck.reason}`);
        return false;
    }
    console.log(`PASS: Guards verified (target database: ${PRODUCTION_DATABASE_NAME}).\n`);

    // 3. Dynamic import to ensure no database module is loaded before guard validation
    const { connectDB } = await import("../lib/db/mongodb");
    const mongoose = (await import("mongoose")).default;

    let connected = false;

    try {
        await connectDB();
        connected = true;
        const db = mongoose.connection.db;
        if (!db) {
            console.error("ABORTED: Database connection handle is not available.");
            return false;
        }

        const actualDbName = db.databaseName;
        if (actualDbName !== PRODUCTION_DATABASE_NAME) {
            console.error(`ABORTED: Active database connection '${actualDbName}' is not '${PRODUCTION_DATABASE_NAME}'.`);
            return false;
        }
        console.log(`PASS: Connected to active database '${actualDbName}'.\n`);

        const collection = db.collection("products");

        // 4. STAGE 2: Index Inspection & Catalog Validation
        console.log("[STAGE 2] Inspecting barcode index and catalog...");
        const existingRawIndexes = (await collection.indexes()) as RawIndexInfo[];

        const catalogCheck = inspectCatalogForBarcode(existingRawIndexes);
        if (!catalogCheck.ok) {
            console.error(`\nABORTED: Barcode index catalog check failed: ${catalogCheck.reason} Preserving all indexes.`);
            return false;
        }

        const barcodeStatus = classifyBarcodeIndex(catalogCheck.targetIndex);
        console.log(`  - Barcode Index status: [${barcodeStatus.classification}] ${barcodeStatus.details}`);

        if (barcodeStatus.classification === "UNEXPECTED") {
            console.error(`\nABORTED: Barcode index has unexpected definition: ${barcodeStatus.details}. Preserving all indexes.`);
            return false;
        }

        if (barcodeStatus.classification === "MISSING") {
            console.error(`\nABORTED: Barcode index 'tenantId_1_barcode_1' is MISSING. Aborting to prevent modifying unconfirmed schemas.`);
            return false;
        }

        // 5. STAGE 3: Pre-Replacement Duplicate Audit
        console.log("\n[STAGE 3] Auditing data for conflicting non-empty barcodes (canonical trim + uppercase)...");
        const barcodeDuplicates = await collection
            .aggregate([
                { $match: NON_EMPTY_TRIMMED_BARCODE_MATCH },
                {
                    $group: {
                        _id: {
                            tenantId: "$tenantId",
                            canonicalBarcode: { $toUpper: { $trim: { input: "$barcode" } } },
                        },
                        count: { $sum: 1 },
                    },
                },
                { $match: { count: { $gt: 1 } } },
            ])
            .toArray();

        if (barcodeDuplicates.length > 0) {
            console.error(
                `\nABORTED: Found ${barcodeDuplicates.length} canonical non-empty barcode conflict(s). Resolve conflicts before migrating.`
            );
            return false;
        }
        console.log("PASS: No duplicate non-empty barcodes found.\n");

        // 6. STAGE 4: Controlled Replacement
        console.log("[STAGE 4] Performing controlled index replacement...");
        console.log("  NOTE: Non-atomic replacement risk: Dropping an index and creating its replacement are separate operations. If creation fails post-drop, the collection will temporarily remain UNINDEXED on this key.");

        if (barcodeStatus.classification === "INTENDED_PARTIAL") {
            console.log("  - Barcode index already has the intended partial filter. Skipping replacement (idempotent).");
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
                console.log("  - Unique partial barcode index created successfully.");
            } catch (createErr) {
                console.error("\nCRITICAL FAILURE: Failed to create new barcode partial index after drop!");
                console.error("State: The index 'tenantId_1_barcode_1' was dropped, but recreation failed. Collection is currently UNINDEXED on this key.");
                console.error(createErr instanceof Error ? createErr.message : String(createErr));
                console.error(RECOVERY_PROCEDURE_GUIDE);
                return false;
            }
        }

        // 7. STAGE 5: Isolated Post-Migration Verification & Clean-up
        console.log(`\n[STAGE 5] Running isolated verification against ${PRODUCTION_DATABASE_NAME}...`);
        const insertedIds: any[] = [];
        let verificationError: Error | null = null;

        const testTenantId = new mongoose.Types.ObjectId();
        const testCategoryId = new mongoose.Types.ObjectId();
        const testUnitId = new mongoose.Types.ObjectId();

        try {
            // Verification 1: Insert product 1 with absent barcode
            const p1 = await collection.insertOne({
                tenantId: testTenantId,
                name: "Migration Verification Prod 1 (No Barcode)",
                SKU: `MIG-PROD-V1-${Date.now()}`,
                categoryId: testCategoryId,
                unitId: testUnitId,
                sellingPrice: 100,
                purchasePrice: 50,
                stockQuantity: 10,
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            insertedIds.push(p1.insertedId);

            // Verification 2: Insert product 2 with absent barcode in SAME tenant (must succeed)
            const p2 = await collection.insertOne({
                tenantId: testTenantId,
                name: "Migration Verification Prod 2 (No Barcode)",
                SKU: `MIG-PROD-V2-${Date.now()}`,
                categoryId: testCategoryId,
                unitId: testUnitId,
                sellingPrice: 120,
                purchasePrice: 60,
                stockQuantity: 5,
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            insertedIds.push(p2.insertedId);
            console.log("  - Check 1: Multiple products with absent barcode permitted in the same tenant (No E11000).");

            // Verification 3: Insert product 3 with non-empty barcode (must succeed)
            const testBarcode = `VERIFY-BAR-${Date.now()}`;
            const p3 = await collection.insertOne({
                tenantId: testTenantId,
                name: "Migration Verification Prod 3 (With Barcode)",
                SKU: `MIG-PROD-V3-${Date.now()}`,
                barcode: testBarcode,
                categoryId: testCategoryId,
                unitId: testUnitId,
                sellingPrice: 150,
                purchasePrice: 75,
                stockQuantity: 15,
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            insertedIds.push(p3.insertedId);

            // Verification 4: Attempt duplicate non-empty barcode in same tenant (must fail with E11000)
            let duplicateCaught = false;
            try {
                const p4 = await collection.insertOne({
                    tenantId: testTenantId,
                    name: "Migration Verification Prod 4 (Duplicate Barcode)",
                    SKU: `MIG-PROD-V4-${Date.now()}`,
                    barcode: testBarcode,
                    categoryId: testCategoryId,
                    unitId: testUnitId,
                    sellingPrice: 160,
                    purchasePrice: 80,
                    stockQuantity: 2,
                    status: "active",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
                // If it unexpectedly SUCCEEDED: capture ID so cleanup removes it, but fail verification
                insertedIds.push(p4.insertedId);
            } catch (e: any) {
                if (e && e.code === 11000) {
                    duplicateCaught = true;
                } else {
                    throw e;
                }
            }

            if (!duplicateCaught) {
                throw new Error("Verification failed: Duplicate non-empty barcode was not rejected with E11000.");
            }
            console.log("  - Check 2: Duplicate non-empty barcode correctly rejected with E11000.");
        } catch (verifErr) {
            verificationError = verifErr instanceof Error ? verifErr : new Error(String(verifErr));
            console.error(`  - Verification error: ${verificationError.message}`);
        } finally {
            const cleanupOutcome = await executeTrackedCleanup(collection, insertedIds, PRODUCTION_DATABASE_NAME);
            if (cleanupOutcome.attempted) {
                if (cleanupOutcome.success) {
                    console.log(`  - Cleanup: Successfully removed all ${cleanupOutcome.deletedCount} ephemeral verification document(s).`);
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

        console.log(`\n============================================================`);
        console.log(`PRODUCTION BARCODE INDEX MIGRATION COMPLETED SUCCESSFULLY.`);
        console.log(`============================================================\n`);
        return true;
    } finally {
        if (connected) {
            await safeCloseMongooseConnection(mongoose);
        }
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/migrate-product-indexes-production.ts")) {
    runProductionBarcodeIndexMigration()
        .then((ok) => {
            process.exit(ok ? 0 : 1);
        })
        .catch((err) => {
            console.error("Unexpected production migration error:", err);
            process.exit(1);
        });
}
