/*
 * Safe MongoDB Supplier Sync Idempotency Index Migration Script (billing_inventory ONLY).
 *
 * Manages the unique partial index on `suppliers` for sync idempotency:
 *   - Name: `tenantId_1_operationId_1`
 *   - Key: `{ tenantId: 1, operationId: 1 }`
 *   - Unique: true
 *   - PartialFilterExpression: `{ operationId: { $type: "string", $gt: "" } }`
 *
 * Safety Invariants:
 * 1. Must run with CONFIRM_PRODUCTION_INDEX_MIGRATION="billing_inventory".
 * 2. Pre-flight parses MONGODB_URI without regex reliance or credential logging;
 *    fails closed if database is not exactly "billing_inventory".
 * 3. Asserts connected databaseName is exactly "billing_inventory" before any query or write.
 * 4. Inspects index catalog:
 *    - Aborts if multiple competing/ambiguous operationId indexes are detected.
 *    - INTENDED_PARTIAL: Skips safely (idempotent no-op).
 *    - OLD_SPARSE: Eligible for controlled replacement.
 *    - MISSING: Eligible for creation.
 *    - UNEXPECTED: Hard abort before any write.
 * 5. Pre-audits collection for duplicate non-empty operationIds per tenant; aborts if conflicts exist.
 * 6. Supports dry-run mode (--dry-run or DRY_RUN=true): audits and reports planned actions without MongoDB changes.
 * 7. Preserves all business documents and unrelated indexes.
 * 8. Never inserts, updates, or deletes supplier documents.
 * 9. Explains non-atomic replacement risk; provides explicit manual recovery steps.
 * 10. Verifies the final index definition in catalog after creation.
 * 11. Does not log connection URIs, passwords, or credentials.
 *
 * Invocations:
 *   Dry Run:
 *     CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory DRY_RUN=true npx tsx scripts/migrate-supplier-indexes-production.ts
 *     -- OR --
 *     CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory npx tsx scripts/migrate-supplier-indexes-production.ts --dry-run
 *
 *   Live Migration (Requires explicit approval before execution):
 *     CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory npx tsx scripts/migrate-supplier-indexes-production.ts
 */

export const PRODUCTION_DATABASE_NAME = "billing_inventory";
export const TARGET_COLLECTION_NAME = "suppliers";
export const TARGET_INDEX_NAME = "tenantId_1_operationId_1";

export const TARGET_INDEX_KEY = {
    tenantId: 1,
    operationId: 1,
} as const;

export const TARGET_PARTIAL_FILTER = {
    operationId: { $type: "string", $gt: "" },
} as const;

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

export interface MigrationPlan {
    action: "CREATE" | "REPLACE" | "NOOP" | "ABORT";
    classification: IndexClassification;
    reason: string;
    conflictsCount?: number;
}

export interface MigrationOptions {
    dryRun?: boolean;
}

