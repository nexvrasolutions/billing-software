/*
 * Stage 6B.1 Foundation Validation Test Suite
 * (NO DATABASE, NO NETWORK, NO BROWSER AUTOMATION)
 *
 * Tests:
 * 1. Product tax fields schema validation (create & update schemas):
 *    - Accepted GST rates (0, 0.25, 3, 5, 12, 18, 28, 100, undefined, null on update)
 *    - Rejected GST rates (-1, 101, NaN, Infinity, strings)
 *    - Accepted HSN/SAC codes (valid strings, undefined, null on update)
 *    - Rejected HSN codes (strings > 20 chars, non-strings)
 *    - Legacy products missing tax fields pass validation
 * 2. Product field projection & cost protection:
 *    - taxRate and hsnCode preserved in public projection
 *    - purchasePrice and __v strictly excluded for ordinary requests
 *    - purchasePrice preserved for authorized cost requests
 *    - Legacy products preserved without injecting false defaults (no 18% assumption)
 * 3. Business pricing mode validation & Tenant settings:
 *    - Accepted pricing modes ("tax_inclusive", "tax_exclusive")
 *    - Rejected pricing modes ("inclusive", "exclusive", "vat", null, numbers, empty)
 *    - Legacy tenants default to "tax_inclusive"
 * 4. Business settings API route guards (database-free via dependency injection):
 *    - GET: 401 when unauthenticated
 *    - GET: 200 with tenant settings and pricingMode
 *    - PUT: 401 when unauthenticated
 *    - PUT: 403 when caller is not owner and lacks users.update permission
 *    - PUT: 200 when caller is tenant owner
 *    - PUT: 200 when caller has users.update permission
 *    - PUT: 400 when invalid pricingMode is submitted
 *    - PUT: verifies strict tenant isolation
 * 5. Offline catalogue cache backward compatibility:
 *    - mapApiProductToCacheRecord preserves taxRate & hsnCode, excludes purchasePrice
 *    - mapApiProductToCacheRecord handles legacy products without assuming 18%
 *    - mapCachedProductToPosItem maps taxRate: 18 -> "GST 18%"
 *    - mapCachedProductToPosItem maps taxRate: 0 -> "GST 0%"
 *    - mapCachedProductToPosItem maps missing taxRate -> "0" / "Tax Unspecified" (never 18%)
 *    - mapApiProductToPosItem behaves consistently for direct API to POS conversion
 *
 * Run:
 *   npx tsx scripts/test-gst-and-pricing-settings.ts
 */

if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "throwaway-secret-for-database-free-tests-only";
}

import { NextRequest } from "next/server";
import { createProductSchema, updateProductSchema } from "../lib/validations/product";
import {
    updateBusinessSettingsSchema,
    handleGetBusinessSettings as getBusinessSettings,
    handlePutBusinessSettings as putBusinessSettings,
} from "../lib/settings/businessSettings";
import {
    filterProductFields,
    filterProductsList,
    PRODUCT_PUBLIC_FIELDS,
} from "../lib/catalog/productProjection";
import {
    mapApiProductToCacheRecord,
    mapCachedProductToPosItem,
    mapApiProductToPosItem,
} from "../lib/offline/productCatalogueCache";
import { rateToE4, computeBill } from "../lib/bill-maths";
import { createPosSalePayload } from "../components/pos/pos-screen";
import { parseSalePayload } from "../lib/services/SyncService";
import { resolveItemTaxRate } from "../lib/services/SalesService";
import { SyncProcessError } from "../lib/services/SyncErrors";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

