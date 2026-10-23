/*
 * Strictly Read-Only Production Operation-ID Index Audit (billing_inventory ONLY).
 *
 * Inspects index metadata for:
 *   1. `billing_inventory.products`
 *   2. `billing_inventory.stockmovements`
 *
 * Checks compliance with expected Mongoose model index declarations:
 *   - Product:        { tenantId: 1, operationId: 1 }, unique: true, partialFilterExpression: { operationId: { $type: "string", $gt: "" } }
 *   - StockMovement:  { tenantId: 1, operationId: 1 }, unique: true, partialFilterExpression: { operationId: { $exists: true } }
 *
 * Safety Invariants:
 * 1. Strictly READ-ONLY. Invokes only `collection.listIndexes().toArray()`.
 *    Zero document queries, zero updates, zero deletes, zero index creations or drops.
 * 2. Requires explicit confirmation: CONFIRM_PRODUCTION_INDEX_AUDIT="billing_inventory".
 * 3. Fails closed if MONGODB_URI does not specify database "billing_inventory".
 * 4. Asserts connected client databaseName is exactly "billing_inventory".
 * 5. Never prints, logs, or exposes MONGODB_URI, credentials, passwords, or secrets.
 * 6. Does not execute automatically on import.
 *
 * Reference invocation (requires explicit approval before execution):
 *   CONFIRM_PRODUCTION_INDEX_AUDIT=billing_inventory npx tsx scripts/audit-production-operation-indexes.ts
 */

import { MongoClient } from "mongodb";
import { parseMongoDbUriDatabaseName } from "./migrate-product-indexes-production";

export const AUDIT_DATABASE_NAME = "billing_inventory";
export const TARGET_COLLECTIONS = ["products", "stockmovements"] as const;
export const TARGET_INDEX_NAME = "tenantId_1_operationId_1";

export type AuditClassification =
    | "PRESENT_AND_MATCHING"
    | "MISSING"
    | "PRESENT_BUT_MISMATCHED";

export interface ExpectedIndexDefinition {
    collectionName: (typeof TARGET_COLLECTIONS)[number];
    indexName: string;
    keys: { tenantId: 1; operationId: 1 };
    unique: true;
    partialFilterExpression: Record<string, unknown>;
}

export const EXPECTED_INDEX_DEFINITIONS: Record<
    (typeof TARGET_COLLECTIONS)[number],
    ExpectedIndexDefinition
> = {
    products: {
        collectionName: "products",
        indexName: TARGET_INDEX_NAME,
        keys: { tenantId: 1, operationId: 1 },
        unique: true,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    },
    stockmovements: {
        collectionName: "stockmovements",
        indexName: TARGET_INDEX_NAME,
        keys: { tenantId: 1, operationId: 1 },
        unique: true,
        partialFilterExpression: {
            operationId: { $exists: true },
        },
    },
};

export interface RawIndexCatalogEntry {
    name?: string;
    key?: Record<string, unknown>;
    unique?: boolean;
    sparse?: boolean;
    partialFilterExpression?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CollectionIndexAuditReport {
    collectionName: string;
    expectedIndexName: string;
    classification: AuditClassification;
    matchingIndexFound: boolean;
    actualIndex?: {
        name: string;
        key: Record<string, unknown>;
        unique?: boolean;
        sparse?: boolean;
        partialFilterExpression?: Record<string, unknown>;
    };
    mismatchReasons: string[];
    allCollectionIndexes: { name: string; key: Record<string, unknown> }[];
}

export interface ProductionIndexAuditSummary {
    database: string;
    timestamp: string;
    collections: Record<(typeof TARGET_COLLECTIONS)[number], CollectionIndexAuditReport>;
    overallStatus: "ALL_MATCHING" | "INDEXES_MISSING_OR_MISMATCHED";
}

/**
 * Validates pre-flight production audit guards.
 * Pure function: fails closed without leaking connection strings or credentials.
 */
export function validateAuditGuards(env: Record<string, string | undefined>): {
    ok: true;
} | {
    ok: false;
    reason: string;
} {
    if (env.CONFIRM_PRODUCTION_INDEX_AUDIT !== AUDIT_DATABASE_NAME) {
        return {
            ok: false,
            reason: `Refusing to run: CONFIRM_PRODUCTION_INDEX_AUDIT must be explicitly set to '${AUDIT_DATABASE_NAME}'.`,
        };
    }

    const parsed = parseMongoDbUriDatabaseName(env.MONGODB_URI);
    if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
    }

