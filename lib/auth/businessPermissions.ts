
import { NextResponse } from "next/server";

import type { AuthenticatedContext } from "./getAuthenticatedContext";
import { getGrantedPermissions } from "./hasPermission";

/*
 * Permissions for business actions (sales, purchases, payments, stock,
 * ledger, taxes). They are always checked on the server, both for online
 * requests and when a queued offline operation is processed (with the
 * user's role at processing time).
 */
export const BUSINESS_PERMISSIONS = {
    productsCreate: "products.create",
    salesCreate: "sales.create",
    salesRead: "sales.read",
    // Selling at a price other than the product's selling price, or with a discount.
    salesPriceOverride: "sales.priceOverride",
    // Dating a sale earlier than the allowed window (see SALE_DATE_RULES).
    salesBackdate: "sales.backdate",
    salesReturnsCreate: "salesReturns.create",
    purchasesCreate: "purchases.create",
    purchasesRead: "purchases.read",
    purchaseReturnsCreate: "purchaseReturns.create",
    paymentsCreate: "payments.create",
    stockAdjust: "stock.adjust",
    // Manual ledger entries.
    ledgerCreate: "ledger.create",
    taxesRead: "taxes.read",
    taxesDelete: "taxes.delete",
} as const;

export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[keyof typeof BUSINESS_PERMISSIONS];

/** Permission required to process each kind of queued offline operation. */
export const SYNC_ENTITY_PERMISSIONS: Readonly<Record<string, BusinessPermission>> = Object.freeze({
    Product: BUSINESS_PERMISSIONS.productsCreate,
    Sale: BUSINESS_PERMISSIONS.salesCreate,
    SalesReturn: BUSINESS_PERMISSIONS.salesReturnsCreate,
    Purchase: BUSINESS_PERMISSIONS.purchasesCreate,
    PurchaseReturn: BUSINESS_PERMISSIONS.purchaseReturnsCreate,
    Payment: BUSINESS_PERMISSIONS.paymentsCreate,
    StockAdjustment: BUSINESS_PERMISSIONS.stockAdjust,
    Customer: BUSINESS_PERMISSIONS.salesCreate,
    Supplier: BUSINESS_PERMISSIONS.purchasesCreate,
});

/**
 * Permission for a queued operation type, or null when the type has no
 * explicit mapping. Callers must REJECT null (deny by default). Only the
 * map's own keys count, so names such as "constructor" never match.
 */
export function getSyncEntityPermission(entityType: unknown): BusinessPermission | null {
    if (typeof entityType !== "string" || !Object.hasOwn(SYNC_ENTITY_PERMISSIONS, entityType)) {
        return null;
    }
    return SYNC_ENTITY_PERMISSIONS[entityType];
}

/** Sale date rules (approved policy). */
export const SALE_DATE_RULES = {
    // A sale may never be dated further in the future than this (clock skew).
    maxFutureMs: 5 * 60 * 1000,
    // Online: older than this needs sales.backdate.
    onlineMaxAgeMs: 10 * 60 * 1000,
    // Offline sync: older than this before the server first received the
    // operation needs sales.backdate (matches the 24-hour offline window).
    syncMaxAgeMs: 24 * 60 * 60 * 1000,
} as const;

/** A business rule the user is not permitted to bypass (HTTP 403). */
export class BusinessPermissionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BusinessPermissionError";
    }
}

/** Which of the given permissions the authenticated user currently holds. */
export function getGrantedBusinessPermissions(
    context: Pick<AuthenticatedContext, "userId" | "tenantId" | "roleId">,
    permissions: BusinessPermission[]
): Promise<Set<string>> {
    return getGrantedPermissions({
        userId: context.userId,
        tenantId: context.tenantId,
        roleId: context.roleId,
        permissions,
    });
}

/**
 * For route handlers: null when the user holds the permission, otherwise
 * the 403 response to return. Call it before reading or acting on the body.
 */
export async function requireBusinessPermission(
    context: AuthenticatedContext,
    permission: BusinessPermission
): Promise<NextResponse | null> {
    const granted = await getGrantedBusinessPermissions(context, [permission]);

    if (granted.has(permission)) {
        return null;
    }

    return NextResponse.json(
        { success: false, message: "Permission denied" },
        { status: 403 }
    );
}

/**
 * For route handlers requiring any one of several business permissions.
 * Returns null when the user holds at least one of the permissions,
 * otherwise returns a standard HTTP 403 response.
 */
export async function requireAnyBusinessPermission(
    context: AuthenticatedContext,
    permissions: BusinessPermission[]
): Promise<NextResponse | null> {
    const granted = await getGrantedBusinessPermissions(context, permissions);

    for (const perm of permissions) {
        if (granted.has(perm)) {
            return null;
        }
    }

    return NextResponse.json(
        { success: false, message: "Permission denied" },
        { status: 403 }
    );
}

