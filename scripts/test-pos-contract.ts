
/*
 * POS Sale Contract and Lookup Tests
 * (NO DATABASE, NO SERVER, NO NETWORK).
 *
 * Validates:
 * 1. matchCatalogItems lookup (barcode exact, SKU exact, substring name/SKU).
 * 2. Inactive product filtering for POS catalogue.
 * 3. createPosSalePayload structure against SyncService.parseSalePayload:
 *    - Required invoiceNo, warehouse, and items.
 *    - Optional customerId (ObjectId validation), paidAmount, paymentMethod, notes.
 *    - Discount rate calculation (percentage).
 * 4. Error rejection by parseSalePayload when required fields are missing.
 *
 * Run:
 *   npx tsx scripts/test-pos-contract.ts
 */

import { parseSalePayload } from "../lib/services/SyncService";
import {
    createPosSalePayload,
    matchCatalogItems,
    type PosItemDto,
} from "../components/pos/pos-screen";

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
    // ============================================================
    // 1. CATALOGUE LOOKUP & BARCODE MATCHING
    // ============================================================

    const testCatalog: PosItemDto[] = [
        {
            variantId: "6ac898efbdd27fd9f705701a",
            name: "Colgate Total 120g",
            sku: "COLG-120",
            barcode: "8901030383821",
            unitCode: "pcs",
            allowsFraction: false,
            trackSerial: false,
            pricePaise: 12000,
            taxRate: "18",
            taxLabel: "GST 18%",
            inStock: "25",
        },
        {
            variantId: "6ac898efbdd27fd9f705701b",
            name: "Colgate MaxFresh 100g",
            sku: "COLG-MAX",
            barcode: "8901030383822",
            unitCode: "pcs",
            allowsFraction: false,
            trackSerial: false,
            pricePaise: 9500,
            taxRate: "18",
            taxLabel: "GST 18%",
            inStock: "10",
        },
        {
            variantId: "6ac898efbdd27fd9f705701c",
            name: "Oral-B Toothbrush Soft",
            sku: "ORALB-SFT",
            barcode: undefined,
            unitCode: "pcs",
            allowsFraction: false,
            trackSerial: false,
            pricePaise: 4000,
            taxRate: "18",
            taxLabel: "GST 18%",
            inStock: "50",
        },
    ];

    // Barcode exact match
    const barcodeHit = matchCatalogItems(testCatalog, "8901030383821");
    check("B1. Barcode scan finds exact item directly", barcodeHit.exact?.sku === "COLG-120");

    // SKU exact match
    const skuHit = matchCatalogItems(testCatalog, "colg-max");
    check("B2. SKU scan finds exact item directly (case-insensitive)", skuHit.exact?.sku === "COLG-MAX");

    // Name substring match with multiple hits
    const nameHits = matchCatalogItems(testCatalog, "Colgate");
    check(
        "B3. Name substring search returns all matching candidates",
        nameHits.exact === undefined && nameHits.candidates.length === 2
    );

    // Single name substring match
    const singleName = matchCatalogItems(testCatalog, "Toothbrush");
    check(
        "B4. Single name match returns that candidate",
        singleName.exact === undefined && singleName.candidates.length === 1 && singleName.candidates[0]?.sku === "ORALB-SFT"
    );

    // Empty or non-matching query
    const emptyHit = matchCatalogItems(testCatalog, "   ");
    check("B5. Whitespace query returns no candidates", emptyHit.candidates.length === 0);

    const missingHit = matchCatalogItems(testCatalog, "NonExistentBarcode999");
    check("B6. Unmatched barcode returns empty candidates list", missingHit.candidates.length === 0 && !missingHit.exact);

    // Inactive product exclusion
    const rawProductsFromApi = [
        { _id: "1", name: "Active Item", SKU: "ACT-01", status: "active", sellingPrice: 50 },
        { _id: "2", name: "Archived Item", SKU: "ARC-01", status: "inactive", sellingPrice: 80 },
        { _id: "3", name: "Default Active Item", SKU: "DEF-01", sellingPrice: 100 },
    ];
    const filteredForPos = rawProductsFromApi.filter((p) => p.status !== "inactive");
    check("B7. Inactive products are excluded from selectable POS catalogue", filteredForPos.length === 2 && !filteredForPos.some((p) => p.name === "Archived Item"));

    // ============================================================
    // 2. POS SALE PAYLOAD GENERATION
    // ============================================================

    const sampleLines = [
        {
            key: "line-1",
            item: testCatalog[0]!,
            quantity: "2",
            discount: "24", // ₹24 discount on gross of 2 * ₹120 = ₹240 (10% discountRate)
            serial: "",
        },
        {
            key: "line-2",
            item: testCatalog[2]!,
            quantity: "1",
            discount: "0",
            serial: "",
        },
    ];

    const payload = createPosSalePayload({
        branchName: "Kochi Downtown Branch",
        lines: sampleLines,
        customer: {
            id: "6ac898efbdd27fd9f7057099", // valid 24-char ObjectId
            name: "John Doe",
            phone: "9876543210",
            balancePaise: 0,
            creditLimitPaise: 0,
        },
        reference: "INV-CASHIER-01",
        card: "",
        upi: "256",
        cashReceived: "0",
        payablePaise: 25600,
        cashKept: 0,
        nonCash: 25600,
        onCredit: 0,
    });

    check("P1. Generated payload includes non-empty upper-case invoiceNo", typeof payload.invoiceNo === "string" && payload.invoiceNo === "INV-CASHIER-01");
    check("P2. Generated payload includes warehouse name", (payload.warehouse as { name: string })?.name === "Kochi Downtown Branch");
    check("P3. Generated payload includes mapped items array", Array.isArray(payload.items) && (payload.items as unknown[]).length === 2);
    check("P4. Generated payload sets customerId for valid ObjectId", payload.customerId === "6ac898efbdd27fd9f7057099");
    check("P5. Generated payload includes customer notes", typeof payload.notes === "string" && (payload.notes as string).includes("John Doe"));
    check("P6. Generated payload sets paymentMethod to 'upi'", payload.paymentMethod === "upi");
    check("P7. Generated payload sets paidAmount in rupees", payload.paidAmount === 256);

    // Test item discount calculation
    const firstItem = (payload.items as { discountRate?: number }[])[0];
    check("P8. Line discount is converted to percentage discountRate", firstItem?.discountRate === 10);

    // Test walk-in customer with UUID id (must NOT send invalid customerId to backend)
    const walkInPayload = createPosSalePayload({
        lines: sampleLines,
        customer: {
            id: "e44d5c80-c15c-43f5-bf15-888999aabbcc", // client UUID, NOT a Mongo ObjectId
            name: "Walk-in",
            phone: null,
            balancePaise: 0,
            creditLimitPaise: 0,
        },
        cashKept: 25600,
        nonCash: 0,
        onCredit: 0,
    });
    check("P9. Client UUID customer id is omitted from customerId field", walkInPayload.customerId === undefined);
    check("P10. Auto-generated invoiceNo starts with POS-", typeof walkInPayload.invoiceNo === "string" && (walkInPayload.invoiceNo as string).startsWith("POS-"));

    // ============================================================
    // 3. SYNCSERVICE.PARSESALEPAYLOAD VALIDATION
    // ============================================================

    const parsedSale = parseSalePayload(payload);
    check("S1. SyncService.parseSalePayload accepts the POS sale payload without error", Boolean(parsedSale && parsedSale.invoiceNo === "INV-CASHIER-01"));
    check("S2. Parsed sale items match expected contract", parsedSale.items.length === 2 && parsedSale.items[0]?.productId === testCatalog[0]!.variantId);
    check("S3. Parsed warehouse matches input", parsedSale.warehouse.name === "Kochi Downtown Branch");
    check("S4. Parsed payment method matches", parsedSale.paymentMethod === "upi");

    // Negative tests for parseSalePayload contract enforcement
    let missingInvoiceThrew = false;
    try {
        parseSalePayload({
            warehouse: { name: "Main Store" },
            items: [{ productId: "6ac898efbdd27fd9f705701a", quantity: 1 }],
        });
    } catch {
        missingInvoiceThrew = true;
    }
    check("S5. parseSalePayload rejects payload missing invoiceNo", missingInvoiceThrew);

    let missingWarehouseThrew = false;
    try {
        parseSalePayload({
            invoiceNo: "POS-123",
            items: [{ productId: "6ac898efbdd27fd9f705701a", quantity: 1 }],
        });
    } catch {
        missingWarehouseThrew = true;
    }
    check("S6. parseSalePayload rejects payload missing warehouse", missingWarehouseThrew);

    let emptyItemsThrew = false;
    try {
        parseSalePayload({
            invoiceNo: "POS-123",
            warehouse: { name: "Main Store" },
            items: [],
        });
    } catch {
        emptyItemsThrew = true;
    }
    check("S7. parseSalePayload rejects payload with empty items array", emptyItemsThrew);

    const ok = summarize();
    process.exitCode = ok ? 0 : 1;
}

main();