    if (parsed.dbName !== AUDIT_DATABASE_NAME) {
        return {
            ok: false,
            reason: `Refusing to run: Target database in MONGODB_URI does not match required '${AUDIT_DATABASE_NAME}'.`,
        };
    }

    return { ok: true };
}

/**
 * Checks whether an index key pattern exactly matches { tenantId: 1, operationId: 1 }.
 * Validates both key names, values, and order.
 */
export function isExactTenantOperationIdKey(key: Record<string, unknown> | undefined): boolean {
    if (!key || typeof key !== "object") return false;
    const entries = Object.entries(key);
    if (entries.length !== 2) return false;
    return (
        entries[0][0] === "tenantId" &&
        entries[0][1] === 1 &&
        entries[1][0] === "operationId" &&
        entries[1][1] === 1
    );
}

/**
 * Compares partial filter expression for the Product model:
 * Expected: { operationId: { $type: "string", $gt: "" } }
 */
export function isProductPartialFilterMatching(
    filter: Record<string, unknown> | undefined
): boolean {
    if (!filter || typeof filter !== "object") return false;
    const keys = Object.keys(filter);
    if (keys.length !== 1 || keys[0] !== "operationId") return false;

    const opFilter = filter.operationId;
    if (!opFilter || typeof opFilter !== "object") return false;

    const condEntries = Object.entries(opFilter as Record<string, unknown>);
    if (condEntries.length !== 2) return false;

    const asRecord = opFilter as Record<string, unknown>;
    return asRecord.$type === "string" && asRecord.$gt === "";
}

/**
 * Compares partial filter expression for the StockMovement model:
 * Expected: { operationId: { $exists: true } }
 */
export function isStockMovementPartialFilterMatching(
    filter: Record<string, unknown> | undefined
): boolean {
    if (!filter || typeof filter !== "object") return false;
    const keys = Object.keys(filter);
    if (keys.length !== 1 || keys[0] !== "operationId") return false;

    const opFilter = filter.operationId;
    if (!opFilter || typeof opFilter !== "object") return false;

    const condEntries = Object.entries(opFilter as Record<string, unknown>);
    if (condEntries.length !== 1) return false;

    const asRecord = opFilter as Record<string, unknown>;
    return asRecord.$exists === true;
}

/**
 * Pure evaluation function: Classifies the operation-ID index for a given collection
 * against its expected Mongoose schema specification.
 *
 * Can be unit tested completely without a database connection.
 */
