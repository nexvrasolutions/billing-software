/*
 * Product API Data Protection & Field Projection Tests
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * Validates Stage 6A Fix B:
 * 1. Ordinary product-list responses strictly omit purchasePrice.
 * 2. Ordinary product-list responses retain all required catalogue fields.
 * 3. Mongoose internal metadata (__v) is excluded.
 * 4. Authorized product-list responses include purchasePrice when includeCost is true.
 * 5. Cost permission verification grants access ONLY to authorized roles.
 * 6. Cashier & ordinary roles (products.read, sales.create, taxes.read) are rejected from cost access.
 * 7. Projected ordinary products map seamlessly into POS item DTOs.
 * 8. Projected ordinary products map seamlessly into Dexie cached product records.
 *
 * Run:
 *   npx tsx scripts/test-product-api-exposure.ts
 */

if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "throwaway-secret-for-database-free-tests-only";
}

import { NextRequest } from "next/server";
import {
    filterProductFields,
    filterProductsList,
    hasCostPermission,
    PRODUCT_PUBLIC_FIELDS,
    PRODUCT_COST_PERMISSIONS,
} from "../lib/catalog/productProjection";
import {
    mapApiProductToPosItem,
    mapApiProductToCacheRecord,
} from "../lib/offline/productCatalogueCache";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const mockDbProducts = [
    {
        _id: "6ac898efbdd27fd9f705701a",
        tenantId: "6abe48a86ae4b08a3e335303",
        name: "Colgate Total 120g",
        SKU: "COLG-120",
        barcode: "8901030383821",
        categoryId: "6ac898efbdd27fd9f7057001",
        unitId: "6ac898efbdd27fd9f7057002",
        purchasePrice: 65.50,
        sellingPrice: 120.00,
        stockQuantity: 45,
        status: "active" as const,
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-15T12:00:00.000Z",
        __v: 0,
    },
    {
        _id: "6ac898efbdd27fd9f705701b",
        tenantId: "6abe48a86ae4b08a3e335303",
        name: "Discontinued Toothpaste",
        SKU: "DISC-TOOTH",
        barcode: "8901030383822",
        categoryId: "6ac898efbdd27fd9f7057001",
        unitId: "6ac898efbdd27fd9f7057002",
        purchasePrice: 30.00,
        sellingPrice: 75.00,
        stockQuantity: 0,
        status: "inactive" as const,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-10-10T12:00:00.000Z",
        __v: 1,
    },
];

