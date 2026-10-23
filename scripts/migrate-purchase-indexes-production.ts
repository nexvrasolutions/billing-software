/*
 * Safe MongoDB Purchase Sync Idempotency Index Migration Script (billing_inventory ONLY).
 *
 * Manages the unique partial index on `purchases` for sync idempotency:
 *   - Name: `tenantId_1_operationId_1`
 *   - Key: `{ tenantId: 1, operationId: 1 }`
 *   - Unique: true
 *   - PartialFilterExpression: `{ operationId: { $type: "string", $gt: "" } }`
 *
 * Live Atlas Context:
 *   - Production audit found live index uses: `{ operationId: { $exists: true } }` (OLD_EXISTS_PARTIAL)
 *   - Target definition in lib/models/Purchase.ts: `{ operationId: { $type: "string", $gt: "" } }` (INTENDED_PARTIAL)
 *   - 9 existing purchase documents verified with 0 duplicates and 0 null/empty/non-string values.
 *
 * Index Transition & Concurrency Safety Analysis:
 *   - MongoDB Engine Constraint: MongoDB does not permit two indexes with the identical key pattern
 *     `{ tenantId: 1, operationId: 1 }` to coexist when their partialFilterExpressions differ
 *     (fails with IndexOptionsConflict, error code 85).
 *   - Continuous uniqueness protection cannot be maintained at the storage engine level during replacement
 *     because the old index must be dropped before the new index can be created.
 *   - Operational Recommendation: Purchase writes and sync ingestion should be briefly paused or quieted
 *     during live migration execution to guarantee zero concurrency race conditions.
 *
 * Safety Invariants:
 * 1. Must run with CONFIRM_PRODUCTION_INDEX_MIGRATION="billing_inventory".
 * 2. Requires explicit apply flag (--apply or APPLY_PRODUCTION_INDEX_MIGRATION=true). Defaults to DRY-RUN.
 *    A missing guard or apply flag must never allow DDL.
 * 3. Pre-flight parses MONGODB_URI without regex reliance or credential logging;
 *    fails closed if database is not exactly "billing_inventory".
 * 4. Asserts connected databaseName is exactly "billing_inventory" before any query or write.
 * 5. Inspects index catalog:
 *    - Aborts if multiple competing/ambiguous operationId indexes are detected.
 *    - INTENDED_PARTIAL: Skips safely (idempotent no-op).
 *    - OLD_EXISTS_PARTIAL: Eligible for controlled replacement.
 *    - OLD_SPARSE: Eligible for controlled replacement.
 *    - MISSING: Eligible for creation.
 *    - UNEXPECTED: Hard abort before any write.
 * 6. Pre-audits collection:
 *    - Detects duplicate non-empty canonical operationIds within each tenant; aborts if conflicts exist.
 *    - Categorizes and reports missing, null, empty string, whitespace-only, and non-string operationIds.
 *    - Zero modification or deletion of purchase documents.
 * 7. Preserves all business documents and unrelated indexes (e.g. purchaseNo, supplierId, purchaseDate, paymentStatus).
 * 8. Never inserts, updates, or deletes purchase documents during verification or execution.
 * 9. Explicit preflight output and non-atomic replacement recovery guide.
 * 10. Verifies the final index definition in catalog after creation.
 * 11. Does not log connection URIs, passwords, or credentials.
 * 12. Safe to import or test without connecting to Atlas or executing DDL.
 *
 * Invocations:
 *   Dry Run (Default):
 *     CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory npx tsx scripts/migrate-purchase-indexes-production.ts
 *     -- OR --
 *     CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory npx tsx scripts/migrate-purchase-indexes-production.ts --dry-run
 *
 *   Live Migration (Requires explicit approval before execution):
 *     CONFIRM_PRODUCTION_INDEX_MIGRATION=billing_inventory npx tsx scripts/migrate-purchase-indexes-production.ts --apply
 */

export const PRODUCTION_DATABASE_NAME = "billing_inventory";
export const TARGET_COLLECTION_NAME = "purchases";
export const TARGET_INDEX_NAME = "tenantId_1_operationId_1";

export const TARGET_INDEX_KEY = {
    tenantId: 1,
    operationId: 1,
} as const;

export const TARGET_PARTIAL_FILTER = {
    operationId: { $type: "string", $gt: "" },
} as const;

export const OLD_EXISTS_PARTIAL_FILTER = {
    operationId: { $exists: true },
} as const;

