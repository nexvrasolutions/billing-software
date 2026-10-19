/*
 * Product Field Projection & Data Protection
 *
 * Implements Stage 6A Fix B: Minimize product API data exposure.
 *
 * Responsibilities:
 * 1. Restrict default product list API response to public/catalogue fields.
 * 2. Exclude purchasePrice from ordinary products.read responses.
 * 3. Enforce permission verification for cost-sensitive fields.
 * 4. Guarantee required fields are preserved for POS, offline catalogue cache,
 *    and product management views.
 */

export const PRODUCT_PUBLIC_FIELDS = [
    "_id",
    "id",
    "tenantId",
    "name",
    "SKU",
    "barcode",
    "categoryId",
    "unitId",
    "sellingPrice",
    "stockQuantity",
    "status",
    "taxRate",
    "hsnCode",
    "createdAt",
    "updatedAt",
] as const;

export const PRODUCT_COST_PERMISSIONS = [
    "products.create",
    "products.update",
    "purchases.create",
    "stock.adjust",
] as const;

export type ProductCostPermission = (typeof PRODUCT_COST_PERMISSIONS)[number];

export function hasCostPermission(grantedPermissions: Set<string> | string[]): boolean {
    const granted = grantedPermissions instanceof Set ? grantedPermissions : new Set(grantedPermissions);
    return PRODUCT_COST_PERMISSIONS.some((p) => granted.has(p));
}

/**
 * Filter product document fields based on whether cost data is authorized.
 * Excludes internal mongoose fields (__v) and purchasePrice when includeCost is false.
 */
export function filterProductFields(
    product: unknown,
    includeCost: boolean
): Record<string, unknown> {
    if (!product || typeof product !== "object") {
        return {};
    }

    const obj = product as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};

    for (const key of Object.keys(obj)) {
        if (key === "purchasePrice") {
            if (includeCost) {
                filtered[key] = obj[key];
            }
            continue;
        }

        if (key === "__v") {
            continue;
        }

        filtered[key] = obj[key];
    }

    return filtered;
}

/**
 * Filter array of products for API response.
 */
export function filterProductsList(
    products: unknown[],
    includeCost: boolean
): Record<string, unknown>[] {
    if (!Array.isArray(products)) return [];
    return products.map((p) => filterProductFields(p, includeCost));
}