export interface MigrationResult {
    ok: boolean;
    dryRun: boolean;
    classification?: IndexClassification;
    plan?: MigrationPlan;
    error?: string;
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
 * Validates that the supplier index catalog does not contain competing, duplicate, or ambiguous operationId indexes.
 * Pure function: unit testable with simulated index catalogs.
 */
export function inspectCatalogForSupplierOperationId(
    indexes: RawIndexInfo[]
): { ok: true; targetIndex?: RawIndexInfo } | { ok: false; reason: string } {
    const matching = indexes.filter(
        (idx) => (idx.key && "operationId" in idx.key) || idx.name === TARGET_INDEX_NAME
    );

    if (matching.length === 0) {
        return { ok: true, targetIndex: undefined };
    }

    if (matching.length > 1) {
        return {
            ok: false,
            reason: `Found ${matching.length} competing/ambiguous indexes involving 'operationId'.`,
        };
    }

    return { ok: true, targetIndex: matching[0] };
}

/**
 * Classifies the operationId index on the suppliers collection.
 * Pure function: unit testable with simulated index catalog entries.
 */
export function classifySupplierOperationIdIndex(rawIndex: RawIndexInfo | undefined): IndexInspectionResult {
    if (!rawIndex) {
        return {
            name: TARGET_INDEX_NAME,
            classification: "MISSING",
            details: `Index '${TARGET_INDEX_NAME}' does not exist on the collection.`,
        };
    }

    if (rawIndex.name !== TARGET_INDEX_NAME) {
        return {
            name: rawIndex.name || TARGET_INDEX_NAME,
            classification: "UNEXPECTED",
            details: `Index name '${rawIndex.name}' does not match expected name '${TARGET_INDEX_NAME}'.`,
        };
    }

    const key = rawIndex.key || {};
    const keyFields = Object.keys(key);
    const hasCorrectKeys =
        keyFields.length === 2 &&
        keyFields[0] === "tenantId" &&
        key["tenantId"] === 1 &&
        keyFields[1] === "operationId" &&
        key["operationId"] === 1;

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
            name: TARGET_INDEX_NAME,
            classification: "OLD_SPARSE",
            details: `Index '${TARGET_INDEX_NAME}' has the legacy unique compound sparse option.`,
        };
    }

    // Check for intended partial index: unique, NOT sparse, strict partialFilterExpression
    if (!isSparse && partialFilter && typeof partialFilter === "object") {
        const partialKeys = Object.keys(partialFilter);
        if (partialKeys.length === 1 && partialKeys[0] === "operationId") {
            const fieldFilter = partialFilter.operationId as Record<string, unknown> | undefined;
            if (fieldFilter && typeof fieldFilter === "object") {
                const condKeys = Object.keys(fieldFilter);
                if (
                    condKeys.length === 2 &&
                    fieldFilter.$type === "string" &&
                    fieldFilter.$gt === ""
                ) {
                    return {
                        name: TARGET_INDEX_NAME,
                        classification: "INTENDED_PARTIAL",
                        details: `Index '${TARGET_INDEX_NAME}' already has the intended unique partialFilterExpression.`,
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
 * Validates the final created index against exact specification requirements.
 * Used for post-creation verification and isolated testing.
 */
export function verifySupplierOperationIdIndexDefinition(rawIndex: RawIndexInfo | undefined): { ok: true } | { ok: false; reason: string } {
    if (!rawIndex) {
        return { ok: false, reason: `Verification failed: index '${TARGET_INDEX_NAME}' is missing from catalog.` };
    }

    if (rawIndex.name !== TARGET_INDEX_NAME) {
        return { ok: false, reason: `Verification failed: index name '${rawIndex.name}' does not match '${TARGET_INDEX_NAME}'.` };
    }

    const key = rawIndex.key || {};
    const keyFields = Object.keys(key);
    if (
        keyFields.length !== 2 ||
        keyFields[0] !== "tenantId" ||
        key["tenantId"] !== 1 ||
        keyFields[1] !== "operationId" ||
        key["operationId"] !== 1
    ) {
        return { ok: false, reason: `Verification failed: key pattern ${JSON.stringify(key)} does not match { tenantId: 1, operationId: 1 }.` };
    }

    if (rawIndex.unique !== true) {
        return { ok: false, reason: `Verification failed: unique is ${rawIndex.unique}, expected true.` };
    }

    if (rawIndex.sparse) {
        return { ok: false, reason: `Verification failed: sparse is true, expected false or omitted.` };
    }

    const partialFilter = rawIndex.partialFilterExpression;
    if (!partialFilter || typeof partialFilter !== "object") {
        return { ok: false, reason: `Verification failed: partialFilterExpression is missing or not an object.` };
    }

    const partialKeys = Object.keys(partialFilter);
    if (partialKeys.length !== 1 || partialKeys[0] !== "operationId") {
        return { ok: false, reason: `Verification failed: partialFilterExpression has unexpected fields: ${JSON.stringify(partialKeys)}.` };
    }

    const opFilter = partialFilter.operationId as Record<string, unknown> | undefined;
    if (
        !opFilter ||
        typeof opFilter !== "object" ||
        Object.keys(opFilter).length !== 2 ||
        opFilter.$type !== "string" ||
        opFilter.$gt !== ""
    ) {
        return { ok: false, reason: `Verification failed: partialFilterExpression.operationId must be { $type: "string", $gt: "" }, received: ${JSON.stringify(opFilter)}.` };
    }

    return { ok: true };
}

/**
 * MongoDB match condition that filters out missing, null, empty, and whitespace-only operationIds.
 * Pure condition: index-friendly while ensuring trimmed length is strictly positive.
 */
export const NON_EMPTY_TRIMMED_OPERATION_ID_MATCH = {
    operationId: { $type: "string", $gt: "" },
    $expr: { $gt: [{ $strLenCP: { $trim: { input: "$operationId" } } }, 0] },
};

/**
 * Scans in-memory records for duplicate non-empty canonical operationIds per tenant.
 * Matches canonical normalization rules: trim whitespace and exclude blank/whitespace-only values.
 */
export function findDuplicateSupplierOperationIdsInMemory(
    records: { tenantId: unknown; operationId?: unknown }[]
): { tenantId: string; operationId: string; count: number }[] {
    const counts = new Map<string, number>();

    for (const r of records) {
        const tenantId = String(r.tenantId || "").trim();
        const val = r.operationId;
        if (typeof val === "string" && val.trim().length > 0) {
            const canonical = val.trim();
            const key = `${tenantId}:::${canonical}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    const duplicates: { tenantId: string; operationId: string; count: number }[] = [];
    for (const [key, count] of counts.entries()) {
        if (count > 1) {
            const [tenantId, operationId] = key.split(":::");
            duplicates.push({ tenantId, operationId, count });
        }
    }

    return duplicates;
}

/**
 * Computes the migration plan given the current catalog status and duplicate audit results.
 * Pure planner function: unit testable for dry-run verification.
 */
export function planSupplierIndexMigration(
    classification: IndexClassification,
    conflictsCount: number
): MigrationPlan {
    if (conflictsCount > 0) {
        return {
            action: "ABORT",
            classification,
            reason: `Found ${conflictsCount} conflicting duplicate nonempty (tenantId, operationId) pairs. Resolve conflicts before migrating.`,
            conflictsCount,
        };
    }

    switch (classification) {
        case "INTENDED_PARTIAL":
            return {
                action: "NOOP",
                classification,
                reason: `Index '${TARGET_INDEX_NAME}' already has the intended unique partial definition. No action needed (idempotent).`,
            };
        case "MISSING":
            return {
                action: "CREATE",
                classification,
                reason: `Index '${TARGET_INDEX_NAME}' is missing. Would create unique partial index with filter { operationId: { $type: "string", $gt: "" } }.`,
            };
        case "OLD_SPARSE":
            return {
                action: "REPLACE",
                classification,
                reason: `Index '${TARGET_INDEX_NAME}' has legacy sparse setting. Would drop '${TARGET_INDEX_NAME}' and create unique partial index.`,
            };
        case "UNEXPECTED":
        default:
            return {
                action: "ABORT",
                classification,
                reason: `Index '${TARGET_INDEX_NAME}' has an unexpected catalog definition. Manual inspection required before modifying.`,
            };
    }
}

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

export const RECOVERY_PROCEDURE_GUIDE = `
================================================================================
MANUAL RECOVERY PROCEDURE (IF REPLACEMENT CREATION FAILS POST-DROP)
================================================================================
1. The collection '${TARGET_COLLECTION_NAME}' is currently UNINDEXED on { tenantId: 1, operationId: 1 }.
2. DO NOT restore the old sparse index if retried sync operations could collide.
3. Review the creation error output (e.g. conflicting non-empty operationIds).
4. Run mongosh against ${PRODUCTION_DATABASE_NAME}:
     db.${TARGET_COLLECTION_NAME}.createIndex(
       { tenantId: 1, operationId: 1 },
       {
         name: "${TARGET_INDEX_NAME}",
         unique: true,
         partialFilterExpression: { operationId: { $type: "string", $gt: "" } }
       }
     );
================================================================================
`;

/**
 * Main migration driver.
 * Supports { dryRun: true } to inspect and report without making changes.
 */
export async function runProductionSupplierIndexMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
    const isDryRun = Boolean(
        options.dryRun ??
        (process.env.DRY_RUN === "true" ||
         process.env.DRY_RUN === "1" ||
         process.argv.includes("--dry-run"))
    );

    console.log(`=== SAFE PRODUCTION SUPPLIER INDEX MIGRATION (${PRODUCTION_DATABASE_NAME}) ===`);
    if (isDryRun) {
        console.log(`>>> MODE: DRY-RUN (Audit & Plan only, NO changes will be written to MongoDB) <<<\n`);
    } else {
        console.log(`>>> MODE: LIVE MIGRATION <<<\n`);
    }

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
        return { ok: false, dryRun: isDryRun, error: guardCheck.reason };
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
            const err = "ABORTED: Database connection handle is not available.";
            console.error(err);
            return { ok: false, dryRun: isDryRun, error: err };
        }

        const actualDbName = db.databaseName;
        if (actualDbName !== PRODUCTION_DATABASE_NAME) {
            const err = `ABORTED: Active database connection '${actualDbName}' is not '${PRODUCTION_DATABASE_NAME}'.`;
            console.error(err);
            return { ok: false, dryRun: isDryRun, error: err };
        }
        console.log(`PASS: Connected to active database '${actualDbName}'.\n`);

        const collection = db.collection(TARGET_COLLECTION_NAME);

        // 4. STAGE 2: Index Inspection & Catalog Validation
        console.log("[STAGE 2] Inspecting supplier index catalog...");
        const existingRawIndexes = (await collection.indexes()) as RawIndexInfo[];

        const catalogCheck = inspectCatalogForSupplierOperationId(existingRawIndexes);
        if (!catalogCheck.ok) {
            const err = `Supplier index catalog check failed: ${catalogCheck.reason} Preserving all indexes.`;
            console.error(`\nABORTED: ${err}`);
            return { ok: false, dryRun: isDryRun, error: err };
        }

        const supplierIndexStatus = classifySupplierOperationIdIndex(catalogCheck.targetIndex);
        console.log(`  - Supplier OperationId Index status: [${supplierIndexStatus.classification}] ${supplierIndexStatus.details}`);

        if (supplierIndexStatus.classification === "UNEXPECTED") {
            const err = `Supplier index has unexpected definition: ${supplierIndexStatus.details}. Preserving all indexes.`;
            console.error(`\nABORTED: ${err}`);
            return { ok: false, dryRun: isDryRun, classification: supplierIndexStatus.classification, error: err };
        }

        // 5. STAGE 3: Pre-Replacement Duplicate Audit
        console.log("\n[STAGE 3] Auditing data for conflicting non-empty operationIds per tenant (trimmed)...");
        const duplicateOperationIds = await collection
            .aggregate([
                { $match: NON_EMPTY_TRIMMED_OPERATION_ID_MATCH },
                {
                    $group: {
                        _id: {
                            tenantId: "$tenantId",
                            canonicalOperationId: { $trim: { input: "$operationId" } },
                        },
                        count: { $sum: 1 },
                    },
                },
                { $match: { count: { $gt: 1 } } },
            ])
            .toArray();

        const plan = planSupplierIndexMigration(supplierIndexStatus.classification, duplicateOperationIds.length);

        if (duplicateOperationIds.length > 0) {
            console.error(
                `\nABORTED: Found ${duplicateOperationIds.length} conflicting nonempty (tenantId, operationId) duplicate group(s).`
            );
            return { ok: false, dryRun: isDryRun, classification: supplierIndexStatus.classification, plan, error: plan.reason };
        }
        console.log("PASS: No duplicate nonempty operationIds found.\n");

        // 6. STAGE 4: Dry-Run Reporting OR Controlled Execution
        if (isDryRun) {
            console.log("[STAGE 4 - DRY RUN] Migration Plan Summary:");
            console.log(`  - Target Database: ${PRODUCTION_DATABASE_NAME}`);
            console.log(`  - Target Collection: ${TARGET_COLLECTION_NAME}`);
            console.log(`  - Current Classification: ${plan.classification}`);
            console.log(`  - Planned Action: ${plan.action}`);
            console.log(`  - Details: ${plan.reason}`);
            console.log(`\n[DRY RUN COMPLETE] Zero modifications made to MongoDB indexes or documents.\n`);
            return { ok: true, dryRun: true, classification: supplierIndexStatus.classification, plan };
        }

        console.log("[STAGE 4] Performing controlled index migration...");
        if (plan.action === "NOOP") {
            console.log("  - Index already matches intended partial filter. Skipping (idempotent no-op).");
        } else if (plan.action === "REPLACE") {
            console.log(`  - Dropping legacy compound sparse index '${TARGET_INDEX_NAME}'...`);
            console.log("  NOTE: Non-atomic replacement risk: Dropping an index and creating its replacement are separate operations. If creation fails post-drop, the collection will temporarily remain UNINDEXED on this key.");
            await collection.dropIndex(TARGET_INDEX_NAME);

            console.log(`  - Creating unique partial index '${TARGET_INDEX_NAME}'...`);
            try {
                await collection.createIndex(
                    TARGET_INDEX_KEY,
                    {
                        name: TARGET_INDEX_NAME,
                        unique: true,
                        partialFilterExpression: TARGET_PARTIAL_FILTER,
                    }
                );
                console.log(`  - Unique partial index '${TARGET_INDEX_NAME}' created successfully.`);
            } catch (createErr) {
                console.error("\nCRITICAL FAILURE: Failed to create new supplier partial index after drop!");
                console.error(`State: The index '${TARGET_INDEX_NAME}' was dropped, but recreation failed. Collection is currently UNINDEXED on this key.`);
                console.error(createErr instanceof Error ? createErr.message : String(createErr));
                console.error(RECOVERY_PROCEDURE_GUIDE);
                return {
                    ok: false,
                    dryRun: false,
                    classification: supplierIndexStatus.classification,
                    plan,
                    error: createErr instanceof Error ? createErr.message : String(createErr),
                };
            }
        } else if (plan.action === "CREATE") {
            console.log(`  - Creating unique partial index '${TARGET_INDEX_NAME}'...`);
            try {
                await collection.createIndex(
                    TARGET_INDEX_KEY,
                    {
                        name: TARGET_INDEX_NAME,
                        unique: true,
                        partialFilterExpression: TARGET_PARTIAL_FILTER,
                    }
                );
                console.log(`  - Unique partial index '${TARGET_INDEX_NAME}' created successfully.`);
            } catch (createErr) {
                console.error("\nCRITICAL FAILURE: Failed to create new supplier partial index!");
                console.error(createErr instanceof Error ? createErr.message : String(createErr));
                return {
                    ok: false,
                    dryRun: false,
                    classification: supplierIndexStatus.classification,
                    plan,
                    error: createErr instanceof Error ? createErr.message : String(createErr),
                };
            }
        }

        // 7. STAGE 5: Non-Destructive Catalog Verification
        // Note: In strict adherence to safety requirements, NO supplier documents are inserted, updated, or deleted.
        // Verification inspects the updated index catalog directly.
        console.log("\n[STAGE 5] Verifying final index catalog definition...");
        const refreshedIndexes = (await collection.indexes()) as RawIndexInfo[];
        const targetRefreshed = refreshedIndexes.find((idx) => idx.name === TARGET_INDEX_NAME);
        const verification = verifySupplierOperationIdIndexDefinition(targetRefreshed);

        if (!verification.ok) {
            console.error(`\nMIGRATION FAILED: Post-migration catalog verification failed: ${verification.reason}`);
            return {
                ok: false,
                dryRun: false,
                classification: supplierIndexStatus.classification,
                plan,
                error: verification.reason,
            };
        }
        console.log(`PASS: Index '${TARGET_INDEX_NAME}' verified in catalog with exact expected keys, unique: true, and partialFilterExpression.\n`);

        console.log(`============================================================`);
        console.log(`PRODUCTION SUPPLIER INDEX MIGRATION COMPLETED SUCCESSFULLY.`);
        console.log(`============================================================\n`);
        return { ok: true, dryRun: false, classification: supplierIndexStatus.classification, plan };
    } finally {
        if (connected) {
            await safeCloseMongooseConnection(mongoose);
        }
    }
}

// Standalone execution guard: never executes upon import
if (
    process.argv[1] &&
    process.argv[1].replace(/\\/g, "/").endsWith("scripts/migrate-supplier-indexes-production.ts")
) {
    runProductionSupplierIndexMigration()
        .then((res) => {
            process.exit(res.ok ? 0 : 1);
        })
        .catch((err) => {
            console.error("Unexpected production supplier migration error:", err);
            process.exit(1);
        });
}