export type IndexClassification =
    | "MISSING"
    | "OLD_EXISTS_PARTIAL"
    | "OLD_SPARSE"
    | "INTENDED_PARTIAL"
    | "UNEXPECTED";

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

export interface PurchaseDocumentAuditStats {
    totalDocuments: number;
    validNonEmptyString: number;
    missing: number;
    nullValue: number;
    emptyString: number;
    whitespaceOnly: number;
    nonString: number;
}

export interface MigrationPlan {
    action: "CREATE" | "REPLACE" | "NOOP" | "ABORT";
    classification: IndexClassification;
    reason: string;
    conflictsCount?: number;
}

export interface MigrationOptions {
    apply?: boolean;
    dryRun?: boolean;
}

export interface MigrationResult {
    ok: boolean;
    isApply: boolean;
    classification?: IndexClassification;
    stats?: PurchaseDocumentAuditStats;
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

    const hasStandardPrefix = trimmed.startsWith("mongodb://");
    const hasSrvPrefix = trimmed.startsWith("mongodb+srv://");
    if (!hasStandardPrefix && !hasSrvPrefix) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI must start with 'mongodb://' or 'mongodb+srv://'." };
    }

    const schemeEnd = trimmed.indexOf("://");
    const afterScheme = trimmed.slice(schemeEnd + 3);

    const firstSlash = afterScheme.indexOf("/");
    if (firstSlash === -1) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI does not specify a database name path segment." };
    }

    const pathAndQuery = afterScheme.slice(firstSlash + 1);
    const queryOrHashIndex = pathAndQuery.search(/[?#]/);
    const rawDbName = queryOrHashIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryOrHashIndex);

    if (rawDbName.length === 0) {
        return { ok: false, reason: "Refusing to run: MONGODB_URI does not specify a database name." };
    }

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
 * Resolves the execution mode.
 * Safe by default: Defaults to DRY-RUN unless explicit apply flag is provided.
 * If dryRun is explicitly requested, it overrides any apply flag.
 */
export function resolveExecutionMode(
    options: MigrationOptions,
    argv: string[],
    env: Record<string, string | undefined>
): { isApply: boolean; modeDescription: string } {
    const hasApplyArg = argv.includes("--apply");
    const hasApplyEnv = env.APPLY_PRODUCTION_INDEX_MIGRATION === "true";
    const explicitApply = options.apply === true || hasApplyArg || hasApplyEnv;

    const hasDryRunArg = argv.includes("--dry-run");
    const hasDryRunEnv = env.DRY_RUN === "true" || env.DRY_RUN === "1";
    const explicitDryRun = options.dryRun === true || hasDryRunArg || hasDryRunEnv;

    if (explicitDryRun || !explicitApply) {
        return {
            isApply: false,
            modeDescription: "DRY-RUN (Safe audit & plan only, ZERO changes written to MongoDB)",
        };
    }

    return {
        isApply: true,
        modeDescription: "LIVE APPLY (Controlled DDL execution on production Atlas)",
    };
}

/**
 * Validates that the purchase index catalog does not contain competing, duplicate, or ambiguous operationId indexes.
 * Pure function: unit testable with simulated index catalogs.
 */
export function inspectCatalogForPurchaseOperationId(
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
 * Classifies the operationId index on the purchases collection.
 * Pure function: unit testable with simulated index catalog entries.
 */
export function classifyPurchaseOperationIdIndex(rawIndex: RawIndexInfo | undefined): IndexInspectionResult {
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

    // Legacy sparse index: unique, sparse, NO partialFilterExpression
    if (isSparse && !partialFilter) {
        return {
            name: TARGET_INDEX_NAME,
            classification: "OLD_SPARSE",
            details: `Index '${TARGET_INDEX_NAME}' has the legacy unique compound sparse option.`,
        };
    }

    // Partial indexes (must not be sparse)
    if (!isSparse && partialFilter && typeof partialFilter === "object") {
        const partialKeys = Object.keys(partialFilter);
        if (partialKeys.length === 1 && partialKeys[0] === "operationId") {
            const fieldFilter = partialFilter.operationId as Record<string, unknown> | undefined;
            if (fieldFilter && typeof fieldFilter === "object") {
                const condKeys = Object.keys(fieldFilter);

                // 1. INTENDED_PARTIAL: { operationId: { $type: "string", $gt: "" } }
                if (
                    condKeys.length === 2 &&
                    fieldFilter.$type === "string" &&
                    fieldFilter.$gt === ""
                ) {
                    return {
                        name: TARGET_INDEX_NAME,
                        classification: "INTENDED_PARTIAL",
                        details: `Index '${TARGET_INDEX_NAME}' already has the intended unique partialFilterExpression { operationId: { $type: "string", $gt: "" } }.`,
                    };
                }

                // 2. OLD_EXISTS_PARTIAL: { operationId: { $exists: true } } (live Atlas state)
                if (condKeys.length === 1 && fieldFilter.$exists === true) {
                    return {
                        name: TARGET_INDEX_NAME,
                        classification: "OLD_EXISTS_PARTIAL",
                        details: `Index '${TARGET_INDEX_NAME}' has the live partial filter { operationId: { $exists: true } } requiring alignment with Purchase model.`,
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
export function verifyPurchaseOperationIdIndexDefinition(rawIndex: RawIndexInfo | undefined): { ok: true } | { ok: false; reason: string } {
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
 * MongoDB match condition that filters for non-empty string operationIds with strictly positive trimmed length.
 */
export const NON_EMPTY_TRIMMED_OPERATION_ID_MATCH = {
    operationId: { $type: "string", $gt: "" },
    $expr: { $gt: [{ $strLenCP: { $trim: { input: "$operationId" } } }, 0] },
};

/**
 * Analyzes in-memory purchase records for duplicate non-empty canonical operationIds
 * and categorizes document counts across all operationId states.
 * Pure function: completely unit-testable without a database.
 */
export function auditPurchaseDocumentsInMemory(
    records: { tenantId?: unknown; operationId?: unknown }[]
): {
    duplicates: { tenantId: string; operationId: string; count: number }[];
    stats: PurchaseDocumentAuditStats;
} {
    const stats: PurchaseDocumentAuditStats = {
        totalDocuments: records.length,
        validNonEmptyString: 0,
        missing: 0,
        nullValue: 0,
        emptyString: 0,
        whitespaceOnly: 0,
        nonString: 0,
    };

    const counts = new Map<string, number>();

    for (const r of records) {
        const tenantId = String(r.tenantId || "").trim();

        if (!("operationId" in r) || r.operationId === undefined) {
            stats.missing += 1;
        } else if (r.operationId === null) {
            stats.nullValue += 1;
        } else if (typeof r.operationId === "string") {
            if (r.operationId === "") {
                stats.emptyString += 1;
            } else if (r.operationId.trim().length === 0) {
                stats.whitespaceOnly += 1;
            } else {
                stats.validNonEmptyString += 1;
                const canonical = r.operationId.trim();
                const key = `${tenantId}:::${canonical}`;
                counts.set(key, (counts.get(key) || 0) + 1);
            }
        } else {
            stats.nonString += 1;
        }
    }

    const duplicates: { tenantId: string; operationId: string; count: number }[] = [];
    for (const [key, count] of counts.entries()) {
        if (count > 1) {
            const [tenantId, operationId] = key.split(":::");
            duplicates.push({ tenantId, operationId, count });
        }
    }

    return { duplicates, stats };
}

/**
 * Computes the migration plan given the current catalog status and duplicate audit results.
 * Pure planner function: unit testable for dry-run verification.
 */
export function planPurchaseIndexMigration(
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
                reason: `Index '${TARGET_INDEX_NAME}' already has the intended unique partial definition { operationId: { $type: "string", $gt: "" } }. No action needed (idempotent).`,
            };
        case "MISSING":
            return {
                action: "CREATE",
                classification,
                reason: `Index '${TARGET_INDEX_NAME}' is missing. Would create unique partial index with filter { operationId: { $type: "string", $gt: "" } }.`,
            };
        case "OLD_EXISTS_PARTIAL":
            return {
                action: "REPLACE",
                classification,
                reason: `Index '${TARGET_INDEX_NAME}' has live partial filter { operationId: { $exists: true } }. Would drop old index and create unique partial index { operationId: { $type: "string", $gt: "" } }.`,
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
2. DO NOT restore the old exists-based index if empty/null operationId sync retries occur.
3. Review the creation error output (e.g. conflicting duplicate operationIds inserted during window).
4. Run mongosh against ${PRODUCTION_DATABASE_NAME}:
     db.${TARGET_COLLECTION_NAME}.createIndex(
       { tenantId: 1, operationId: 1 },
       {
         name: "${TARGET_INDEX_NAME}",
         unique: true,
         partialFilterExpression: { operationId: { $type: "string", $gt: "" } }
       }
     );
5. Verify in mongosh:
     db.${TARGET_COLLECTION_NAME}.getIndexes();
================================================================================
`;

export const WRITE_PAUSE_ADVISORY = `
================================================================================
NOTICE: INDEX TRANSITION & CONCURRENCY RISK ANALYSIS
================================================================================
MongoDB engine constraint: Multiple indexes sharing key { tenantId: 1, operationId: 1 }
with different partialFilterExpressions cannot coexist (MongoDB IndexOptionsConflict).

Therefore, the replacement index cannot be built concurrently alongside the old index.
The old index must be dropped before the new partial index is created.

Operational Recommendation:
Coordinate with operators to briefly pause incoming purchase creation and sync
writes during index replacement execution to eliminate any risk of duplicate operationIds
during the brief unindexed transition window.
================================================================================
`;

/**
 * Main migration driver.
 * Defaults to DRY-RUN. Live execution requires explicit apply flag.
 */
export async function runProductionPurchaseIndexMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
    const { isApply, modeDescription } = resolveExecutionMode(options, process.argv, process.env);

    console.log(`=== SAFE PRODUCTION PURCHASE INDEX MIGRATION (${PRODUCTION_DATABASE_NAME}) ===`);
    console.log(`>>> MODE: ${modeDescription} <<<\n`);

    // 1. Load environment configuration without leaking secrets
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd(), false, { info() { }, error() { } });

    // 2. STAGE 1: Pre-flight Guards
    console.log("[STAGE 1] Checking production guards...");
    const guardCheck = validateProductionGuards({
        CONFIRM_PRODUCTION_INDEX_MIGRATION: process.env.CONFIRM_PRODUCTION_INDEX_MIGRATION,
        MONGODB_URI: process.env.MONGODB_URI,
    });

    if (!guardCheck.ok) {
        console.error(`ABORTED: ${guardCheck.reason}`);
        return { ok: false, isApply, error: guardCheck.reason };
    }
    console.log(`PASS: Guards verified (target database: ${PRODUCTION_DATABASE_NAME}).\n`);

    // 3. Dynamic import to ensure no database connection is attempted before guard validation
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
            return { ok: false, isApply, error: err };
        }

        const actualDbName = db.databaseName;
        if (actualDbName !== PRODUCTION_DATABASE_NAME) {
            const err = `ABORTED: Active database connection '${actualDbName}' is not '${PRODUCTION_DATABASE_NAME}'.`;
            console.error(err);
            return { ok: false, isApply, error: err };
        }
        console.log(`PASS: Connected to active database '${actualDbName}'.\n`);

        const collection = db.collection(TARGET_COLLECTION_NAME);

        // 4. STAGE 2: Index Inspection & Catalog Validation
        console.log("[STAGE 2] Inspecting purchase index catalog...");
        const existingRawIndexes = (await collection.indexes()) as RawIndexInfo[];

        const catalogCheck = inspectCatalogForPurchaseOperationId(existingRawIndexes);
        if (!catalogCheck.ok) {
            const err = `Purchase index catalog check failed: ${catalogCheck.reason} Preserving all indexes.`;
            console.error(`\nABORTED: ${err}`);
            return { ok: false, isApply, error: err };
        }

        const purchaseIndexStatus = classifyPurchaseOperationIdIndex(catalogCheck.targetIndex);
        console.log(`  - Purchase OperationId Index status: [${purchaseIndexStatus.classification}] ${purchaseIndexStatus.details}`);

        if (purchaseIndexStatus.classification === "UNEXPECTED") {
            const err = `Purchase index has unexpected definition: ${purchaseIndexStatus.details}. Preserving all indexes.`;
            console.error(`\nABORTED: ${err}`);
            return { ok: false, isApply, classification: purchaseIndexStatus.classification, error: err };
        }

        // 5. STAGE 3: Pre-Replacement Document & Duplicate Audit
        console.log("\n[STAGE 3] Auditing purchase documents and checking for conflicting operationIds...");

        const [auditFacetResult] = await collection
            .aggregate<{
                duplicates: { _id: { tenantId: unknown; canonicalOperationId: string }; count: number }[];
                stats: {
                    totalDocuments: number;
                    missing: number;
                    nullValue: number;
                    emptyString: number;
                    whitespaceOnly: number;
                    validNonEmptyString: number;
                    nonString: number;
                }[];
            }>([
                {
                    $facet: {
                        duplicates: [
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
                        ],
                        stats: [
                            {
                                $group: {
                                    _id: null,
                                    totalDocuments: { $sum: 1 },
                                    missing: {
                                        $sum: {
                                            $cond: [{ $eq: [{ $type: "$operationId" }, "missing"] }, 1, 0],
                                        },
                                    },
                                    nullValue: {
                                        $sum: {
                                            $cond: [{ $eq: [{ $type: "$operationId" }, "null"] }, 1, 0],
                                        },
                                    },
                                    emptyString: {
                                        $sum: {
                                            $cond: [
                                                {
                                                    $and: [
                                                        { $eq: [{ $type: "$operationId" }, "string"] },
                                                        { $eq: ["$operationId", ""] },
                                                    ],
                                                },
                                                1,
                                                0,
                                            ],
                                        },
                                    },
                                    whitespaceOnly: {
                                        $sum: {
                                            $cond: [
                                                {
                                                    $and: [
                                                        { $eq: [{ $type: "$operationId" }, "string"] },
                                                        { $gt: [{ $strLenCP: "$operationId" }, 0] },
                                                        { $eq: [{ $strLenCP: { $trim: { input: "$operationId" } } }, 0] },
                                                    ],
                                                },
                                                1,
                                                0,
                                            ],
                                        },
                                    },
                                    validNonEmptyString: {
                                        $sum: {
                                            $cond: [
                                                {
                                                    $and: [
                                                        { $eq: [{ $type: "$operationId" }, "string"] },
                                                        { $gt: [{ $strLenCP: { $trim: { input: "$operationId" } } }, 0] },
                                                    ],
                                                },
                                                1,
                                                0,
                                            ],
                                        },
                                    },
                                    nonString: {
                                        $sum: {
                                            $cond: [
                                                {
                                                    $and: [
                                                        { $ne: [{ $type: "$operationId" }, "missing"] },
                                                        { $ne: [{ $type: "$operationId" }, "null"] },
                                                        { $ne: [{ $type: "$operationId" }, "string"] },
                                                    ],
                                                },
                                                1,
                                                0,
                                            ],
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
            ])
            .toArray();

        const rawStats = auditFacetResult?.stats?.[0];
        const stats: PurchaseDocumentAuditStats = {
            totalDocuments: rawStats?.totalDocuments ?? 0,
            validNonEmptyString: rawStats?.validNonEmptyString ?? 0,
            missing: rawStats?.missing ?? 0,
            nullValue: rawStats?.nullValue ?? 0,
            emptyString: rawStats?.emptyString ?? 0,
            whitespaceOnly: rawStats?.whitespaceOnly ?? 0,
            nonString: rawStats?.nonString ?? 0,
        };

        const duplicateGroups = auditFacetResult?.duplicates ?? [];

        console.log("  Document Audit Breakdown (Zero documents modified):");
        console.log(`    - Total purchase documents: ${stats.totalDocuments}`);
        console.log(`    - Valid non-empty string operationId: ${stats.validNonEmptyString}`);
        console.log(`    - Missing operationId: ${stats.missing}`);
        console.log(`    - Null operationId: ${stats.nullValue}`);
        console.log(`    - Empty string operationId (""): ${stats.emptyString}`);
        console.log(`    - Whitespace-only operationId: ${stats.whitespaceOnly}`);
        console.log(`    - Non-string operationId: ${stats.nonString}`);

        const plan = planPurchaseIndexMigration(purchaseIndexStatus.classification, duplicateGroups.length);

        if (duplicateGroups.length > 0) {
            console.error(
                `\nABORTED: Found ${duplicateGroups.length} conflicting nonempty (tenantId, operationId) duplicate group(s).`
            );
            return {
                ok: false,
                isApply,
                classification: purchaseIndexStatus.classification,
                stats,
                plan,
                error: plan.reason,
            };
        }
        console.log("PASS: No duplicate nonempty operationIds found.\n");

        // 6. STAGE 4: Dry-Run Reporting OR Controlled Execution
        if (!isApply) {
            console.log("[STAGE 4 - DRY RUN] Migration Plan Summary:");
            console.log(`  - Target Database: ${PRODUCTION_DATABASE_NAME}`);
            console.log(`  - Target Collection: ${TARGET_COLLECTION_NAME}`);
            console.log(`  - Current Classification: ${plan.classification}`);
            console.log(`  - Planned Action: ${plan.action}`);
            console.log(`  - Details: ${plan.reason}`);
            console.log(WRITE_PAUSE_ADVISORY);
            console.log(`[DRY RUN COMPLETE] Zero modifications made to MongoDB indexes or documents.\n`);
            return {
                ok: true,
                isApply: false,
                classification: purchaseIndexStatus.classification,
                stats,
                plan,
            };
        }

        console.log("[STAGE 4] Performing controlled index migration...");
        console.log(WRITE_PAUSE_ADVISORY);

        if (plan.action === "NOOP") {
            console.log("  - Index already matches intended partial filter. Skipping (idempotent no-op).");
        } else if (plan.action === "REPLACE") {
            console.log(`  - Dropping old index '${TARGET_INDEX_NAME}'...`);
            console.log("  NOTE: Non-atomic replacement risk: Dropping an index and creating its replacement are separate operations. Collection will temporarily remain UNINDEXED on this key.");
            try {
                await collection.dropIndex(TARGET_INDEX_NAME);
            } catch (dropErr) {
                const errMsg = dropErr instanceof Error ? dropErr.message : String(dropErr);
                console.error(`\nCRITICAL FAILURE: Failed to drop old index '${TARGET_INDEX_NAME}': ${errMsg}`);
                console.error("Preserving collection state: Replacement index was NOT created.");
                return {
                    ok: false,
                    isApply: true,
                    classification: purchaseIndexStatus.classification,
                    stats,
                    plan,
                    error: `Failed to drop old index: ${errMsg}`,
                };
            }

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
                console.error("\nCRITICAL FAILURE: Failed to create new purchase partial index after drop!");
                console.error(`State: The index '${TARGET_INDEX_NAME}' was dropped, but recreation failed. Collection is currently UNINDEXED on this key.`);
                console.error(createErr instanceof Error ? createErr.message : String(createErr));
                console.error(RECOVERY_PROCEDURE_GUIDE);
                return {
                    ok: false,
                    isApply: true,
                    classification: purchaseIndexStatus.classification,
                    stats,
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
                console.error("\nCRITICAL FAILURE: Failed to create new purchase partial index!");
                console.error(createErr instanceof Error ? createErr.message : String(createErr));
                return {
                    ok: false,
                    isApply: true,
                    classification: purchaseIndexStatus.classification,
                    stats,
                    plan,
                    error: createErr instanceof Error ? createErr.message : String(createErr),
                };
            }
        }

        // 7. STAGE 5: Non-Destructive Catalog Verification
        // Note: NO purchase documents are inserted, updated, or deleted.
        // Verification inspects the updated index catalog directly.
        console.log("\n[STAGE 5] Verifying final index catalog definition...");
        const refreshedIndexes = (await collection.indexes()) as RawIndexInfo[];
        const targetRefreshed = refreshedIndexes.find((idx) => idx.name === TARGET_INDEX_NAME);
        const verification = verifyPurchaseOperationIdIndexDefinition(targetRefreshed);

        if (!verification.ok) {
            console.error(`\nMIGRATION FAILED: Post-migration catalog verification failed: ${verification.reason}`);
            return {
                ok: false,
                isApply: true,
                classification: purchaseIndexStatus.classification,
                stats,
                plan,
                error: verification.reason,
            };
        }
        console.log(`PASS: Index '${TARGET_INDEX_NAME}' verified in catalog with exact expected keys, unique: true, and partialFilterExpression.\n`);

        console.log(`============================================================`);
        console.log(`PRODUCTION PURCHASE INDEX MIGRATION COMPLETED SUCCESSFULLY.`);
        console.log(`============================================================\n`);
        return {
            ok: true,
            isApply: true,
            classification: purchaseIndexStatus.classification,
            stats,
            plan,
        };
    } finally {
        if (connected) {
            await safeCloseMongooseConnection(mongoose);
        }
    }
}

// Standalone execution guard: never executes upon import
if (
    process.argv[1] &&
    process.argv[1].replace(/\\/g, "/").endsWith("scripts/migrate-purchase-indexes-production.ts")
) {
    runProductionPurchaseIndexMigration()
        .then((res) => {
            process.exit(res.ok ? 0 : 1);
        })
        .catch((err) => {
            console.error("Unexpected production purchase migration error:", err);
            process.exit(1);
        });
}
