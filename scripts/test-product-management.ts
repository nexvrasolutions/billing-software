/*
 * Product Management UI & Filtering Tests
 * (NO DATABASE, NO SERVER, NO NETWORK).
 *
 * Validates Stage 3 requirements:
 * 1. Stock display uses real API field `stockQuantity` and provides correct tone/formatting.
 * 2. Search matches name, SKU, and barcode (case-insensitive substring).
 * 3. Category filtering correctly isolates products by categoryId.
 * 4. Active/archived status filtering preserves archived products in management views.
 * 5. Stock-level filtering (all, in-stock, low-stock, out-of-stock).
 * 6. Combined multi-criteria filtering.
 * 7. Inactive products remain excluded from normal POS selection.
 *
 * Run:
 *   npx tsx scripts/test-product-management.ts
 */

import {
    filterProducts,
    formatStockBadge,
    type ProductItem,
} from "../lib/catalog/productFilter";
import { filterActivePosProducts } from "../lib/offline/productCatalogueCache";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    return failed.length === 0;
}

function main() {
    console.log("=== STAGE 3: PRODUCT MANAGEMENT UI & FILTERING TESTS ===\n");

    // ============================================================
    // 1. STOCK DISPLAY USING `stockQuantity`
    // ============================================================
    console.log("-- 1. Stock Display & Formatting --");

    const zeroStockBadge = formatStockBadge(0);
    check("S1. Zero stock has 'out' tone", zeroStockBadge.tone === "out");
    check("S2. Zero stock displays '0 in stock'", zeroStockBadge.label === "0 in stock");

    const negativeStockBadge = formatStockBadge(-3);
    check("S3. Negative stock is treated as out of stock", negativeStockBadge.tone === "out" && negativeStockBadge.label === "0 in stock");

    const lowStockBadge = formatStockBadge(5);
    check("S4. Stock <= 10 has 'low' tone", lowStockBadge.tone === "low");
    check("S5. Low stock displays exact quantity", lowStockBadge.label === "5 in stock");

    const edgeLowStockBadge = formatStockBadge(10);
    check("S6. Stock of 10 has 'low' tone", edgeLowStockBadge.tone === "low" && edgeLowStockBadge.label === "10 in stock");

    const normalStockBadge = formatStockBadge(45);
    check("S7. Stock > 10 has 'normal' tone", normalStockBadge.tone === "normal");
    check("S8. Normal stock displays exact quantity", normalStockBadge.label === "45 in stock");

    const fractionalStockBadge = formatStockBadge(2.5);
    check("S9. Fractional stock is formatted cleanly", fractionalStockBadge.label === "2.5 in stock" && fractionalStockBadge.tone === "low");

    // ============================================================
    // 2. TEST CATALOGUE DATASET
    // ============================================================
    const testProducts: ProductItem[] = [
        {
            id: "prod-1",
            name: "Colgate Total 120g",
            sku: "COLG-120",
            barcode: "8901030383821",
            categoryId: "cat-oral",
            pricePaise: 12000,
            stockQuantity: 25,
            active: true,
        },
        {
            id: "prod-2",
            name: "Colgate MaxFresh 100g",
            sku: "COLG-MAX",
            barcode: "8901030383822",
            categoryId: "cat-oral",
            pricePaise: 9500,
            stockQuantity: 4, // low stock
            active: true,
        },
        {
            id: "prod-3",
            name: "Colgate Herbal Discontinued",
            sku: "COLG-HRB",
            barcode: "8901030383829",
            categoryId: "cat-oral",
            pricePaise: 8000,
            stockQuantity: 0, // out of stock + archived
            active: false,
        },
        {
            id: "prod-4",
            name: "Dove Moisturizing Soap 75g",
            sku: "DOVE-75",
            barcode: "8901030384001",
            categoryId: "cat-soap",
            pricePaise: 4500,
            stockQuantity: 50,
            active: true,
        },
        {
            id: "prod-5",
            name: "Pears Pure & Gentle 125g",
            sku: "PEARS-125",
            barcode: undefined, // no barcode
            categoryId: "cat-soap",
            pricePaise: 7500,
            stockQuantity: 0, // out of stock, active
            active: true,
        },
    ];

    // ============================================================
    // 3. SEARCH MATCHING NAME, SKU, AND BARCODE
    // ============================================================
    console.log("\n-- 2. Multi-Field Search (Name, SKU, Barcode) --");

    // Match by name
    const byName = filterProducts(testProducts, { query: "Colgate" });
    check("Q1. Search by name matches all relevant products", byName.length === 3);

    // Match by SKU (case-insensitive)
    const bySku = filterProducts(testProducts, { query: "colg-max" });
    check("Q2. Search by SKU finds item case-insensitively", bySku.length === 1 && bySku[0]?.id === "prod-2");

    // Match by barcode
    const byBarcode = filterProducts(testProducts, { query: "8901030384001" });
    check("Q3. Search by barcode finds exact item", byBarcode.length === 1 && byBarcode[0]?.sku === "DOVE-75");

    // Substring barcode match
    const byBarcodeSub = filterProducts(testProducts, { query: "8382" });
    check("Q4. Search by partial barcode matches all containing items", byBarcodeSub.length === 3);

    // Empty query returns all items
    const emptyQ = filterProducts(testProducts, { query: "   " });
    check("Q5. Whitespace query returns all products", emptyQ.length === 5);

    // Non-existent query
    const noMatch = filterProducts(testProducts, { query: "NonExistentItem999" });
    check("Q6. Non-matching query returns empty array", noMatch.length === 0);

    // ============================================================
    // 4. CATEGORY FILTERING
    // ============================================================
    console.log("\n-- 3. Category Filtering --");

    const oralCat = filterProducts(testProducts, { categoryId: "cat-oral" });
    check("C1. Filter by categoryId 'cat-oral' returns oral products only", oralCat.length === 3);

    const soapCat = filterProducts(testProducts, { categoryId: "cat-soap" });
    check("C2. Filter by categoryId 'cat-soap' returns soap products only", soapCat.length === 2);

    const allCat = filterProducts(testProducts, { categoryId: "all" });
    check("C3. Filter category 'all' returns all products", allCat.length === 5);

    const unknownCat = filterProducts(testProducts, { categoryId: "cat-unknown" });
    check("C4. Filter by non-existent category returns empty array", unknownCat.length === 0);

    // ============================================================
    // 5. ACTIVE / ARCHIVED STATUS FILTERING
    // ============================================================
    console.log("\n-- 4. Status Filtering & Archived Preservation --");

    const allStatus = filterProducts(testProducts, { status: "all" });
    check("A1. Status 'all' preserves both active and archived products in management view", allStatus.length === 5);

    const activeOnly = filterProducts(testProducts, { status: "active" });
    check("A2. Status 'active' returns only active products", activeOnly.length === 4 && !activeOnly.some((p) => !p.active));

    const archivedOnly = filterProducts(testProducts, { status: "archived" });
    check("A3. Status 'archived' returns only archived products", archivedOnly.length === 1 && archivedOnly[0]?.sku === "COLG-HRB");

    // ============================================================
    // 6. STOCK-LEVEL FILTERING
    // ============================================================
    console.log("\n-- 5. Stock-Level Filtering --");

    const inStock = filterProducts(testProducts, { stockLevel: "in-stock" });
    check("L1. Stock filter 'in-stock' returns products with stockQuantity > 0", inStock.length === 3 && inStock.every((p) => p.stockQuantity > 0));

    const lowStock = filterProducts(testProducts, { stockLevel: "low-stock" });
    check(
        "L2. Stock filter 'low-stock' returns products with 0 < stockQuantity <= 10",
        lowStock.length === 1 && lowStock[0]?.sku === "COLG-MAX" && lowStock[0]?.stockQuantity === 4
    );

    const outOfStock = filterProducts(testProducts, { stockLevel: "out-of-stock" });
    check("L3. Stock filter 'out-of-stock' returns products with stockQuantity <= 0", outOfStock.length === 2 && outOfStock.every((p) => p.stockQuantity <= 0));

    // ============================================================
    // 7. COMBINED MULTI-CRITERIA FILTERING
    // ============================================================
    console.log("\n-- 6. Combined Multi-Criteria Filtering --");

    const combined = filterProducts(testProducts, {
        query: "Colgate",
        categoryId: "cat-oral",
        status: "active",
        stockLevel: "low-stock",
    });
    check("M1. Combined search + category + active + low-stock isolates COLG-MAX", combined.length === 1 && combined[0]?.sku === "COLG-MAX");

    const combinedEmpty = filterProducts(testProducts, {
        query: "Dove",
        categoryId: "cat-oral", // Dove is cat-soap, so should yield 0
    });
    check("M2. Conflicting filters gracefully yield empty results", combinedEmpty.length === 0);

    // ============================================================
    // 8. POS CATALOGUE INACTIVE EXCLUSION GUARANTEE
    // ============================================================
    console.log("\n-- 7. POS Exclusion Guarantee --");

    const posSelectable = filterActivePosProducts(
        testProducts.map((p) => ({ ...p, status: p.active ? "active" : "inactive" }))
    );
    check(
        "P1. Inactive/archived products are strictly excluded from selectable POS catalogue",
        posSelectable.length === 4 && !posSelectable.some((p) => p.status === "inactive")
    );
    check(
        "P2. Archived product 'COLG-HRB' is in product management but excluded from POS",
        testProducts.some((p) => p.sku === "COLG-HRB") && !posSelectable.some((p) => p.sku === "COLG-HRB")
    );

    const ok = summarize();
    process.exit(ok ? 0 : 1);
}

main();
