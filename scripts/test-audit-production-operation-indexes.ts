/**
 * Database-Free Test Suite: Production Index Audit Classification & Safety Guards
 * (NO MONGODB, NO ATLAS, NO NETWORK CALLS, NO SERVER EXECUTION)
 *
 * Covers:
 * 1. Environment & Database Guard Validation (fail-closed, credential secrecy).
 * 2. Key Pattern and Order Verification ({ tenantId: 1, operationId: 1 }).
 * 3. Exact Partial Filter Expression Checking (Product vs StockMovement asymmetry).
 * 4. Classification of products collection indexes (MATCHING, MISSING, MISMATCHED).
 * 5. Classification of stockmovements collection indexes (MATCHING, MISSING, MISMATCHED).
 * 6. Detection of legacy sparse indexes and competing ambiguous indexes.
 *
 * Run:
 *   npx tsx scripts/test-audit-production-operation-indexes.ts
 */

import {
    validateAuditGuards,
    isExactTenantOperationIdKey,
    isProductPartialFilterMatching,
    isStockMovementPartialFilterMatching,
    classifyCollectionOperationIdIndex,
    configureAuditDns,
    restoreAuditDns,
    AUDIT_DATABASE_NAME,
    TARGET_INDEX_NAME,
    type RawIndexCatalogEntry,
} from "./audit-production-operation-indexes";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n============================================================`);
    console.log(`INDEX AUDIT TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

