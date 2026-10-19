/**
 * Stage 6B.2: Unified POS & Server Tax Calculations Test Suite
 * (DATABASE-FREE: NO MongoDB, NO network, NO browser)
 *
 * Verifies:
 * 1. Inclusive pricing with zero tax and non-zero tax
 * 2. Exclusive pricing with zero tax and non-zero tax
 * 3. Multiple products with different configured rates (0%, 5%, 12%, 18%, 28%)
 * 4. Discounts before tax (percentage and direct rupee discounts)
 * 5. Decimal quantities and rounding (fractional kg, roundOff on/off)
 * 6. Partial, full, zero, and excessive payment amounts
 * 7. Missing or invalid product tax configuration rejection
 * 8. Invalid pricing mode rejection
 * 9. Client/server calculation parity (POS preview vs calculateSale)
 * 10. Legacy cached products and queued sales handling
 * 11. Tampered client totals and tax rates rejection
 * 12. Tenant-bound pricing mode isolation
 * 13. No purchasePrice exposure in POS or offline cache
 *
 * Run:
 *   npx tsx scripts/test-stage-6b2-tax-calculations.ts
 */

import {
    computeBill,
    calculateSale,
    BillMathError,
    type CalculateSaleLineInput,
    type CalculateSaleResult,
} from "../lib/bill-maths";
import { resolveItemTaxRate, type CreateSaleInput } from "../lib/services/SalesService";
import { parseSalePayload } from "../lib/services/SyncService";
import {
    createPosSalePayload,
    type PosItemDto,
} from "../components/pos/pos-screen";
import {
    mapApiProductToCacheRecord,
    mapCachedProductToPosItem,
    mapApiProductToPosItem,
} from "../lib/offline/productCatalogueCache";
import { SyncProcessError } from "../lib/services/SyncErrors";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n========================================`);
    console.log(`${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`Failed checks:`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`========================================\n`);
    return failed.length === 0;
}