export function classifyCollectionOperationIdIndex(
    collectionName: (typeof TARGET_COLLECTIONS)[number],
    rawIndexes: RawIndexCatalogEntry[]
): CollectionIndexAuditReport {
    const expectation = EXPECTED_INDEX_DEFINITIONS[collectionName];
    const allCollectionIndexes = rawIndexes.map((idx) => ({
        name: idx.name || "unnamed",
        key: idx.key || {},
    }));

    // Find any index mentioning operationId or named tenantId_1_operationId_1
    const candidateIndexes = rawIndexes.filter(
        (idx) =>
            idx.name === TARGET_INDEX_NAME ||
            (idx.key && "operationId" in idx.key)
    );

    if (candidateIndexes.length === 0) {
        return {
            collectionName,
            expectedIndexName: TARGET_INDEX_NAME,
            classification: "MISSING",
            matchingIndexFound: false,
            mismatchReasons: [
                `No index with name '${TARGET_INDEX_NAME}' or key field 'operationId' exists on collection '${collectionName}'.`,
            ],
            allCollectionIndexes,
        };
    }

    // Identify target index: prefer exact name or exact key
    const primaryCandidate =
        candidateIndexes.find((idx) => idx.name === TARGET_INDEX_NAME) ||
        candidateIndexes.find((idx) => isExactTenantOperationIdKey(idx.key)) ||
        candidateIndexes[0];

    const mismatchReasons: string[] = [];

    // 1. Key Pattern and Order
    const keyMatches = isExactTenantOperationIdKey(primaryCandidate.key);
    if (!keyMatches) {
        mismatchReasons.push(
            `Key pattern mismatch: expected { tenantId: 1, operationId: 1 }, got ${JSON.stringify(
                primaryCandidate.key || {}
            )}`
        );
    }

    // 2. Uniqueness
    if (primaryCandidate.unique !== true) {
        mismatchReasons.push(
            `Uniqueness mismatch: expected unique: true, got unique: ${primaryCandidate.unique ?? false}`
        );
    }

    // 3. Sparse option (should be omitted or false when partialFilterExpression is used)
    if (primaryCandidate.sparse === true) {
        mismatchReasons.push(
            "Sparse mismatch: index has legacy 'sparse: true' instead of clean non-sparse partialFilterExpression"
        );
    }

    // 4. Exact Partial Filter Expression
    const filter = primaryCandidate.partialFilterExpression;
    const filterMatches =
        collectionName === "products"
            ? isProductPartialFilterMatching(filter)
            : isStockMovementPartialFilterMatching(filter);

    if (!filterMatches) {
        const expectedFilterJson = JSON.stringify(expectation.partialFilterExpression);
        const actualFilterJson = JSON.stringify(filter || null);
        mismatchReasons.push(
            `Partial filter mismatch: expected ${expectedFilterJson}, got ${actualFilterJson}`
        );
    }

    // 5. Competing ambiguous indexes
    if (candidateIndexes.length > 1) {
        const otherNames = candidateIndexes
            .filter((idx) => idx !== primaryCandidate)
            .map((idx) => idx.name || "unnamed")
            .join(", ");
        mismatchReasons.push(
            `Ambiguous catalog: found ${candidateIndexes.length} indexes involving 'operationId' (${otherNames})`
        );
    }

    const classification: AuditClassification =
        mismatchReasons.length === 0 ? "PRESENT_AND_MATCHING" : "PRESENT_BUT_MISMATCHED";

    return {
        collectionName,
        expectedIndexName: TARGET_INDEX_NAME,
        classification,
        matchingIndexFound: classification === "PRESENT_AND_MATCHING",
        actualIndex: {
            name: primaryCandidate.name || "unnamed",
            key: primaryCandidate.key || {},
            unique: primaryCandidate.unique,
            sparse: primaryCandidate.sparse,
            partialFilterExpression: primaryCandidate.partialFilterExpression,
        },
        mismatchReasons,
        allCollectionIndexes,
    };
}

/**
 * Configures Node.js c-ares DNS resolver to use reliable public nameservers (Google & Cloudflare).
 * Resolves the issue where local stub resolvers (e.g. 127.0.0.1) refuse port 53 SRV lookups.
 */
export function configureAuditDns(servers: string[] = ["8.8.8.8", "1.1.1.1"]): string[] {
    const dns = require("node:dns");
    dns.setServers(servers);
    return dns.getServers();
}

/**
 * Restores Node.js c-ares DNS resolver configuration.
 */
export function restoreAuditDns(servers: string[]): void {
    const dns = require("node:dns");
    dns.setServers(servers);
}

/**
 * Execute the read-only index audit against MongoDB Atlas.
 * Strictly checks index catalog metadata only.
 */