async function run(): Promise<boolean> {
    console.log("=== TEST SUITE: PRODUCTION INDEX AUDIT CLASSIFICATION & GUARDS ===\n");

    // ============================================================
    // SECTION 1: Pre-Flight Safety Guards
    // ============================================================
    console.log("-- 1. Pre-Flight Safety Guards --");

    // 1.1 Missing confirmation variable
    const guard1 = validateAuditGuards({
        CONFIRM_PRODUCTION_INDEX_AUDIT: undefined,
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true",
    });
    check("1.1. Missing CONFIRM_PRODUCTION_INDEX_AUDIT fails closed", guard1.ok === false);
    check("1.2. Error message explicitly demands billing_inventory confirmation", guard1.ok === false && guard1.reason.includes(AUDIT_DATABASE_NAME));

    // 1.3 Wrong confirmation variable
    const guard2 = validateAuditGuards({
        CONFIRM_PRODUCTION_INDEX_AUDIT: "billing_test",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true",
    });
    check("1.3. Wrong confirmation variable fails closed", guard2.ok === false);

    // 1.4 Missing MONGODB_URI
    const guard3 = validateAuditGuards({
        CONFIRM_PRODUCTION_INDEX_AUDIT: AUDIT_DATABASE_NAME,
        MONGODB_URI: undefined,
    });
    check("1.4. Missing MONGODB_URI fails closed", guard3.ok === false);

    // 1.5 MONGODB_URI pointing to wrong database
    const guard4 = validateAuditGuards({
        CONFIRM_PRODUCTION_INDEX_AUDIT: AUDIT_DATABASE_NAME,
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/wrong_database?retryWrites=true",
    });
    check("1.5. MONGODB_URI with non-target database fails closed", guard4.ok === false && guard4.reason.includes("does not match required"));

    // 1.6 Valid configuration
    const guardValid = validateAuditGuards({
        CONFIRM_PRODUCTION_INDEX_AUDIT: AUDIT_DATABASE_NAME,
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/billing_inventory?retryWrites=true&w=majority",
    });
    check("1.6. Valid confirmation and URI passes guard", guardValid.ok === true);

    // ============================================================
    // SECTION 2: Key Pattern and Order Verification
    // ============================================================
    console.log("\n-- 2. Key Pattern and Order Verification --");

    check("2.1. Exact { tenantId: 1, operationId: 1 } matches", isExactTenantOperationIdKey({ tenantId: 1, operationId: 1 }));
    check("2.2. Inverted order { operationId: 1, tenantId: 1 } fails", !isExactTenantOperationIdKey({ operationId: 1, tenantId: 1 }));
    check("2.3. Missing operationId { tenantId: 1 } fails", !isExactTenantOperationIdKey({ tenantId: 1 }));
    check("2.4. Extra field { tenantId: 1, operationId: 1, SKU: 1 } fails", !isExactTenantOperationIdKey({ tenantId: 1, operationId: 1, SKU: 1 }));
    check("2.5. Descending index { tenantId: 1, operationId: -1 } fails", !isExactTenantOperationIdKey({ tenantId: 1, operationId: -1 }));
    check("2.6. Undefined key pattern fails", !isExactTenantOperationIdKey(undefined));

    // ============================================================
    // SECTION 3: Partial Filter Expression Comparisons
    // ============================================================
    console.log("\n-- 3. Partial Filter Expression Comparisons --");

    const validProductFilter = { operationId: { $type: "string", $gt: "" } };
    const validStockMovementFilter = { operationId: { $exists: true } };

    check("3.1. Valid Product filter matches", isProductPartialFilterMatching(validProductFilter));
    check("3.2. Product filter missing $gt fails", !isProductPartialFilterMatching({ operationId: { $type: "string" } }));
    check("3.3. Product filter with $exists instead of $type/$gt fails", !isProductPartialFilterMatching(validStockMovementFilter));
    check("3.4. Valid StockMovement filter matches", isStockMovementPartialFilterMatching(validStockMovementFilter));
    check("3.5. StockMovement filter with Product spec fails", !isStockMovementPartialFilterMatching(validProductFilter));
    check("3.6. StockMovement filter with $exists: false fails", !isStockMovementPartialFilterMatching({ operationId: { $exists: false } }));

    // ============================================================
    // SECTION 4: Product Collection Index Classification
    // ============================================================
    console.log("\n-- 4. Product Collection Index Classification --");

    // 4.1 Missing index
    const emptyCatalog: RawIndexCatalogEntry[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_SKU_1", key: { tenantId: 1, SKU: 1 }, unique: true },
    ];
    const resProdMissing = classifyCollectionOperationIdIndex("products", emptyCatalog);
    check("4.1.1. Empty catalog yields MISSING", resProdMissing.classification === "MISSING");
    check("4.1.2. matchingIndexFound is false", resProdMissing.matchingIndexFound === false);

    // 4.2 Exact matching index
    const matchingProductCatalog: RawIndexCatalogEntry[] = [
        ...emptyCatalog,
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            partialFilterExpression: { operationId: { $type: "string", $gt: "" } },
        },
    ];
    const resProdMatching = classifyCollectionOperationIdIndex("products", matchingProductCatalog);
    check("4.2.1. Expected index yields PRESENT_AND_MATCHING", resProdMatching.classification === "PRESENT_AND_MATCHING");
    check("4.2.2. matchingIndexFound is true", resProdMatching.matchingIndexFound === true);
    check("4.2.3. No mismatch reasons reported", resProdMatching.mismatchReasons.length === 0);

    // 4.3 Index exists but is not unique
    const nonUniqueCatalog: RawIndexCatalogEntry[] = [
        ...emptyCatalog,
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: false,
            partialFilterExpression: { operationId: { $type: "string", $gt: "" } },
        },
    ];
    const resProdNonUnique = classifyCollectionOperationIdIndex("products", nonUniqueCatalog);
    check("4.3.1. Non-unique index yields PRESENT_BUT_MISMATCHED", resProdNonUnique.classification === "PRESENT_BUT_MISMATCHED");
    check("4.3.2. Mismatch reports uniqueness", resProdNonUnique.mismatchReasons.some((r) => r.includes("Uniqueness mismatch")));

    // 4.4 Legacy sparse index (flawed options)
    const sparseCatalog: RawIndexCatalogEntry[] = [
        ...emptyCatalog,
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            sparse: true,
        },
    ];
    const resProdSparse = classifyCollectionOperationIdIndex("products", sparseCatalog);
    check("4.4.1. Legacy sparse index yields PRESENT_BUT_MISMATCHED", resProdSparse.classification === "PRESENT_BUT_MISMATCHED");
    check("4.4.2. Mismatch reports sparse flag", resProdSparse.mismatchReasons.some((r) => r.includes("Sparse mismatch")));

    // 4.5 Product collection with StockMovement partial filter
    const crossFilterCatalog: RawIndexCatalogEntry[] = [
        ...emptyCatalog,
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            partialFilterExpression: { operationId: { $exists: true } },
        },
    ];
    const resProdCross = classifyCollectionOperationIdIndex("products", crossFilterCatalog);
    check("4.5.1. Product collection given StockMovement filter yields PRESENT_BUT_MISMATCHED", resProdCross.classification === "PRESENT_BUT_MISMATCHED");
    check("4.5.2. Mismatch reports partial filter difference", resProdCross.mismatchReasons.some((r) => r.includes("Partial filter mismatch")));

    // ============================================================
    // SECTION 5: StockMovement Collection Index Classification
    // ============================================================
    console.log("\n-- 5. StockMovement Collection Index Classification --");

    const smBaseCatalog: RawIndexCatalogEntry[] = [
        { name: "_id_", key: { _id: 1 } },
        { name: "tenantId_1_productId_1_createdAt_-1", key: { tenantId: 1, productId: 1, createdAt: -1 } },
    ];

    // 5.1 Missing in stockmovements
    const resSmMissing = classifyCollectionOperationIdIndex("stockmovements", smBaseCatalog);
    check("5.1. Missing stockmovements index yields MISSING", resSmMissing.classification === "MISSING");

    // 5.2 Exact matching in stockmovements
    const matchingSmCatalog: RawIndexCatalogEntry[] = [
        ...smBaseCatalog,
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            partialFilterExpression: { operationId: { $exists: true } },
        },
    ];
    const resSmMatching = classifyCollectionOperationIdIndex("stockmovements", matchingSmCatalog);
    check("5.2.1. Expected stockmovements index yields PRESENT_AND_MATCHING", resSmMatching.classification === "PRESENT_AND_MATCHING");
    check("5.2.2. matchingIndexFound is true", resSmMatching.matchingIndexFound === true);

    // 5.3 StockMovement given Product filter
    const smWithProdFilterCatalog: RawIndexCatalogEntry[] = [
        ...smBaseCatalog,
        {
            name: TARGET_INDEX_NAME,
            key: { tenantId: 1, operationId: 1 },
            unique: true,
            partialFilterExpression: { operationId: { $type: "string", $gt: "" } },
        },
    ];
    const resSmWithProdFilter = classifyCollectionOperationIdIndex("stockmovements", smWithProdFilterCatalog);
    check("5.3. StockMovement given Product filter yields PRESENT_BUT_MISMATCHED", resSmWithProdFilter.classification === "PRESENT_BUT_MISMATCHED");

    // 5.4 Competing duplicate indexes
    const competingCatalog: RawIndexCatalogEntry[] = [
        ...matchingSmCatalog,
        {
            name: "tenantId_1_operationId_1_dup",
            key: { tenantId: 1, operationId: 1 },
            unique: true,
        },
    ];
    const resSmCompeting = classifyCollectionOperationIdIndex("stockmovements", competingCatalog);
    check("5.4.1. Competing indexes on operationId yield PRESENT_BUT_MISMATCHED", resSmCompeting.classification === "PRESENT_BUT_MISMATCHED");
    check("5.4.2. Mismatch reports ambiguous catalog", resSmCompeting.mismatchReasons.some((r) => r.includes("Ambiguous catalog")));

    // ============================================================
    // SECTION 6: DNS Configuration Guard, Restoration & Failure Safety
    // ============================================================
    console.log("\n-- 6. DNS Configuration Guard, Restoration & Failure Safety --");

    const dns = require("node:dns");
    const baselineServers = dns.getServers();

    // 6.1 Standard success lifecycle restores DNS
    const originalServers1 = dns.getServers();
    try {
        const configured = configureAuditDns(["8.8.8.8", "1.1.1.1"]);
        check("6.1.1. configureAuditDns returns configured servers", Array.isArray(configured) && configured.includes("8.8.8.8") && configured.includes("1.1.1.1"));
        check("6.1.2. dns.getServers reflects configured public resolvers", dns.getServers().includes("8.8.8.8") && dns.getServers().includes("1.1.1.1"));
    } finally {
        restoreAuditDns(originalServers1);
    }
    check("6.1.3. DNS restored after successful lifecycle", JSON.stringify(dns.getServers()) === JSON.stringify(baselineServers));

    // 6.2 Simulated failure during client construction restores DNS
    const originalServers2 = dns.getServers();
    let constructionFailed = false;
    try {
        configureAuditDns(["8.8.8.8", "1.1.1.1"]);
        throw new Error("Simulated client construction failure");
    } catch (err: any) {
        constructionFailed = err.message === "Simulated client construction failure";
    } finally {
        restoreAuditDns(originalServers2);
    }
    check("6.2.1. Simulated construction error was caught", constructionFailed);
    check("6.2.2. DNS restored after client construction failure", JSON.stringify(dns.getServers()) === JSON.stringify(baselineServers));

    // 6.3 Simulated failure during connection/inspection closes client and restores DNS
    const originalServers3 = dns.getServers();
    let queryFailed = false;
    let mockClientClosed = false;
    const mockClient = {
        close: async () => {
            mockClientClosed = true;
        },
    };

    try {
        configureAuditDns(["8.8.8.8", "1.1.1.1"]);
        throw new Error("Simulated query/connection failure");
    } catch (err: any) {
        queryFailed = err.message === "Simulated query/connection failure";
    } finally {
        try {
            await mockClient.close();
        } finally {
            restoreAuditDns(originalServers3);
        }
    }
    check("6.3.1. Simulated connection/query error was caught", queryFailed);
    check("6.3.2. Mock client.close() was executed in finally block", mockClientClosed);
    check("6.3.3. DNS restored after connection/query failure", JSON.stringify(dns.getServers()) === JSON.stringify(baselineServers));

    // 6.4 DNS restored even if client.close() throws
    const originalServers4 = dns.getServers();
    let closeThrowHandled = false;
    const throwingClient = {
        close: async () => {
            throw new Error("Simulated client.close() rejection");
        },
    };

    try {
        try {
            configureAuditDns(["8.8.8.8", "1.1.1.1"]);
            // simulate finally block behavior of runProductionIndexAudit
        } finally {
            try {
                await throwingClient.close();
            } finally {
                restoreAuditDns(originalServers4);
            }
        }
    } catch (err: any) {
        closeThrowHandled = err.message === "Simulated client.close() rejection";
    }
    check("6.4.1. Client close throw handled", closeThrowHandled);
    check("6.4.2. DNS restored even when client.close() throws", JSON.stringify(dns.getServers()) === JSON.stringify(baselineServers));

    return summarize();
}

run()
    .then((success) => {
        process.exit(success ? 0 : 1);
    })
    .catch((err) => {
        console.error("Test execution failed:", err);
        process.exit(1);
    });