async function runTests() {
    console.log("=== STAGE 6B.1: PRODUCT GST & BUSINESS PRICING SETTINGS TESTS ===\n");

    // ------------------------------------------------------------------------
    // SECTION 1: Product Tax Fields Schema Validation
    // ------------------------------------------------------------------------
    console.log("-- 1. Product Tax Fields Validation (create & update schemas) --");

    const validCreateBase = {
        name: "Amul Butter 500g",
        SKU: "AMUL-BUTTER-500",
        categoryId: "6ac898efbdd27fd9f7057001",
        unitId: "6ac898efbdd27fd9f7057002",
        purchasePrice: 220.0,
        sellingPrice: 275.0,
    };

    // Valid GST rates
    const validGstRates = [0, 0.25, 3, 5, 12, 18, 28, 100];
    for (const rate of validGstRates) {
        const createResult = createProductSchema.safeParse({ ...validCreateBase, taxRate: rate });
        check(`P1. createProductSchema accepts valid GST rate ${rate}%`, createResult.success);

        const updateResult = updateProductSchema.safeParse({ taxRate: rate });
        check(`P2. updateProductSchema accepts valid GST rate ${rate}%`, updateResult.success);
    }

    // Undefined tax rate (legacy / optional)
    const createNoTax = createProductSchema.safeParse(validCreateBase);
    check("P3. createProductSchema accepts omitted taxRate (legacy-compatible)", createNoTax.success);

    // Null tax rate on update (clearing tax rate)
    const updateNullTax = updateProductSchema.safeParse({ taxRate: null });
    check("P4. updateProductSchema accepts null taxRate (to unset)", updateNullTax.success);

    // Invalid GST rates
    const invalidGstRates = [-1, -0.01, 100.1, 150, NaN, Infinity, "18", true];
    for (const invalidRate of invalidGstRates) {
        const createInvalid = createProductSchema.safeParse({ ...validCreateBase, taxRate: invalidRate });
        check(`P5. createProductSchema rejects invalid taxRate: ${String(invalidRate)}`, !createInvalid.success);

        const updateInvalid = updateProductSchema.safeParse({ taxRate: invalidRate });
        check(`P6. updateProductSchema rejects invalid taxRate: ${String(invalidRate)}`, !updateInvalid.success);
    }

    // Valid HSN codes
    const validHsnCodes = ["8528", "998311", "0101", "84713010", "  9983  "];
    for (const hsn of validHsnCodes) {
        const createHsn = createProductSchema.safeParse({ ...validCreateBase, hsnCode: hsn });
        check(`P7. createProductSchema accepts valid HSN: '${hsn}'`, createHsn.success);

        const updateHsn = updateProductSchema.safeParse({ hsnCode: hsn });
        check(`P8. updateProductSchema accepts valid HSN: '${hsn}'`, updateHsn.success);
    }

    // Null / empty HSN on update
    const updateNullHsn = updateProductSchema.safeParse({ hsnCode: null });
    check("P9. updateProductSchema accepts null hsnCode (to unset)", updateNullHsn.success);

    // Invalid HSN codes (>20 chars, numbers, booleans)
    const invalidHsnCodes = [
        "A".repeat(21),
        12345,
        false,
        {},
    ];
    for (const invalidHsn of invalidHsnCodes) {
        const createInvalidHsn = createProductSchema.safeParse({ ...validCreateBase, hsnCode: invalidHsn });
        check(`P10. createProductSchema rejects invalid hsnCode: ${typeof invalidHsn}`, !createInvalidHsn.success);

        const updateInvalidHsn = updateProductSchema.safeParse({ hsnCode: invalidHsn });
        check(`P11. updateProductSchema rejects invalid hsnCode: ${typeof invalidHsn}`, !updateInvalidHsn.success);
    }

    // ------------------------------------------------------------------------
    // SECTION 2: Product Field Projection & Purchase Cost Protection
    // ------------------------------------------------------------------------
    console.log("\n-- 2. Product Field Projection & Cost Protection --");

    check(
        "PR1. PRODUCT_PUBLIC_FIELDS includes 'taxRate'",
        (PRODUCT_PUBLIC_FIELDS as readonly string[]).includes("taxRate")
    );
    check(
        "PR2. PRODUCT_PUBLIC_FIELDS includes 'hsnCode'",
        (PRODUCT_PUBLIC_FIELDS as readonly string[]).includes("hsnCode")
    );

    const fullProductDoc = {
        _id: "6ac898efbdd27fd9f705701a",
        tenantId: "6abe48a86ae4b08a3e335303",
        name: "Wireless Mouse",
        SKU: "MOUSE-01",
        barcode: "8901234567890",
        purchasePrice: 400.0,
        sellingPrice: 650.0,
        stockQuantity: 15,
        status: "active",
        taxRate: 18,
        hsnCode: "8471",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
        __v: 2,
    };

    // Public / Cashier projection (includeCost = false)
    const publicProjected = filterProductFields(fullProductDoc, false);
    check("PR3. Public projection strictly omits purchasePrice", !("purchasePrice" in publicProjected));
    check("PR4. Public projection strips __v internal metadata", !("__v" in publicProjected));
    check("PR5. Public projection preserves taxRate (18)", publicProjected.taxRate === 18);
    check("PR6. Public projection preserves hsnCode ('8471')", publicProjected.hsnCode === "8471");
    check("PR7. Public projection preserves sellingPrice (650)", publicProjected.sellingPrice === 650.0);

    // Authorized cost projection (includeCost = true)
    const costProjected = filterProductFields(fullProductDoc, true);
    check("PR8. Cost-authorized projection includes purchasePrice (400)", costProjected.purchasePrice === 400.0);
    check("PR9. Cost-authorized projection preserves taxRate (18)", costProjected.taxRate === 18);
    check("PR10. Cost-authorized projection preserves hsnCode ('8471')", costProjected.hsnCode === "8471");
    check("PR11. Cost-authorized projection strips __v", !("__v" in costProjected));

    // Legacy product projection (missing taxRate & hsnCode)
    const legacyProductDoc = {
        _id: "6ac898efbdd27fd9f705701b",
        tenantId: "6abe48a86ae4b08a3e335303",
        name: "Legacy Soap",
        SKU: "SOAP-01",
        purchasePrice: 20.0,
        sellingPrice: 35.0,
        stockQuantity: 100,
        status: "active",
    };
    const legacyProjected = filterProductFields(legacyProductDoc, false);
    check("PR12. Legacy product projection strictly omits purchasePrice", !("purchasePrice" in legacyProjected));
    check(
        "PR13. Legacy product projection does NOT invent 18% taxRate",
        legacyProjected.taxRate === undefined
    );
    check(
        "PR14. Legacy product projection does NOT invent hsnCode",
        legacyProjected.hsnCode === undefined
    );

    // ------------------------------------------------------------------------
    // SECTION 3: Business Pricing Mode Schema Validation
    // ------------------------------------------------------------------------
    console.log("\n-- 3. Business Pricing Mode Schema Validation --");

    const validInclusive = updateBusinessSettingsSchema.safeParse({ pricingMode: "tax_inclusive" });
    check("SM1. updateBusinessSettingsSchema accepts 'tax_inclusive'", validInclusive.success);

    const validExclusive = updateBusinessSettingsSchema.safeParse({ pricingMode: "tax_exclusive" });
    check("SM2. updateBusinessSettingsSchema accepts 'tax_exclusive'", validExclusive.success);

    const validCombined = updateBusinessSettingsSchema.safeParse({
        name: "Supermart Ltd",
        pricingMode: "tax_inclusive",
    });
    check("SM3. updateBusinessSettingsSchema accepts name + pricingMode", validCombined.success);

    // Invalid pricing modes
    const invalidModes = [
        "inclusive",
        "exclusive",
        "vat_inclusive",
        "tax_exempt",
        "TAX_INCLUSIVE",
        18,
        null,
        "",
        true,
    ];
    for (const mode of invalidModes) {
        const invalidResult = updateBusinessSettingsSchema.safeParse({ pricingMode: mode });
        check(`SM4. updateBusinessSettingsSchema rejects '${String(mode)}'`, !invalidResult.success);
    }

    // Empty object rejected
    const emptyResult = updateBusinessSettingsSchema.safeParse({});
    check("SM5. updateBusinessSettingsSchema rejects empty update object", !emptyResult.success);

    // ------------------------------------------------------------------------
    // SECTION 4: Business Settings API Guards & Permission Policy
    // ------------------------------------------------------------------------
    console.log("\n-- 4. Business Settings API Route Guards & Permissions (Database-Free) --");

    const mockTenantId = "6abe48a86ae4b08a3e335303";
    const mockOwnerUserId = "6abe48a86ae4b08a3e335301";
    const mockCashierUserId = "6abe48a86ae4b08a3e335302";
    const mockManagerUserId = "6abe48a86ae4b08a3e335304";

    let dbMockTenant: any = {
        _id: mockTenantId,
        name: "My Retail Store",
        businessType: "Retail",
        ownerUserId: mockOwnerUserId,
        status: "active",
        pricingMode: "tax_inclusive",
    };

    const mockDeps = (authContext: any, hasPermReturn = false) => ({
        getAuthContext: async () => authContext,
        connectToDatabase: async () => {},
        findTenant: async (tenantId: string) => (tenantId === mockTenantId ? dbMockTenant : null),
        checkPermission: async () => hasPermReturn,
    });

    // 4.1 GET unauthenticated -> 401
    const getUnauthReq = new NextRequest("http://localhost:3000/api/settings/business");
    const getUnauthRes = await getBusinessSettings(getUnauthReq, mockDeps(null));
    check("AG1. GET /api/settings/business returns 401 when unauthenticated", getUnauthRes.status === 401);

    // 4.2 GET authenticated -> 200 with pricingMode
    const getAuthReq = new NextRequest("http://localhost:3000/api/settings/business");
    const getAuthRes = await getBusinessSettings(
        getAuthReq,
        mockDeps({
            userId: mockCashierUserId,
            tenantId: mockTenantId,
            roleId: "role-cashier",
        })
    );
    check("AG2. GET /api/settings/business returns 200 for authenticated user", getAuthRes.status === 200);
    const getData = await getAuthRes.json();
    check("AG3. GET returns current pricingMode ('tax_inclusive')", getData.settings?.pricingMode === "tax_inclusive");

    // 4.3 GET on legacy tenant without pricingMode field -> falls back to "tax_inclusive"
    const legacyTenantDeps = {
        getAuthContext: async () => ({ userId: mockCashierUserId, tenantId: mockTenantId, roleId: "role-cashier" }),
        connectToDatabase: async () => {},
        findTenant: async () => ({
            _id: mockTenantId,
            name: "Old Legacy Store",
            ownerUserId: mockOwnerUserId,
            status: "active",
            // pricingMode missing!
        }),
    };
    const getLegacyRes = await getBusinessSettings(getAuthReq, legacyTenantDeps as any);
    const getLegacyData = await getLegacyRes.json();
    check(
        "AG4. GET fallback on legacy tenant provides 'tax_inclusive' without error",
        getLegacyData.settings?.pricingMode === "tax_inclusive"
    );

    // 4.4 PUT unauthenticated -> 401
    const putUnauthReq = new NextRequest("http://localhost:3000/api/settings/business", {
        method: "PUT",
        body: JSON.stringify({ pricingMode: "tax_exclusive" }),
    });
    const putUnauthRes = await putBusinessSettings(putUnauthReq, mockDeps(null));
    check("AG5. PUT /api/settings/business returns 401 when unauthenticated", putUnauthRes.status === 401);

    // 4.5 PUT unauthorized (Cashier, not owner, no users.update permission) -> 403
    const putCashierReq = new NextRequest("http://localhost:3000/api/settings/business", {
        method: "PUT",
        body: JSON.stringify({ pricingMode: "tax_exclusive" }),
    });
    const putCashierRes = await putBusinessSettings(
        putCashierReq,
        mockDeps(
            { userId: mockCashierUserId, tenantId: mockTenantId, roleId: "role-cashier" },
            false // no users.update permission
        )
    );
    check("AG6. PUT /api/settings/business returns 403 for user lacking admin permission", putCashierRes.status === 403);
    const cashierErr = await putCashierRes.json();
    check(
        "AG7. PUT 403 error clearly states permission restriction",
        cashierErr.message.includes("Permission denied")
    );

    // 4.6 PUT authorized as Owner -> 200 OK
    const putOwnerReq = new NextRequest("http://localhost:3000/api/settings/business", {
        method: "PUT",
        body: JSON.stringify({ pricingMode: "tax_exclusive" }),
    });
    const putOwnerRes = await putBusinessSettings(
        putOwnerReq,
        mockDeps(
            { userId: mockOwnerUserId, tenantId: mockTenantId, roleId: "role-owner" },
            false // owner bypasses role permission check
        )
    );
    check("AG8. PUT /api/settings/business returns 200 for Tenant Owner", putOwnerRes.status === 200);
    const putOwnerData = await putOwnerRes.json();
    check(
        "AG9. PUT response returns updated pricingMode ('tax_exclusive')",
        putOwnerData.settings?.pricingMode === "tax_exclusive"
    );

    // 4.7 PUT authorized as Admin/Manager (with users.update permission) -> 200 OK
    const putManagerReq = new NextRequest("http://localhost:3000/api/settings/business", {
        method: "PUT",
        body: JSON.stringify({ pricingMode: "tax_inclusive" }),
    });
    const putManagerRes = await putBusinessSettings(
        putManagerReq,
        mockDeps(
            { userId: mockManagerUserId, tenantId: mockTenantId, roleId: "role-manager" },
            true // has users.update permission
        )
    );
    check("AG10. PUT /api/settings/business returns 200 for Manager with users.update permission", putManagerRes.status === 200);

    // 4.8 PUT invalid pricingMode -> 400 Bad Request
    const putInvalidReq = new NextRequest("http://localhost:3000/api/settings/business", {
        method: "PUT",
        body: JSON.stringify({ pricingMode: "invalid_mode" }),
    });
    const putInvalidRes = await putBusinessSettings(
        putInvalidReq,
        mockDeps({ userId: mockOwnerUserId, tenantId: mockTenantId, roleId: "role-owner" })
    );
    check("AG11. PUT /api/settings/business returns 400 on invalid pricingMode", putInvalidRes.status === 400);

    // ------------------------------------------------------------------------
    // SECTION 5: Offline Catalogue Cache Backward Compatibility
    // ------------------------------------------------------------------------
    console.log("\n-- 5. Offline Catalogue Cache Mapping Compatibility --");

    const tenantA = "tenant-100";

    // 5.1 mapApiProductToCacheRecord with tax fields
    const modernApiProduct = {
        _id: "prod-1",
        tenantId: tenantA,
        name: "Tata Salt 1kg",
        SKU: "TATA-SALT",
        barcode: "890123456701",
        sellingPrice: 28.0,
        stockQuantity: 50,
        status: "active",
        taxRate: 5,
        hsnCode: "2501",
        purchasePrice: 20.0, // should be excluded from cache
    };
    const cachedModern = mapApiProductToCacheRecord(modernApiProduct, tenantA);
    check("C1. Cached record preserves taxRate (5)", cachedModern?.taxRate === 5);
    check("C2. Cached record preserves hsnCode ('2501')", cachedModern?.hsnCode === "2501");
    check("C3. Cached record strictly excludes purchasePrice", !("purchasePrice" in (cachedModern ?? {})));

    // 5.2 mapApiProductToCacheRecord with legacy product (no taxRate, no hsnCode)
    const legacyApiProduct = {
        _id: "prod-legacy",
        tenantId: tenantA,
        name: "Generic Onion",
        SKU: "ONION-01",
        sellingPrice: 40.0,
        stockQuantity: 100,
        status: "active",
        purchasePrice: 25.0,
    };
    const cachedLegacy = mapApiProductToCacheRecord(legacyApiProduct, tenantA);
    check("C4. Legacy cache record has no taxRate (not defaulting to 18%)", cachedLegacy?.taxRate === undefined);
    check("C5. Legacy cache record has no hsnCode", cachedLegacy?.hsnCode === undefined);
    check("C6. Legacy cache record excludes purchasePrice", !("purchasePrice" in (cachedLegacy ?? {})));

    // 5.3 mapCachedProductToPosItem for modern product with 18% GST
    const modernCacheRecord = {
        id: "tenant-100:prod-18",
        productId: "prod-18",
        tenantId: tenantA,
        name: "LED Monitor 24inch",
        SKU: "MON-24",
        sellingPrice: 8500.0,
        stockQuantity: 8,
        status: "active" as const,
        taxRate: 18,
        hsnCode: "8528",
        cachedAt: "2026-10-15T00:00:00.000Z",
    };
    const posModern = mapCachedProductToPosItem(modernCacheRecord);
    check("C7. POS DTO maps taxRate string ('18')", posModern.taxRate === "18");
    check("C8. POS DTO maps taxLabel ('GST 18%')", posModern.taxLabel === "GST 18%");
    check("C9. POS DTO maps hsnCode ('8528')", posModern.hsnCode === "8528");
    check("C10. POS DTO pricePaise is 850000", posModern.pricePaise === 850000);

    // 5.4 mapCachedProductToPosItem for 0% GST product
    const zeroTaxCacheRecord = {
        id: "tenant-100:prod-zero",
        productId: "prod-zero",
        tenantId: tenantA,
        name: "Fresh Milk 1L",
        SKU: "MILK-01",
        sellingPrice: 60.0,
        stockQuantity: 30,
        status: "active" as const,
        taxRate: 0,
        cachedAt: "2026-10-15T00:00:00.000Z",
    };
    const posZero = mapCachedProductToPosItem(zeroTaxCacheRecord);
    check("C11. POS DTO maps 0% taxRate string ('0')", posZero.taxRate === "0");
    check("C12. POS DTO maps 0% taxLabel ('GST 0%')", posZero.taxLabel === "GST 0%");
    check("C12b. POS DTO marks explicit 0% as tax configured", posZero.isTaxConfigured === true);

    // 5.5 mapCachedProductToPosItem for legacy cached product without taxRate
    const legacyCachedRecord = {
        id: "tenant-100:prod-legacy",
        productId: "prod-legacy",
        tenantId: tenantA,
        name: "Old Stock Biscuit",
        SKU: "BISC-01",
        sellingPrice: 10.0,
        stockQuantity: 40,
        status: "active" as const,
        cachedAt: "2026-10-01T00:00:00.000Z",
    };
    const posLegacy = mapCachedProductToPosItem(legacyCachedRecord);
    check(
        "C13. Legacy cached product maps to undefined taxRate (not '0' and not '18')",
        posLegacy.taxRate === undefined
    );
    check(
        "C14. Legacy cached product maps to 'Tax Unspecified'",
        posLegacy.taxLabel === "Tax Unspecified"
    );
    check(
        "C14b. Legacy cached product is marked as tax-unconfigured",
        posLegacy.isTaxConfigured === false
    );
    check(
        "C15. Legacy cached product has no hsnCode property",
        posLegacy.hsnCode === undefined
    );

    // 5.6 mapApiProductToPosItem directly
    const directModernPos = mapApiProductToPosItem({
        _id: "prod-direct",
        name: "Direct API Item",
        SKU: "DIR-01",
        sellingPrice: 120.0,
        taxRate: 12,
        hsnCode: "3306",
    });
    check("C16. Direct API product maps taxRate '12'", directModernPos.taxRate === "12");
    check("C17. Direct API product maps taxLabel 'GST 12%'", directModernPos.taxLabel === "GST 12%");
    check("C18. Direct API product maps hsnCode '3306'", directModernPos.hsnCode === "3306");
    check("C18b. Direct API product marks tax as configured", directModernPos.isTaxConfigured === true);

    const directLegacyPos = mapApiProductToPosItem({
        _id: "prod-dir-legacy",
        name: "Direct Legacy Item",
        SKU: "DIR-LEG",
        sellingPrice: 50.0,
    });
    check("C19. Direct legacy API product maps taxRate undefined (not '0')", directLegacyPos.taxRate === undefined);
    check(
        "C20. Direct legacy API product maps 'Tax Unspecified' (never 18%)",
        directLegacyPos.taxLabel === "Tax Unspecified"
    );
    check(
        "C20b. Direct legacy API product is marked as tax-unconfigured",
        directLegacyPos.isTaxConfigured === false
    );

    // ------------------------------------------------------------------------
    // SECTION 6: Explicit 0% vs Missing Tax Rate in Financial Calculations & Sync
    // ------------------------------------------------------------------------
    console.log("\n-- 6. Explicit 0% vs Missing Tax Rate in Financial Calculations & Sync --");

    // 6.1 rateToE4 distinctions
    check("FC1. rateToE4('0') returns 0n", rateToE4("0") === 0n);
    check("FC2. rateToE4('5') returns 50000n", rateToE4("5") === 50000n);
    let rateUndefThrew = false;
    try {
        rateToE4(undefined);
    } catch (e: any) {
        rateUndefThrew = e.message.includes("not configured");
    }
    check("FC3. rateToE4(undefined) throws BillMathError", rateUndefThrew);

    let rateEmptyThrew = false;
    try {
        rateToE4("");
    } catch (e: any) {
        rateEmptyThrew = e.message.includes("not configured");
    }
    check("FC4. rateToE4('') throws BillMathError", rateEmptyThrew);

    // 6.2 computeBill with explicit 0% vs missing tax rate
    const billExplicitZero = computeBill({
        lines: [
            {
                quantity: "1",
                unitPricePaise: 5000,
                taxRate: "0",
                discountPaise: 0,
            },
        ],
        pricesIncludeTax: true,
        chargesGst: true,
        interState: false,
        billDiscountPaise: 0,
        roundOff: true,
    });
    check("FC5. computeBill succeeds with explicit 0% tax", billExplicitZero.payablePaise === 5000);
    check("FC6. computeBill produces 0 paise tax for explicit 0%", billExplicitZero.taxPaise === 0);

    let billMissingTaxThrew = false;
    try {
        computeBill({
            lines: [
                {
                    quantity: "1",
                    unitPricePaise: 5000,
                    taxRate: undefined, // missing tax rate!
                    discountPaise: 0,
                },
            ],
            pricesIncludeTax: true,
            chargesGst: true,
            interState: false,
            billDiscountPaise: 0,
            roundOff: true,
        });
    } catch (e: any) {
        billMissingTaxThrew = e.message.includes("tax rate is not configured");
    }
    check("FC7. computeBill refuses calculation when tax rate is missing (does NOT guess 0%)", billMissingTaxThrew);

    // 6.3 POS Payload generation with explicit 0% vs missing tax
    const payloadExplicitZero = createPosSalePayload({
        lines: [
            {
                key: "1",
                item: posZero,
                quantity: "2",
                discount: "",
                serial: "",
            },
        ],
        customer: null,
        cashKept: 12000,
        nonCash: 0,
        onCredit: 0,
    });
    const parsedZeroPayload = parseSalePayload(payloadExplicitZero);
    check("FC8. createPosSalePayload attaches taxRate: 0 for explicit 0% product", (payloadExplicitZero.items as any[])[0]?.taxRate === 0);
    check("FC9. parseSalePayload preserves taxRate: 0 for explicit 0%", parsedZeroPayload.items[0]?.taxRate === 0);

    const payloadLegacyMissing = createPosSalePayload({
        lines: [
            {
                key: "2",
                item: posLegacy,
                quantity: "1",
                discount: "",
                serial: "",
            },
        ],
        customer: null,
        cashKept: 1000,
        nonCash: 0,
        onCredit: 0,
    });
    const parsedLegacyPayload = parseSalePayload(payloadLegacyMissing);
    check("FC10. createPosSalePayload omits taxRate when product tax is unconfigured", (payloadLegacyMissing.items as any[])[0]?.taxRate === undefined);
    check("FC11. parseSalePayload preserves undefined taxRate for unconfigured item", parsedLegacyPayload.items[0]?.taxRate === undefined);

    // 6.4 resolveItemTaxRate (Sale sync resolution)
    // Case A: Payload has explicit 0%
    const resolvedExplicitZero = resolveItemTaxRate(0, undefined, { name: "Milk", SKU: "MILK-01" });
    check("FC12. resolveItemTaxRate returns 0 when item has explicit taxRate: 0", resolvedExplicitZero === 0);

    // Case B: Payload has undefined, but product in DB has configured 0%
    const resolvedProductZero = resolveItemTaxRate(undefined, 0, { name: "Milk", SKU: "MILK-01" });
    check("FC13. resolveItemTaxRate returns 0 when product in catalog has configured taxRate: 0", resolvedProductZero === 0);

    // Case C: Payload has undefined, but product in DB has configured 18%
    const resolvedProduct18 = resolveItemTaxRate(undefined, 18, { name: "Shampoo", SKU: "SHMP-01" });
    check("FC14. resolveItemTaxRate returns 18 when product in catalog has configured taxRate: 18", resolvedProduct18 === 18);

    // Case D: BOTH payload and product in DB lack tax configuration
    let resolveMissingError: any = null;
    try {
        resolveItemTaxRate(undefined, undefined, { name: "Legacy Biscuit", SKU: "BISC-LEGACY" });
    } catch (e: any) {
        resolveMissingError = e;
    }
    check(
        "FC15. resolveItemTaxRate throws SyncProcessError when tax rate is missing in both payload and catalog",
        resolveMissingError instanceof SyncProcessError
    );
    check(
        "FC16. SyncProcessError code is 'NEEDS_ATTENTION' for unconfigured tax",
        resolveMissingError?.code === "NEEDS_ATTENTION"
    );
    check(
        "FC17. SyncProcessError httpStatus is 422",
        resolveMissingError?.httpStatus === 422
    );
    check(
        "FC18. SyncProcessError retryable is false (needs user to configure catalog, not blind retry)",
        resolveMissingError?.retryable === false
    );
    check(
        "FC19. SyncProcessError message identifies the specific unconfigured product",
        resolveMissingError?.message?.includes("Legacy Biscuit") && resolveMissingError?.message?.includes("BISC-LEGACY")
    );

    // ------------------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------------------
    console.log("\n========================================================");
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`TOTAL: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log("========================================================\n");

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test execution failed with error:", err);
    process.exit(1);
});
