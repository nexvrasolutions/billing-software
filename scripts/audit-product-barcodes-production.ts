/*
 * Read-Only Production Barcode Audit Script (billing_inventory ONLY).
 *
 * Scans `billing_inventory.products` to detect:
 * 1. Total product count and barcode population.
 * 2. Active barcode index definition and classification.
 * 3. Exact duplicate non-empty barcodes per tenant (same binary string).
 * 4. Case-only duplicate non-empty barcodes per tenant (e.g. "ABC123" vs "abc123").
 *
 * Safety Invariants:
 * - Strictly READ-ONLY. Executes zero writes, updates, deletes, or index mutations.
 * - Requires explicit confirmation: CONFIRM_PRODUCTION_AUDIT="billing_inventory".
 * - Validates target database name before connecting and asserts connected dbName === "billing_inventory".
 * - Never outputs connection URIs, credentials, passwords, or secrets.
 *
 * DO NOT EXECUTE without explicit user authorization.
 * Reference Invocation:
 *   CONFIRM_PRODUCTION_AUDIT=billing_inventory npx tsx scripts/audit-product-barcodes-production.ts
 */

import { parseMongoDbUriDatabaseName } from "./migrate-product-indexes-production";

export const AUDIT_DATABASE_NAME = "billing_inventory";
export const AUDIT_MAX_RECORDED_GROUPS = 200;