async function main() {
    console.log("=== STAGE 6A: PRODUCT API DATA PROTECTION TESTS ===\n");

    // ------------------------------------------------------------
    // 1. ORDINARY PRODUCT-LIST RESPONSE (includeCost = false)
    // ------------------------------------------------------------
    console.log("-- 1. Ordinary Product-List Responses (includeCost = false) --");

    const ordinaryProducts = filterProductsList(mockDbProducts, false);

    check("O1. Returns same number of products as input", ordinaryProducts.length === 2);

    for (const [index, p] of ordinaryProducts.entries()) {
        const itemNum = index + 1;
        check(`O2.${itemNum}. purchasePrice is strictly omitted from product ${itemNum}`,
            !("purchasePrice" in p) && p.purchasePrice === undefined
        );
        check(`O3.${itemNum}. Internal __v metadata is stripped from product ${itemNum}`,
            !("__v" in p)
        );
        check(`O4.${itemNum}. Product ID is retained in product ${itemNum}`,
            p._id === mockDbProducts[index]._id
        );
        check(`O5.${itemNum}. Tenant ID is retained in product ${itemNum}`,
            p.tenantId === mockDbProducts[index].tenantId
        );
        check(`O6.${itemNum}. Name is retained in product ${itemNum}`,
            p.name === mockDbProducts[index].name
        );
        check(`O7.${itemNum}. SKU is retained in product ${itemNum}`,
            p.SKU === mockDbProducts[index].SKU
        );
        check(`O8.${itemNum}. Barcode is retained in product ${itemNum}`,
            p.barcode === mockDbProducts[index].barcode
        );
        check(`O9.${itemNum}. Selling price is retained in product ${itemNum}`,
            p.sellingPrice === mockDbProducts[index].sellingPrice
        );
        check(`O10.${itemNum}. Stock quantity is retained in product ${itemNum}`,
            p.stockQuantity === mockDbProducts[index].stockQuantity
        );
        check(`O11.${itemNum}. Status is retained in product ${itemNum}`,
            p.status === mockDbProducts[index].status
        );
    }

    // ------------------------------------------------------------
    // 2. AUTHORIZED COST RESPONSES (includeCost = true)
    // ------------------------------------------------------------
    console.log("\n-- 2. Authorized Cost Responses (includeCost = true) --");

    const authorizedProducts = filterProductsList(mockDbProducts, true);

    check("C1. purchasePrice is preserved when includeCost is true",
        authorizedProducts[0].purchasePrice === 65.50 &&
        authorizedProducts[1].purchasePrice === 30.00
    );
    check("C2. Internal __v is still stripped in authorized cost responses",
        !("__v" in authorizedProducts[0]) && !("__v" in authorizedProducts[1])
    );

    // ------------------------------------------------------------
    // 3. COST PERMISSION VERIFICATION
    // ------------------------------------------------------------
    console.log("\n-- 3. Cost Permission Verification --");

    check("P1. products.create authorizes viewing purchase cost",
        hasCostPermission(new Set(["products.create"])) === true
    );
    check("P2. products.update authorizes viewing purchase cost",
        hasCostPermission(new Set(["products.update"])) === true
    );
    check("P3. purchases.create authorizes viewing purchase cost",
        hasCostPermission(new Set(["purchases.create"])) === true
    );
    check("P4. stock.adjust authorizes viewing purchase cost",
        hasCostPermission(new Set(["stock.adjust"])) === true
    );
    check("P5. products.read ALONE does NOT authorize viewing purchase cost",
        hasCostPermission(new Set(["products.read"])) === false
    );
    check("P6. Cashier permissions (sales.create, taxes.read) do NOT authorize viewing purchase cost",
        hasCostPermission(new Set(["sales.create", "taxes.read", "products.read"])) === false
    );
    check("P7. Empty permissions set does NOT authorize viewing purchase cost",
        hasCostPermission(new Set([])) === false
    );
    check("P8. Array of permission strings is supported",
        hasCostPermission(["products.update", "products.read"]) === true &&
        hasCostPermission(["products.read", "taxes.read"]) === false
    );

    // ------------------------------------------------------------
    // 4. DOWNSTREAM COMPATIBILITY (POS & DEXIE CACHE)
    // ------------------------------------------------------------
    console.log("\n-- 4. Downstream Consumer Compatibility --");

    // Projected product -> POS DTO
    const posItem = mapApiProductToPosItem(ordinaryProducts[0] as any);
    check("D1. Projected ordinary product maps cleanly to PosItemDto",
        posItem.variantId === "6ac898efbdd27fd9f705701a" &&
        posItem.name === "Colgate Total 120g" &&
        posItem.sku === "COLG-120" &&
        posItem.barcode === "8901030383821" &&
        posItem.pricePaise === 12000 &&
        posItem.inStock === "45"
    );

    // Projected product -> Dexie Cache Record
    const cacheRecord = mapApiProductToCacheRecord(
        ordinaryProducts[0],
        "6abe48a86ae4b08a3e335303"
    );
    check("D2. Projected ordinary product maps cleanly to CachedProductRecord",
        cacheRecord !== null &&
        cacheRecord.id === "6abe48a86ae4b08a3e335303:6ac898efbdd27fd9f705701a" &&
        cacheRecord.SKU === "COLG-120" &&
        cacheRecord.sellingPrice === 120.00 &&
        cacheRecord.stockQuantity === 45 &&
        !("purchasePrice" in (cacheRecord as any))
    );

    // ------------------------------------------------------------
    // 5. SINGLE-PRODUCT FIELD PROJECTION (filterProductFields)
    // ------------------------------------------------------------
    console.log("\n-- 5. Single-Product Field Projection --");

    const ordinarySingle = filterProductFields(mockDbProducts[0], false);
    check("S1. purchasePrice is omitted in ordinary single-product projection",
        !("purchasePrice" in ordinarySingle) && ordinarySingle.purchasePrice === undefined
    );
    check("S2. Internal __v is omitted in ordinary single-product projection",
        !("__v" in ordinarySingle)
    );
    check("S3. All public catalogue fields preserved in ordinary single-product projection",
        PRODUCT_PUBLIC_FIELDS.every((f) => f === "id" || !(f in mockDbProducts[0]) || f in ordinarySingle)
    );

    const costSingle = filterProductFields(mockDbProducts[0], true);
    check("S4. purchasePrice is preserved in authorized single-product projection",
        costSingle.purchasePrice === 65.50
    );
    check("S5. Internal __v is omitted in authorized single-product projection",
        !("__v" in costSingle)
    );
    check("S6. All public catalogue fields preserved in authorized single-product projection",
        PRODUCT_PUBLIC_FIELDS.every((f) => f === "id" || !(f in mockDbProducts[0]) || f in costSingle)
    );
    check("S7. Non-object inputs handled defensively",
        Object.keys(filterProductFields(null, false)).length === 0 &&
        Object.keys(filterProductFields(undefined, true)).length === 0
    );

    // ------------------------------------------------------------
    // 6. SINGLE-PRODUCT ROUTE SECURITY (GET /api/products/[id])
    // ------------------------------------------------------------
    console.log("\n-- 6. Single-Product Route Security Behavior --");

    const { GET: getSingleProductRoute } = await import("../app/api/products/[id]/route");

    const validId = "6ac898efbdd27fd9f705701a";
    const tenantId = "6abe48a86ae4b08a3e335303";
    const baseAuth = {
        userId: "6ac898efbdd27fd9f7057005",
        tenantId,
        deviceId: "dev-test-1",
        roleId: "6ac898efbdd27fd9f7057006",
    };

    const makeCtx = (id: string) => ({
        params: Promise.resolve({ id }),
    });

    // R1. Unauthenticated request -> 401
    const unauthReq = new NextRequest(`http://localhost:3000/api/products/${validId}`);
    const unauthRes = await getSingleProductRoute(unauthReq, makeCtx(validId), {
        getAuthContext: async () => null,
    });
    const unauthBody = await unauthRes.json();
    check("R1. Unauthenticated request rejected with HTTP 401",
        unauthRes.status === 401 && unauthBody.success === false && unauthBody.message === "Authentication required"
    );

    // R2. Missing products.read permission -> 403
    const noReadReq = new NextRequest(`http://localhost:3000/api/products/${validId}`);
    const noReadRes = await getSingleProductRoute(noReadReq, makeCtx(validId), {
        getAuthContext: async () => baseAuth,
        checkPermission: async () => false,
    });
    const noReadBody = await noReadRes.json();
    check("R2. Missing products.read permission rejected with HTTP 403",
        noReadRes.status === 403 && noReadBody.success === false && noReadBody.message === "You do not have permission to read products"
    );

    // R3. Invalid product ID -> 400
    const invalidIdReq = new NextRequest("http://localhost:3000/api/products/invalid-id-123");
    const invalidIdRes = await getSingleProductRoute(invalidIdReq, makeCtx("invalid-id-123"), {
        getAuthContext: async () => baseAuth,
        checkPermission: async () => true,
    });
    const invalidIdBody = await invalidIdRes.json();
    check("R3. Malformed product ID rejected with HTTP 400",
        invalidIdRes.status === 400 && invalidIdBody.success === false && invalidIdBody.message === "Invalid product ID"
    );

    // R4. Product not found -> 404
    const notFoundId = "6ac898efbdd27fd9f7057099";
    const notFoundReq = new NextRequest(`http://localhost:3000/api/products/${notFoundId}`);
    const notFoundRes = await getSingleProductRoute(notFoundReq, makeCtx(notFoundId), {
        getAuthContext: async () => baseAuth,
        checkPermission: async () => true,
        connectToDatabase: async () => {},
        findProduct: async () => null,
    });
    const notFoundBody = await notFoundRes.json();
    check("R4. Non-existent product returns HTTP 404",
        notFoundRes.status === 404 && notFoundBody.success === false && notFoundBody.message === "Product not found"
    );

    // R5. Unauthorized includeCost=true (e.g. cashier with products.read only) -> 403
    const unauthCostReq = new NextRequest(`http://localhost:3000/api/products/${validId}?includeCost=true`);
    const unauthCostRes = await getSingleProductRoute(unauthCostReq, makeCtx(validId), {
        getAuthContext: async () => baseAuth,
        checkPermission: async () => true,
        fetchGrantedPermissions: async () => new Set(["products.read", "sales.create"]),
        connectToDatabase: async () => {},
        findProduct: async () => mockDbProducts[0],
    });
    const unauthCostBody = await unauthCostRes.json();
    check("R5. Unauthorized includeCost=true rejected with HTTP 403",
        unauthCostRes.status === 403 &&
        unauthCostBody.success === false &&
        unauthCostBody.message === "You do not have permission to view product purchase costs"
    );

    // R6. Authorized includeCost=true (user with products.update) -> 200 with purchasePrice
    const authCostReq = new NextRequest(`http://localhost:3000/api/products/${validId}?includeCost=true`);
    const authCostRes = await getSingleProductRoute(authCostReq, makeCtx(validId), {
        getAuthContext: async () => baseAuth,
        checkPermission: async () => true,
        fetchGrantedPermissions: async () => new Set(["products.read", "products.update"]),
        connectToDatabase: async () => {},
        findProduct: async () => ({ ...mockDbProducts[0] }),
    });
    const authCostBody = await authCostRes.json();
    check("R6. Authorized includeCost=true returns HTTP 200 with purchasePrice and without __v",
        authCostRes.status === 200 &&
        authCostBody.success === true &&
        authCostBody.product.purchasePrice === 65.50 &&
        !("__v" in authCostBody.product) &&
        authCostBody.product.name === "Colgate Total 120g"
    );

    // R7. Ordinary GET without includeCost=true -> 200 without purchasePrice
    const ordinaryReq = new NextRequest(`http://localhost:3000/api/products/${validId}`);
    const ordinaryRes = await getSingleProductRoute(ordinaryReq, makeCtx(validId), {
        getAuthContext: async () => baseAuth,
        checkPermission: async () => true,
        connectToDatabase: async () => {},
        findProduct: async () => ({ ...mockDbProducts[0] }),
    });
    const ordinaryBody = await ordinaryRes.json();
    check("R7. Ordinary GET returns HTTP 200 with purchasePrice stripped and public fields intact",
        ordinaryRes.status === 200 &&
        ordinaryBody.success === true &&
        !("purchasePrice" in ordinaryBody.product) &&
        !("__v" in ordinaryBody.product) &&
        ordinaryBody.product.sellingPrice === 120.00 &&
        ordinaryBody.product.SKU === "COLG-120" &&
        ordinaryBody.product.stockQuantity === 45
    );

    // R8. All 4 cost permissions grant access via route
    for (const perm of PRODUCT_COST_PERMISSIONS) {
        const req = new NextRequest(`http://localhost:3000/api/products/${validId}?includeCost=true`);
        const res = await getSingleProductRoute(req, makeCtx(validId), {
            getAuthContext: async () => baseAuth,
            checkPermission: async () => true,
            fetchGrantedPermissions: async () => new Set(["products.read", perm]),
            connectToDatabase: async () => {},
            findProduct: async () => ({ ...mockDbProducts[0] }),
        });
        const body = await res.json();
        check(`R8.${perm}. Route grants cost access for permission ${perm}`,
            res.status === 200 && body.product?.purchasePrice === 65.50
        );
    }

    // R9. Unrelated permissions are all denied cost access via route
    const nonCostPerms = ["taxes.read", "customers.read", "suppliers.read", "reports.read", "sales.create"];
    for (const perm of nonCostPerms) {
        const req = new NextRequest(`http://localhost:3000/api/products/${validId}?includeCost=true`);
        const res = await getSingleProductRoute(req, makeCtx(validId), {
            getAuthContext: async () => baseAuth,
            checkPermission: async () => true,
            fetchGrantedPermissions: async () => new Set(["products.read", perm]),
            connectToDatabase: async () => {},
            findProduct: async () => ({ ...mockDbProducts[0] }),
        });
        const body = await res.json();
        check(`R9.${perm}. Route denies cost access for unrelated permission ${perm}`,
            res.status === 403 && body.message === "You do not have permission to view product purchase costs"
        );
    }

    // ------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }

    process.exitCode = failed.length === 0 ? 0 : 1;
}

void main();