export async function runProductionIndexAudit(): Promise<ProductionIndexAuditSummary> {
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

    const guard = validateAuditGuards(process.env);
    if (!guard.ok) {
        throw new Error(guard.reason);
    }

    const dns = require("node:dns");
    const originalServers: string[] = dns.getServers();
    let client: MongoClient | null = null;

    try {
        // Configure process-scoped public DNS resolvers for Atlas SRV discovery
        configureAuditDns(["8.8.8.8", "1.1.1.1"]);

        const uri = process.env.MONGODB_URI!;
        client = new MongoClient(uri, {
            connectTimeoutMS: 10000,
            serverSelectionTimeoutMS: 10000,
        });

        await client.connect();
        const db = client.db();

        // Safety assertion: Connected database must strictly match AUDIT_DATABASE_NAME
        if (db.databaseName !== AUDIT_DATABASE_NAME) {
            throw new Error(
                `Safety violation: Connected databaseName '${db.databaseName}' does not match required '${AUDIT_DATABASE_NAME}'. Aborting immediately.`
            );
        }

        const reports: Record<
            (typeof TARGET_COLLECTIONS)[number],
            CollectionIndexAuditReport
        > = {} as any;

        for (const colName of TARGET_COLLECTIONS) {
            const col = db.collection(colName);
            // Strictly inspect index metadata only via listIndexes
            const rawIndexes = (await col.listIndexes().toArray()) as RawIndexCatalogEntry[];
            reports[colName] = classifyCollectionOperationIdIndex(colName, rawIndexes);
        }

        const allMatching = Object.values(reports).every(
            (r) => r.classification === "PRESENT_AND_MATCHING"
        );

        const summary: ProductionIndexAuditSummary = {
            database: AUDIT_DATABASE_NAME,
            timestamp: new Date().toISOString(),
            collections: reports,
            overallStatus: allMatching ? "ALL_MATCHING" : "INDEXES_MISSING_OR_MISMATCHED",
        };

        // Output markdown-formatted audit summary without printing URIs or credentials
        console.log("\n============================================================");
        console.log(`PRODUCTION INDEX AUDIT REPORT (${summary.database})`);
        console.log(`Timestamp: ${summary.timestamp}`);
        console.log(`Overall Status: ${summary.overallStatus}`);
        console.log("============================================================\n");

        for (const colName of TARGET_COLLECTIONS) {
            const r = reports[colName];
            console.log(`--- Collection: ${colName} ---`);
            console.log(`Target Index:       ${r.expectedIndexName}`);
            console.log(`Classification:     ${r.classification}`);
            console.log(`Actual Index Name:  ${r.actualIndex?.name || "NONE"}`);
            console.log(`Actual Key Pattern: ${JSON.stringify(r.actualIndex?.key || {})}`);
            console.log(`Actual Unique:      ${r.actualIndex?.unique ?? false}`);
            console.log(`Actual Sparse:      ${r.actualIndex?.sparse ?? false}`);
            console.log(
                `Actual Filter:      ${JSON.stringify(
                    r.actualIndex?.partialFilterExpression || null
                )}`
            );
            if (r.mismatchReasons.length > 0) {
                console.log("Findings / Reasons:");
                r.mismatchReasons.forEach((reason) => console.log(`  - ${reason}`));
            }
            console.log(`Total Indexes on Collection: ${r.allCollectionIndexes.length}`);
            console.log("");
        }

        return summary;
    } finally {
        try {
            if (client) {
                await client.close();
            }
        } finally {
            restoreAuditDns(originalServers);
        }
    }
}

// Guard invocation: Never run automatically when imported
if (
    process.argv[1] &&
    process.argv[1].replace(/\\/g, "/").endsWith("scripts/audit-production-operation-indexes.ts")
) {
    runProductionIndexAudit()
        .then(() => {
            process.exit(0);
        })
        .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error("Audit aborted safely:", message);
            process.exit(1);
        });
}