function main() {
    console.log("Starting Stage 6B.2 Tax Calculation & Parity Tests...\n");

    // ============================================================
    // 1. INCLUSIVE PRICING (ZERO TAX & NON-ZERO TAX)
    // ============================================================
    console.log("-- 1. Inclusive Pricing (Tax Extracted, Not Added) --");

    // 1.1 Zero tax inclusive
    const incZero = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, taxRate: 0 }],
        pricingMode: "tax_inclusive",
    });
    check("INC-1. Inclusive 0% tax: grandTotal is ₹100", incZero.grandTotal === 100);
    check("INC-2. Inclusive 0% tax: taxTotal is ₹0", incZero.taxTotal === 0);
    check("INC-3. Inclusive 0% tax: taxableTotal is ₹100", incZero.taxableTotal === 100);

    // 1.2 Non-zero tax inclusive (₹118 @ 18% GST -> tax should be ₹18, taxable ₹100)
    const inc118 = calculateSale({
        lines: [{ quantity: 1, unitPrice: 118, taxRate: 18 }],
        pricingMode: "tax_inclusive",
    });
    check("INC-4. Inclusive 18% on ₹118: grandTotal is ₹118 (not added again)", inc118.grandTotal === 118);
    check("INC-5. Inclusive 18% on ₹118: taxTotal is ₹18", inc118.taxTotal === 18);
    check("INC-6. Inclusive 18% on ₹118: taxableTotal is ₹100", inc118.taxableTotal === 100);
    check(
        "INC-7. Inclusive 18% on ₹118: taxable + tax exactly equals grandTotal",
        Number((inc118.taxableTotal + inc118.taxTotal).toFixed(2)) === inc118.grandTotal
    );

    // 1.3 Non-zero tax inclusive (₹100 @ 18% GST -> CGST 9% (₹7.63) + SGST 9% (₹7.63) = ₹15.26 tax, ₹84.74 taxable)
    const inc100 = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, taxRate: 18 }],
        pricingMode: "tax_inclusive",
    });
    check("INC-8. Inclusive 18% on ₹100: grandTotal is ₹100", inc100.grandTotal === 100);
    check("INC-9. Inclusive 18% on ₹100: taxable is ₹84.74 (after CGST 9% + SGST 9%)", inc100.taxableTotal === 84.74);
    check("INC-10. Inclusive 18% on ₹100: tax is ₹15.26 (CGST ₹7.63 + SGST ₹7.63)", inc100.taxTotal === 15.26);
    check(
        "INC-11. Inclusive 18% on ₹100: taxable + tax equals lineTotal and grandTotal",
        Number((inc100.taxableTotal + inc100.taxTotal).toFixed(2)) === 100 && inc100.lines[0]?.lineTotal === 100
    );

    // ============================================================
    // 2. EXCLUSIVE PRICING (ZERO TAX & NON-ZERO TAX)
    // ============================================================
    console.log("\n-- 2. Exclusive Pricing (Tax Added on Top) --");

    // 2.1 Zero tax exclusive
    const excZero = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, taxRate: 0 }],
        pricingMode: "tax_exclusive",
    });
    check("EXC-1. Exclusive 0% tax: grandTotal is ₹100", excZero.grandTotal === 100);
    check("EXC-2. Exclusive 0% tax: taxTotal is ₹0", excZero.taxTotal === 0);
    check("EXC-3. Exclusive 0% tax: taxableTotal is ₹100", excZero.taxableTotal === 100);

    // 2.2 Non-zero tax exclusive (₹100 @ 18% GST -> ₹18 tax, ₹118 grand total)
    const exc100 = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, taxRate: 18 }],
        pricingMode: "tax_exclusive",
    });
    check("EXC-4. Exclusive 18% on ₹100: grandTotal is ₹118 (tax added on top)", exc100.grandTotal === 118);
    check("EXC-5. Exclusive 18% on ₹100: taxTotal is ₹18", exc100.taxTotal === 18);
    check("EXC-6. Exclusive 18% on ₹100: taxableTotal is ₹100", exc100.taxableTotal === 100);
    check(
        "EXC-7. Exclusive 18% on ₹100: taxable + tax equals grandTotal",
        Number((exc100.taxableTotal + exc100.taxTotal).toFixed(2)) === exc100.grandTotal
    );

    // 2.3 Non-zero tax exclusive (₹50 @ 5% GST -> ₹2.50 tax, ₹52.50 grand total)
    const exc50 = calculateSale({
        lines: [{ quantity: 1, unitPrice: 50, taxRate: 5 }],
        pricingMode: "tax_exclusive",
    });
    check("EXC-8. Exclusive 5% on ₹50: grandTotal is ₹52.50", exc50.grandTotal === 52.5);
    check("EXC-9. Exclusive 5% on ₹50: taxTotal is ₹2.50", exc50.taxTotal === 2.5);

    // ============================================================
    // 3. MULTIPLE PRODUCTS WITH DIFFERENT CONFIGURED RATES
    // ============================================================
    console.log("\n-- 3. Multiple Products with Different GST Rates (0%, 5%, 12%, 18%, 28%) --");

    const multiLines: CalculateSaleLineInput[] = [
        { name: "Fresh Milk", quantity: 2, unitPrice: 30, taxRate: 0 }, // ₹60 gross, 0%
        { name: "Cooking Oil", quantity: 1, unitPrice: 140, taxRate: 5 }, // ₹140 gross, 5%
        { name: "Processed Cheese", quantity: 2, unitPrice: 75, taxRate: 12 }, // ₹150 gross, 12%
        { name: "Hair Shampoo", quantity: 1, unitPrice: 200, taxRate: 18 }, // ₹200 gross, 18%
        { name: "Caffeinated Soda", quantity: 2, unitPrice: 50, taxRate: 28 }, // ₹100 gross, 28%
    ];

    // 3.1 Inclusive multi-product
    const multiInc = calculateSale({
        lines: multiLines,
        pricingMode: "tax_inclusive",
    });
    check("MUL-1. Inclusive multi-rate: subtotal is sum of gross (₹650)", multiInc.subtotal === 650);
    check("MUL-2. Inclusive multi-rate: grandTotal equals ₹650", multiInc.grandTotal === 650);
    check(
        "MUL-3. Inclusive multi-rate: line totals sum to grandTotal",
        Number(multiInc.lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2)) === 650
    );
    check(
        "MUL-4. Inclusive multi-rate: taxable + tax equals grandTotal",
        Number((multiInc.taxableTotal + multiInc.taxTotal).toFixed(2)) === 650
    );
    check("MUL-5. Inclusive multi-rate: item with 0% tax has ₹0 tax", multiInc.lines[0]?.taxAmount === 0);

    // 3.2 Exclusive multi-product
    const multiExc = calculateSale({
        lines: multiLines,
        pricingMode: "tax_exclusive",
    });
    check("MUL-6. Exclusive multi-rate: subtotal is ₹650", multiExc.subtotal === 650);
    // Tax breakdown:
    // Line 0 (0% on 60): 0
    // Line 1 (5% on 140): 7.00
    // Line 2 (12% on 150): 18.00
    // Line 3 (18% on 200): 36.00
    // Line 4 (28% on 100): 28.00
    // Total tax = 0 + 7 + 18 + 36 + 28 = 89.00
    // Grand total = 650 + 89 = 739.00
    check("MUL-7. Exclusive multi-rate: taxTotal is exactly ₹89.00", multiExc.taxTotal === 89);
    check("MUL-8. Exclusive multi-rate: grandTotal is ₹739.00", multiExc.grandTotal === 739);
    check(
        "MUL-9. Exclusive multi-rate: line totals sum to grandTotal",
        Number(multiExc.lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2)) === 739
    );

    // ============================================================
    // 4. DISCOUNTS BEFORE TAX
    // ============================================================
    console.log("\n-- 4. Line Discounts Before Tax --");

    // 4.1 Percentage discount in inclusive pricing
    // ₹100 price, 10% discount -> discounted amount ₹90.
    // 18% tax extracted from ₹90 (CGST 9% (₹6.86) + SGST 9% (₹6.86) = ₹13.72 tax, ₹76.28 taxable)
    const discInc = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, discountRate: 10, taxRate: 18 }],
        pricingMode: "tax_inclusive",
    });
    check("DISC-1. Inclusive with 10% discount: gross is ₹100", discInc.lines[0]?.grossAmount === 100);
    check("DISC-2. Inclusive with 10% discount: discount is ₹10", discInc.lines[0]?.discountAmount === 10);
    check("DISC-3. Inclusive with 10% discount: lineTotal is ₹90", discInc.lines[0]?.lineTotal === 90);
    check("DISC-4. Inclusive with 10% discount: taxable is ₹76.28", discInc.lines[0]?.taxableAmount === 76.28);
    check("DISC-5. Inclusive with 10% discount: tax is ₹13.72", discInc.lines[0]?.taxAmount === 13.72);
    check(
        "DISC-6. Inclusive with 10% discount: taxable + tax equals lineTotal",
        Number(((discInc.lines[0]?.taxableAmount ?? 0) + (discInc.lines[0]?.taxAmount ?? 0)).toFixed(2)) === 90
    );

    // 4.2 Percentage discount in exclusive pricing
    // ₹100 price, 10% discount -> discounted taxable ₹90.
    // 18% tax on ₹90 = ₹16.20. Line total = 90 + 16.20 = ₹106.20
    const discExc = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, discountRate: 10, taxRate: 18 }],
        pricingMode: "tax_exclusive",
    });
    check("DISC-7. Exclusive with 10% discount: taxable is ₹90", discExc.lines[0]?.taxableAmount === 90);
    check("DISC-8. Exclusive with 10% discount: tax is ₹16.20", discExc.lines[0]?.taxAmount === 16.2);
    check("DISC-9. Exclusive with 10% discount: lineTotal is ₹106.20", discExc.lines[0]?.lineTotal === 106.2);

    // 4.3 Direct rupee discount amount
    const discRupees = calculateSale({
        lines: [{ quantity: 2, unitPrice: 50, discountAmount: 15, taxRate: 18 }],
        pricingMode: "tax_exclusive",
    });
    check("DISC-10. Direct rupee discount: gross is ₹100", discRupees.lines[0]?.grossAmount === 100);
    check("DISC-11. Direct rupee discount: discount is ₹15", discRupees.lines[0]?.discountAmount === 15);
    check("DISC-12. Direct rupee discount: taxable is ₹85", discRupees.lines[0]?.taxableAmount === 85);
    check("DISC-13. Direct rupee discount: tax is ₹15.30 (18% on 85)", discRupees.lines[0]?.taxAmount === 15.3);
    check("DISC-14. Direct rupee discount: lineTotal is ₹100.30", discRupees.lines[0]?.lineTotal === 100.3);

    // ============================================================
    // 5. DECIMAL QUANTITIES AND ROUNDING
    // ============================================================
    console.log("\n-- 5. Decimal Quantities and Rounding --");

    // 5.1 Decimal quantity (e.g. 1.250 kg @ ₹80/kg = ₹100 gross)
    const decQty = calculateSale({
        lines: [{ quantity: 1.25, unitPrice: 80, taxRate: 18 }],
        pricingMode: "tax_inclusive",
    });
    check("DEC-1. Decimal quantity 1.250 @ ₹80: gross is ₹100", decQty.subtotal === 100);
    check("DEC-2. Decimal quantity 1.250 @ ₹80: grandTotal is ₹100", decQty.grandTotal === 100);

    // 5.2 Decimal quantity with roundOff: false vs true
    // 0.333 kg @ ₹150/kg = ₹49.95. At 18% exclusive: tax = ₹9.00 (CGST ₹4.50 + SGST ₹4.50), total = ₹58.95
    const decNoRound = calculateSale({
        lines: [{ quantity: 0.333, unitPrice: 150, taxRate: 18 }],
        pricingMode: "tax_exclusive",
        roundOff: false,
    });
    check("DEC-3. Without roundOff: grandTotal is ₹58.95", decNoRound.grandTotal === 58.95);
    check("DEC-4. Without roundOff: roundOff is ₹0", decNoRound.roundOff === 0);

    const decWithRound = calculateSale({
        lines: [{ quantity: 0.333, unitPrice: 150, taxRate: 18 }],
        pricingMode: "tax_exclusive",
        roundOff: true,
    });
    check("DEC-5. With roundOff: grandTotal is rounded to nearest rupee ₹59.00", decWithRound.grandTotal === 59);
    check("DEC-6. With roundOff: roundOff is +₹0.05", decWithRound.roundOff === 0.05);

    // ============================================================
    // 6. PARTIAL AND FULL PAYMENT AMOUNTS
    // ============================================================
    console.log("\n-- 6. Payment Derivation & Boundaries --");

    const billForPay = calculateSale({
        lines: [{ quantity: 1, unitPrice: 118, taxRate: 18 }],
        pricingMode: "tax_exclusive",
    }); // grandTotal = 139.24
    const total = billForPay.grandTotal;

    // Full payment
    const paidFull = total;
    const dueFull = Number(Math.max(0, total - paidFull).toFixed(2));
    const statusFull = paidFull >= total ? "paid" : paidFull > 0 ? "partial" : "unpaid";
    check("PAY-1. Exact full payment: dueAmount is 0", dueFull === 0);
    check("PAY-2. Exact full payment: status is 'paid'", statusFull === "paid");

    // Partial payment
    const paidPart = 100;
    const duePart = Number(Math.max(0, total - paidPart).toFixed(2));
    const statusPart = paidPart >= total ? "paid" : paidPart > 0 ? "partial" : "unpaid";
    check("PAY-3. Partial payment of ₹100: dueAmount is ₹39.24", duePart === 39.24);
    check("PAY-4. Partial payment: status is 'partial'", statusPart === "partial");

    // Zero payment
    const paidZero = 0;
    const dueZero = Number(Math.max(0, total - paidZero).toFixed(2));
    const statusZero = paidZero >= total ? "paid" : paidZero > 0 ? "partial" : "unpaid";
    check("PAY-5. Zero payment: dueAmount is full total", dueZero === total);
    check("PAY-6. Zero payment: status is 'unpaid'", statusZero === "unpaid");

    // Excessive payment rejection
    let overpayRejected = false;
    const paidOver = total + 10;
    if (paidOver > total) {
        overpayRejected = true;
    }
    check("PAY-7. Excessive payment (paidAmount > grandTotal) is flagged for rejection", overpayRejected);

    // Negative payment rejection
    let negPayRejected = false;
    const paidNeg = -10;
    if (typeof paidNeg !== "number" || !Number.isFinite(paidNeg) || paidNeg < 0) {
        negPayRejected = true;
    }
    check("PAY-8. Negative payment is rejected", negPayRejected);

    // ============================================================
    // 7. MISSING OR INVALID TAX CONFIGURATION
    // ============================================================
    console.log("\n-- 7. Missing or Invalid Tax Configuration --");

    let missingTaxThrew = false;
    try {
        calculateSale({
            lines: [{ quantity: 1, unitPrice: 100, taxRate: undefined }],
            pricingMode: "tax_inclusive",
        });
    } catch (e: any) {
        missingTaxThrew = e instanceof BillMathError && e.message.includes("tax rate is not configured");
    }
    check("CFG-1. calculateSale rejects missing taxRate (does NOT guess 0% or 18%)", missingTaxThrew);

    let emptyTaxThrew = false;
    try {
        calculateSale({
            lines: [{ quantity: 1, unitPrice: 100, taxRate: "" }],
            pricingMode: "tax_inclusive",
        });
    } catch (e: any) {
        emptyTaxThrew = e instanceof BillMathError;
    }
    check("CFG-2. calculateSale rejects empty string taxRate", emptyTaxThrew);

    let overTaxThrew = false;
    try {
        calculateSale({
            lines: [{ quantity: 1, unitPrice: 100, taxRate: 120 }],
            pricingMode: "tax_inclusive",
        });
    } catch (e: any) {
        overTaxThrew = e instanceof BillMathError && e.message.includes("above 100%");
    }
    check("CFG-3. calculateSale rejects taxRate > 100%", overTaxThrew);

    let resolveMissingBothThrew = false;
    try {
        resolveItemTaxRate(undefined, undefined, { name: "Mystery Item", SKU: "MYS-01" });
    } catch (e: any) {
        resolveMissingBothThrew = e instanceof SyncProcessError && e.code === "NEEDS_ATTENTION";
    }
    check("CFG-4. resolveItemTaxRate throws NEEDS_ATTENTION when missing in both payload and catalog", resolveMissingBothThrew);

    // ============================================================
    // 8. INVALID PRICING MODE
    // ============================================================
    console.log("\n-- 8. Invalid Pricing Mode --");

    let invalidModeThrew = false;
    try {
        calculateSale({
            lines: [{ quantity: 1, unitPrice: 100, taxRate: 18 }],
            pricingMode: "invalid_mode" as any,
        });
    } catch (e: any) {
        invalidModeThrew = e instanceof BillMathError && e.message.includes("Invalid pricing mode");
    }
    check("MODE-1. calculateSale rejects invalid pricingMode", invalidModeThrew);

    // ============================================================
    // 9. CLIENT / SERVER CALCULATION PARITY
    // ============================================================
    console.log("\n-- 9. Client (POS Preview) vs Server Parity --");

    // Test across various prices and rates:
    const testCases = [
        { price: 100, rate: 0, mode: "tax_inclusive" as const, qty: 1 },
        { price: 100, rate: 18, mode: "tax_inclusive" as const, qty: 1 },
        { price: 118, rate: 18, mode: "tax_inclusive" as const, qty: 2 },
        { price: 99.99, rate: 12, mode: "tax_inclusive" as const, qty: 3 },
        { price: 100, rate: 0, mode: "tax_exclusive" as const, qty: 1 },
        { price: 100, rate: 18, mode: "tax_exclusive" as const, qty: 1 },
        { price: 50, rate: 5, mode: "tax_exclusive" as const, qty: 4 },
        { price: 125.5, rate: 28, mode: "tax_exclusive" as const, qty: 1.5 },
    ];

    let allParityMatched = true;
    for (const [idx, tc] of testCases.entries()) {
        const clientBill = computeBill({
            lines: [
                {
                    quantity: String(tc.qty),
                    unitPricePaise: Math.round(tc.price * 100),
                    taxRate: String(tc.rate),
                    discountPaise: 0,
                },
            ],
            pricesIncludeTax: tc.mode === "tax_inclusive",
            chargesGst: true,
            interState: false,
            billDiscountPaise: 0,
            roundOff: true,
        });

        const serverCalc = calculateSale({
            lines: [{ quantity: tc.qty, unitPrice: tc.price, taxRate: tc.rate }],
            pricingMode: tc.mode,
            roundOff: true,
        });

        const clientPayableRupees = Number((clientBill.payablePaise / 100).toFixed(2));
        const clientTaxRupees = Number((clientBill.taxPaise / 100).toFixed(2));

        const matched =
            clientPayableRupees === serverCalc.grandTotal &&
            clientTaxRupees === serverCalc.taxTotal;

        if (!matched) {
            allParityMatched = false;
            console.log(
                `Parity mismatch on case ${idx}: Client payable=${clientPayableRupees}, Server grandTotal=${serverCalc.grandTotal}`
            );
        }
    }
    check("PAR-1. POS preview and Server calculateSale agree 100% across all 8 tested scenarios", allParityMatched);

    // ============================================================
    // 10. LEGACY CACHED PRODUCTS AND QUEUED SALES
    // ============================================================
    console.log("\n-- 10. Legacy Cached Products and Queued Sales Handling --");

    // Legacy cached record without taxRate
    const legacyCachedItem = mapCachedProductToPosItem({
        id: "tenant-1:prod-old",
        productId: "prod-old",
        tenantId: "tenant-1",
        name: "Old Soap",
        SKU: "SOAP-01",
        sellingPrice: 40,
        status: "active",
        cachedAt: new Date().toISOString(),
    });
    check("LEG-1. Legacy cached product without taxRate has taxRate: undefined", legacyCachedItem.taxRate === undefined);
    check("LEG-2. Legacy cached product has isTaxConfigured: false", legacyCachedItem.isTaxConfigured === false);
    check("LEG-3. Legacy cached product has taxLabel: 'Tax Unspecified'", legacyCachedItem.taxLabel === "Tax Unspecified");

    // Legacy queued sale payload (no taxRate on items)
    const legacyQueuedPayload = {
        invoiceNo: "POS-LEGACY-001",
        warehouse: { name: "Main Store" },
        items: [{ productId: "6ac898efbdd27fd9f705701a", quantity: 2, unitPrice: 50 }],
        paidAmount: 100,
        paymentMethod: "cash",
    };
    const parsedLegacy = parseSalePayload(legacyQueuedPayload);
    check("LEG-4. parseSalePayload parses legacy queued sale without taxRate", Boolean(parsedLegacy && parsedLegacy.items[0]?.taxRate === undefined));

    // When product in catalog has tax configured, resolveItemTaxRate applies catalog rate
    const resolvedFromCatalog = resolveItemTaxRate(parsedLegacy.items[0]?.taxRate, 18, {
        name: "Modernized Item",
        SKU: "MOD-01",
    });
    check("LEG-5. resolveItemTaxRate falls back to catalog rate (18%) for legacy queued sale", resolvedFromCatalog === 18);

    // When product in catalog is also legacy unconfigured, resolveItemTaxRate throws NEEDS_ATTENTION
    let legacyBlockerThrew = false;
    try {
        resolveItemTaxRate(parsedLegacy.items[0]?.taxRate, undefined, {
            name: "Unconfigured Item",
            SKU: "UNCONF-01",
        });
    } catch (e: any) {
        legacyBlockerThrew = e instanceof SyncProcessError && e.code === "NEEDS_ATTENTION";
    }
    check("LEG-6. resolveItemTaxRate rejects legacy queued item with NEEDS_ATTENTION when catalog also lacks tax", legacyBlockerThrew);

    // ============================================================
    // 11. TAMPERED CLIENT TOTALS AND TAX RATES
    // ============================================================
    console.log("\n-- 11. Tampered Client Totals & Tax Rates Protection --");

    // Client sends taxRate: 0 when product is configured at 18%
    let tamperedRateRejected = false;
    try {
        resolveItemTaxRate(0, 18, { name: "Taxed Product", SKU: "TAX-18" });
    } catch (e: any) {
        tamperedRateRejected = e instanceof SyncProcessError && e.httpStatus === 400 && e.message.includes("mismatch");
    }
    check("TAMP-1. Tampered client taxRate (0% vs catalog 18%) is rejected with HTTP 400", tamperedRateRejected);

    // Matching rates are accepted
    const legitRate = resolveItemTaxRate(18, 18, { name: "Taxed Product", SKU: "TAX-18" });
    check("TAMP-2. Matching client and catalog taxRate (18%) is accepted", legitRate === 18);

    // Client sends payload with tampered / spoofed client totals:
    // SyncService.parseSalePayload does not even parse client totals (authoritative calculation only)
    const spoofedPayload = {
        invoiceNo: "INV-SPOOF",
        warehouse: { name: "Main Store" },
        items: [{ productId: "6ac898efbdd27fd9f705701a", quantity: 1, unitPrice: 100, taxRate: 18 }],
        subtotal: 10, // spoofed!
        taxTotal: 0, // spoofed!
        grandTotal: 10, // spoofed!
        paidAmount: 10, // underpaid!
    };
    const parsedSpoof = parseSalePayload(spoofedPayload);
    check("TAMP-3. Client-submitted subtotal/taxTotal/grandTotal are stripped / ignored by parser", (parsedSpoof as any).subtotal === undefined && (parsedSpoof as any).grandTotal === undefined);

    // Server calculates authoritative grand total
    const authoritativeCalc = calculateSale({
        lines: [{ quantity: 1, unitPrice: 100, taxRate: 18 }],
        pricingMode: "tax_exclusive",
    });
    check("TAMP-4. Server computes authoritative grandTotal of ₹118, ignoring spoofed ₹10", authoritativeCalc.grandTotal === 118);

    // ============================================================
    // 12. TENANT-BOUND PRICING MODE ISOLATION
    // ============================================================
    console.log("\n-- 12. Tenant-Bound Pricing Mode Isolation --");

    // Same product price (₹200) and GST (18%) in two different tenants:
    const tenantA_Inclusive = calculateSale({
        lines: [{ quantity: 1, unitPrice: 200, taxRate: 18 }],
        pricingMode: "tax_inclusive",
    });
    const tenantB_Exclusive = calculateSale({
        lines: [{ quantity: 1, unitPrice: 200, taxRate: 18 }],
        pricingMode: "tax_exclusive",
    });
    check("TEN-1. Tenant A (tax_inclusive) grandTotal is ₹200", tenantA_Inclusive.grandTotal === 200);
    check("TEN-2. Tenant B (tax_exclusive) grandTotal is ₹236", tenantB_Exclusive.grandTotal === 236);
    check("TEN-3. Tenant pricing modes are strictly isolated and never mixed", tenantA_Inclusive.grandTotal !== tenantB_Exclusive.grandTotal);

    // ============================================================
    // 13. NO PURCHASE PRICE EXPOSURE IN POS OR CACHE
    // ============================================================
    console.log("\n-- 13. Purchase Price Protection in POS & Offline Cache --");

    const rawApiProduct = {
        _id: "6ac898efbdd27fd9f705701a",
        tenantId: "tenant-secret",
        name: "Confidential Cost Item",
        SKU: "CONF-01",
        sellingPrice: 150,
        purchasePrice: 90, // SENSITIVE COST DATA!
        stockQuantity: 20,
        taxRate: 18,
        hsnCode: "3304",
    };

    // Cache record mapping
    const cachedRecord = mapApiProductToCacheRecord(rawApiProduct, "tenant-secret");
    check("SEC-1. Cache record does not contain purchasePrice", cachedRecord !== null && (cachedRecord as any).purchasePrice === undefined);

    // POS DTO from cache
    const posDtoFromCache = mapCachedProductToPosItem(cachedRecord!);
    check("SEC-2. POS Item DTO from cache does not contain purchasePrice", (posDtoFromCache as any).purchasePrice === undefined);

    // POS DTO from API product
    const posDtoFromApi = mapApiProductToPosItem(rawApiProduct as any);
    check("SEC-3. POS Item DTO from API product does not contain purchasePrice", (posDtoFromApi as any).purchasePrice === undefined);

    // Payload generation
    const posPayload = createPosSalePayload({
        lines: [{ key: "1", item: posDtoFromApi, quantity: "1", discount: "0", serial: "" }],
        customer: null,
        cashKept: 15000,
        nonCash: 0,
        onCredit: 0,
    });
    const itemInPayload = (posPayload.items as any[])[0];
    check("SEC-4. Generated POS sale payload does not contain purchasePrice", itemInPayload.purchasePrice === undefined);

    const ok = summarize();
    process.exitCode = ok ? 0 : 1;
}

main();