export interface AuditReport {
    totalProducts: number;
    productsWithBarcode: number;
    productsWithoutBarcode: number;
    distinctTenantsCount: number;
    exactDuplicateCount: number;
    exactDuplicateTruncated: boolean;
    exactDuplicateGroups: { tenantId: string; barcode: string; count: number }[];
    caseOnlyDuplicateCount: number;
    caseOnlyDuplicateTruncated: boolean;
    caseOnlyDuplicateGroups: { tenantId: string; canonicalBarcode: string; variations: string[]; count: number }[];
    barcodeIndexStatus: {
        found: boolean;
        name?: string;
        unique?: boolean;
        sparse?: boolean;
        partialFilter?: Record<string, unknown>;
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
 * Validates pre-flight production audit guards.
 * Pure function: fails closed without leaking connection strings or credentials.
 */
export function validateAuditGuards(env: {
    CONFIRM_PRODUCTION_AUDIT?: string;
    MONGODB_URI?: string;
}): { ok: true } | { ok: false; reason: string } {
    if (env.CONFIRM_PRODUCTION_AUDIT !== AUDIT_DATABASE_NAME) {
        return {
            ok: false,
            reason: `Refusing to run: CONFIRM_PRODUCTION_AUDIT must be explicitly set to '${AUDIT_DATABASE_NAME}'.`,
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
 * Pure helper to compute audit metrics from in-memory records.
 * Unit testable without a live database.
 * Supports bounded memory collection via maxGroups parameter.
 */
export function computeBarcodeAuditMetrics(
    records: { _id?: unknown; tenantId: unknown; barcode?: unknown }[],
    maxGroups: number = AUDIT_MAX_RECORDED_GROUPS
): Omit<AuditReport, "barcodeIndexStatus"> {
    let productsWithBarcode = 0;
    let productsWithoutBarcode = 0;
    const tenantsSet = new Set<string>();

    const exactCounts = new Map<string, { tenantId: string; barcode: string; count: number }>();
    const caseMap = new Map<string, { tenantId: string; canonicalBarcode: string; variations: Set<string>; count: number }>();

    for (const r of records) {
        const tenantId = String(r.tenantId || "").trim();
        if (tenantId) tenantsSet.add(tenantId);

        const val = r.barcode;
        if (typeof val === "string" && val.trim().length > 0) {
            productsWithBarcode++;
            const cleanVal = val.trim();
            const upperVal = cleanVal.toUpperCase();

            // Exact count
            const exactKey = `${tenantId}:::${cleanVal}`;
            const existingExact = exactCounts.get(exactKey) || { tenantId, barcode: cleanVal, count: 0 };
            existingExact.count++;
            exactCounts.set(exactKey, existingExact);

            // Case-insensitive grouping
            const caseKey = `${tenantId}:::${upperVal}`;
            const existingCase = caseMap.get(caseKey) || {
                tenantId,
                canonicalBarcode: upperVal,
                variations: new Set<string>(),
                count: 0,
            };
            existingCase.variations.add(cleanVal);
            existingCase.count++;
            caseMap.set(caseKey, existingCase);
        } else {
            productsWithoutBarcode++;
        }
    }

    const allExactDuplicateGroups = Array.from(exactCounts.values()).filter((g) => g.count > 1);
    const exactDuplicateCount = allExactDuplicateGroups.length;
    const exactDuplicateTruncated = exactDuplicateCount > maxGroups;
    const exactDuplicateGroups = exactDuplicateTruncated
        ? allExactDuplicateGroups.slice(0, maxGroups)
        : allExactDuplicateGroups;

    const allCaseOnlyDuplicateGroups = Array.from(caseMap.values())
        .filter((g) => g.variations.size > 1)
        .map((g) => ({
            tenantId: g.tenantId,
            canonicalBarcode: g.canonicalBarcode,
            variations: Array.from(g.variations),
            count: g.count,
        }));
    const caseOnlyDuplicateCount = allCaseOnlyDuplicateGroups.length;
    const caseOnlyDuplicateTruncated = caseOnlyDuplicateCount > maxGroups;
    const caseOnlyDuplicateGroups = caseOnlyDuplicateTruncated
        ? allCaseOnlyDuplicateGroups.slice(0, maxGroups)
        : allCaseOnlyDuplicateGroups;

    return {
        totalProducts: records.length,
        productsWithBarcode,
        productsWithoutBarcode,
        distinctTenantsCount: tenantsSet.size,
        exactDuplicateCount,
        exactDuplicateTruncated,
        exactDuplicateGroups,
        caseOnlyDuplicateCount,
        caseOnlyDuplicateTruncated,
        caseOnlyDuplicateGroups,
    };
}

/**
 * Reliable Mongoose disconnect helper.
 * Swallows disconnect errors so original audit outcomes or exceptions are preserved.
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
 * Main read-only audit runner.
 * Connects to billing_inventory and aggregates barcode status without modifying any data.
 * Always closes database connections in a finally block.
 */
export async function runProductionBarcodeAudit(): Promise<AuditReport | null> {
    console.log(`=== READ-ONLY PRODUCTION BARCODE AUDIT (${AUDIT_DATABASE_NAME}) ===\n`);

    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

    const guardCheck = validateAuditGuards({
        CONFIRM_PRODUCTION_AUDIT: process.env.CONFIRM_PRODUCTION_AUDIT,
        MONGODB_URI: process.env.MONGODB_URI,
    });

    if (!guardCheck.ok) {
        console.error(`ABORTED: ${guardCheck.reason}`);
        return null;
    }
    console.log(`PASS: Guards verified (target database: ${AUDIT_DATABASE_NAME}).\n`);

    const { connectDB } = await import("../lib/db/mongodb");
    const mongoose = (await import("mongoose")).default;

    let connected = false;

    try {
        await connectDB();
        connected = true;
        const db = mongoose.connection.db;
        if (!db) {
            console.error("ABORTED: Database connection handle is not available.");
            return null;
        }

        if (db.databaseName !== AUDIT_DATABASE_NAME) {
            console.error(`ABORTED: Active connection '${db.databaseName}' does not match required '${AUDIT_DATABASE_NAME}'.`);
            return null;
        }
        console.log(`PASS: Connected to active database '${db.databaseName}'. Scanning collection...\n`);

        const collection = db.collection("products");

        // 1. Overall counts (ignoring blank and whitespace-only barcodes)
        const totalProducts = await collection.countDocuments();
        const productsWithBarcode = await collection.countDocuments(NON_EMPTY_TRIMMED_BARCODE_MATCH);
        const productsWithoutBarcode = totalProducts - productsWithBarcode;
        const distinctTenants = await collection.distinct("tenantId");

        // 2. Exact duplicate check with bounded memory and server-side total counting
        const exactFacetRaw = await collection
            .aggregate([
                { $match: NON_EMPTY_TRIMMED_BARCODE_MATCH },
                {
                    $group: {
                        _id: { tenantId: "$tenantId", barcode: { $trim: { input: "$barcode" } } },
                        count: { $sum: 1 },
                    },
                },
                { $match: { count: { $gt: 1 } } },
                {
                    $facet: {
                        totalCount: [{ $count: "total" }],
                        sampledGroups: [{ $limit: AUDIT_MAX_RECORDED_GROUPS }],
                    },
                },
            ])
            .toArray();

        const exactFacetResult = exactFacetRaw[0] || { totalCount: [], sampledGroups: [] };
        const exactDuplicateCount = Number(exactFacetResult.totalCount?.[0]?.total || 0);
        const exactDuplicateGroups = (exactFacetResult.sampledGroups || []).map((d: any) => ({
            tenantId: String(d._id.tenantId),
            barcode: String(d._id.barcode),
            count: Number(d.count),
        }));
        const exactDuplicateTruncated = exactDuplicateCount > exactDuplicateGroups.length;

        // 3. Case-only duplicate check with bounded memory and server-side total counting
        const caseFacetRaw = await collection
            .aggregate([
                { $match: NON_EMPTY_TRIMMED_BARCODE_MATCH },
                {
                    $group: {
                        _id: {
                            tenantId: "$tenantId",
                            canonicalBarcode: { $toUpper: { $trim: { input: "$barcode" } } },
                        },
                        distinctVariations: { $addToSet: { $trim: { input: "$barcode" } } },
                        count: { $sum: 1 },
                    },
                },
                {
                    $match: {
                        $expr: { $gt: [{ $size: "$distinctVariations" }, 1] },
                    },
                },
                {
                    $facet: {
                        totalCount: [{ $count: "total" }],
                        sampledGroups: [{ $limit: AUDIT_MAX_RECORDED_GROUPS }],
                    },
                },
            ])
            .toArray();

        const caseFacetResult = caseFacetRaw[0] || { totalCount: [], sampledGroups: [] };
        const caseOnlyDuplicateCount = Number(caseFacetResult.totalCount?.[0]?.total || 0);
        const caseOnlyDuplicateGroups = (caseFacetResult.sampledGroups || []).map((d: any) => ({
            tenantId: String(d._id.tenantId),
            canonicalBarcode: String(d._id.canonicalBarcode),
            variations: (d.distinctVariations || []) as string[],
            count: Number(d.count),
        }));
        const caseOnlyDuplicateTruncated = caseOnlyDuplicateCount > caseOnlyDuplicateGroups.length;

        // 4. Index status
        const indexes = await collection.indexes();
        const barcodeIndex = indexes.find(
            (idx) => idx.name === "tenantId_1_barcode_1" || (idx.key && idx.key["barcode"] === 1)
        );

        const report: AuditReport = {
            totalProducts,
            productsWithBarcode,
            productsWithoutBarcode,
            distinctTenantsCount: distinctTenants.length,
            exactDuplicateCount,
            exactDuplicateTruncated,
            exactDuplicateGroups,
            caseOnlyDuplicateCount,
            caseOnlyDuplicateTruncated,
            caseOnlyDuplicateGroups,
            barcodeIndexStatus: {
                found: Boolean(barcodeIndex),
                name: barcodeIndex?.name,
                unique: Boolean(barcodeIndex?.unique),
                sparse: Boolean(barcodeIndex?.sparse),
                partialFilter: barcodeIndex?.partialFilterExpression,
            },
        };

        console.log("=== AUDIT REPORT SUMMARY ===");
        console.log(`Total Products in Database:          ${report.totalProducts}`);
        console.log(`Products with non-empty Barcode:    ${report.productsWithBarcode}`);
        console.log(`Products without Barcode (blank):    ${report.productsWithoutBarcode}`);
        console.log(`Distinct Tenants:                   ${report.distinctTenantsCount}`);
        console.log(`Exact Duplicate Barcode Groups:     ${report.exactDuplicateCount}${report.exactDuplicateTruncated ? ` (reported sample capped at ${report.exactDuplicateGroups.length}; additional conflicts exist)` : ""}`);
        console.log(`Case-Only Duplicate Groups:         ${report.caseOnlyDuplicateCount}${report.caseOnlyDuplicateTruncated ? ` (reported sample capped at ${report.caseOnlyDuplicateGroups.length}; additional conflicts exist)` : ""}`);
        console.log(`Active Barcode Index Name:          ${report.barcodeIndexStatus.name || "NONE"}`);
        console.log(`Active Index Unique:                ${report.barcodeIndexStatus.unique}`);
        console.log(`Active Index Sparse (legacy flag):  ${report.barcodeIndexStatus.sparse}`);
        console.log(`Active Index Partial Filter:        ${JSON.stringify(report.barcodeIndexStatus.partialFilter || null)}`);
        console.log("============================\n");

        if (report.exactDuplicateTruncated) {
            console.warn(`NOTICE: Exact duplicate groups list is truncated to ${report.exactDuplicateGroups.length} of ${report.exactDuplicateCount} total conflicts. Additional conflicts exist in database.`);
        }

        if (report.caseOnlyDuplicateTruncated) {
            console.warn(`NOTICE: Case-only duplicate groups list is truncated to ${report.caseOnlyDuplicateGroups.length} of ${report.caseOnlyDuplicateCount} total conflicts. Additional conflicts exist in database.`);
        }

        if (report.exactDuplicateCount > 0) {
            console.warn(`WARNING: Found ${report.exactDuplicateCount} exact duplicate barcode conflict(s). Index replacement will fail until resolved.`);
        }

        if (report.caseOnlyDuplicateCount > 0) {
            console.warn(`WARNING: Found ${report.caseOnlyDuplicateCount} case-only duplicate conflict(s). Uppercase backfill would cause collision for these items.`);
        }

        return report;
    } finally {
        if (connected) {
            await safeCloseMongooseConnection(mongoose);
        }
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/audit-product-barcodes-production.ts")) {
    runProductionBarcodeAudit()
        .then((report) => {
            process.exit(report ? 0 : 1);
        })
        .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error("Unexpected audit error:", message);
            process.exit(1);
        });
}
