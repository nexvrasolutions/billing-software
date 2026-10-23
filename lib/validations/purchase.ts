import { z } from "zod";

/* ============================================================
   IDENTIFIER & STRING HELPERS
   ============================================================ */

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const TEMPORARY_SUPPLIER_ID_REGEX = /^sup_[a-zA-Z0-9_-]+$/i;

/**
 * Validates whether a string is a 24-character hexadecimal MongoDB ObjectId.
 */
export function isValidMongoObjectId(id: unknown): boolean {
    return typeof id === "string" && OBJECT_ID_REGEX.test(id.trim());
}

/**
 * Validates whether a string is an offline temporary supplier ID (e.g. "sup_...").
 */
export function isTemporarySupplierId(id: unknown): boolean {
    return typeof id === "string" && TEMPORARY_SUPPLIER_ID_REGEX.test(id.trim());
}

/**
 * Validates whether a string is a valid supplier identifier (server ObjectId or temporary offline ID).
 */
export function isValidSupplierId(id: unknown): boolean {
    return isValidMongoObjectId(id) || isTemporarySupplierId(id);
}

const TEMPORARY_PRODUCT_ID_REGEX = /^prod_[a-zA-Z0-9_-]+$/i;

/**
 * Validates whether a string is an offline temporary product ID (e.g. "prod_...").
 */
export function isTemporaryProductId(id: unknown): boolean {
    return typeof id === "string" && TEMPORARY_PRODUCT_ID_REGEX.test(id.trim());
}

/**
 * Validates whether a string is a valid product identifier for offline operations
 * (server ObjectId or temporary offline ID starting with "prod_").
 */
export function isValidOfflineProductId(id: unknown): boolean {
    return isValidMongoObjectId(id) || isTemporaryProductId(id);
}

/**
 * Optional string field helper:
 * - undefined, null, or empty/whitespace string -> undefined (omitted)
 * - non-empty string -> trimmed, validated with max length
 */
export const optionalTrimmedString = (maxLen: number, errorMsg?: string) =>
    z
        .union([z.string(), z.null()])
        .optional()
        .transform((val) => {
            if (val === undefined || val === null) return undefined;
            const trimmed = val.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        })
        .pipe(
            z.union([
                z.string().max(maxLen, errorMsg || `Cannot exceed ${maxLen} characters`),
                z.undefined(),
            ])
        );

/**
 * Optional Date parser:
 * Accepts Date objects or valid date/ISO strings, returning Date or undefined.
 * Rejects invalid date strings, NaN dates, non-date primitives.
 */
export const optionalDateInputSchema = z
    .union([z.date(), z.string(), z.null()])
    .optional()
    .refine(
        (v) => {
            if (v === undefined || v === null) return true;
            if (typeof v === "string" && !v.trim()) return true;
            return v instanceof Date
                ? Number.isFinite(v.getTime())
                : Number.isFinite(new Date(v).getTime());
        },
        "Invalid date format"
    )
    .transform((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === "string" && !v.trim()) return undefined;
        return v instanceof Date ? v : new Date(v);
    });

/**
 * Safely parses a finite number from a number or numeric string.
 * Rejects NaN, Infinity, -Infinity, empty/whitespace strings, and non-numeric strings.
 */
export function parseFiniteNumber(val: unknown): number | null {
    if (typeof val === "number") {
        return Number.isFinite(val) ? val : null;
    }
    if (typeof val === "string") {
        const trimmed = val.trim();
        if (!trimmed) return null;
        if (
            trimmed === "Infinity" ||
            trimmed === "+Infinity" ||
            trimmed === "-Infinity" ||
            trimmed === "NaN"
        ) {
            return null;
        }
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
            return null;
        }
        const num = Number(trimmed);
        return Number.isFinite(num) ? num : null;
    }
    return null;
}

/* ============================================================
   SUB-SCHEMAS: WAREHOUSE, PRODUCT SNAPSHOT, ITEM
   ============================================================ */

export const warehouseSchema = z
    .object({
        name: z
            .string()
            .trim()
            .min(1, "Warehouse name is required")
            .max(100, "Warehouse name cannot exceed 100 characters"),
        location: optionalTrimmedString(200, "Warehouse location cannot exceed 200 characters"),
    })
    .strict();

export type WarehouseValidationInput = z.infer<typeof warehouseSchema>;

export const productSnapshotSchema = z
    .object({
        name: z.string().trim().max(200).optional(),
        SKU: z.string().trim().max(100).optional(),
        unit: z.string().trim().max(50).optional(),
    })
    .passthrough();

const basePurchaseItemShape = {
    quantity: z
        .number()
        .finite("Quantity must be a finite number")
        .gt(0, "Quantity must be greater than zero")
        .max(1_000_000, "Quantity exceeds maximum allowable limit"),
    unitPrice: z
        .number()
        .finite("Unit price must be a finite number")
        .min(0, "Unit price cannot be negative")
        .max(100_000_000, "Unit price exceeds maximum allowable limit"),
    discountRate: z
        .number()
        .finite("Discount rate must be a finite number")
        .min(0, "Discount rate cannot be negative")
        .max(100, "Discount rate cannot exceed 100%")
        .optional()
        .default(0),
    taxRate: z
        .number()
        .finite("Tax rate must be a finite number")
        .min(0, "Tax rate cannot be negative")
        .max(100, "Tax rate cannot exceed 100%")
        .optional()
        .default(0),
    // Preserved for offline queueing and local display compatibility
    productSnapshot: productSnapshotSchema.optional(),
};

/**
 * Strict server-facing / online purchase item schema.
 * Strictly requires a 24-character hexadecimal MongoDB ObjectId for productId.
 */
export const purchaseItemSchema = z
    .object({
        productId: z
            .string()
            .trim()
            .refine(
                (val) => isValidMongoObjectId(val),
                "Invalid product ID (must be a 24-character hexadecimal ObjectId)"
            ),
        ...basePurchaseItemShape,
    })
    .strict();

export type PurchaseItemValidationInput = z.infer<typeof purchaseItemSchema>;

/**
 * Dedicated offline purchase item schema.
 * Permits either a valid 24-character hexadecimal MongoDB ObjectId or an
 * explicitly supported temporary product ID starting with "prod_".
 */
export const offlinePurchaseItemSchema = z
    .object({
        productId: z
            .string()
            .trim()
            .refine(
                (val) => isValidOfflineProductId(val),
                "Invalid product ID (must be a 24-character hexadecimal ObjectId or offline temporary ID starting with 'prod_')"
            ),
        ...basePurchaseItemShape,
    })
    .strict();

export type OfflinePurchaseItemValidationInput = z.infer<typeof offlinePurchaseItemSchema>;

export const supplierSnapshotSchema = z
    .object({
        name: z.string().trim().max(200).optional(),
        supplierCode: z.string().trim().max(50).optional(),
        phone: z.string().trim().max(30).optional(),
        gstin: z.string().trim().max(30).optional(),
    })
    .passthrough();

/* ============================================================
   FINANCIAL CALCULATION HELPER
   ============================================================ */

export interface CalculatedPurchaseTotals {
    subtotal: number;
    discountTotal: number;
    taxTotal: number;
    shippingCost: number;
    grandTotal: number;
}

/**
 * Pure, authoritative financial calculator for purchase orders.
 * Matches PurchaseService.createPurchase computation rules exactly.
 */
export function calculatePurchaseTotals(
    items: Array<{
        quantity: number;
        unitPrice: number;
        discountRate?: number;
        taxRate?: number;
    }>,
    shippingCost: number = 0
): CalculatedPurchaseTotals {
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;

    for (const item of items) {
        const discountRate = item.discountRate ?? 0;
        const taxRate = item.taxRate ?? 0;
        const grossAmount = item.quantity * item.unitPrice;
        const discountAmount = (grossAmount * discountRate) / 100;
        const taxableAmount = grossAmount - discountAmount;
        const taxAmount = (taxableAmount * taxRate) / 100;

        subtotal += grossAmount;
        discountTotal += discountAmount;
        taxTotal += taxAmount;
    }

    const cleanShipping = Number.isFinite(shippingCost) && shippingCost > 0 ? shippingCost : 0;
    const grandTotal = subtotal - discountTotal + taxTotal + cleanShipping;

    return {
        subtotal,
        discountTotal,
        taxTotal,
        shippingCost: cleanShipping,
        grandTotal,
    };
}

/* ============================================================
   MAIN PURCHASE CREATION SCHEMAS
   ============================================================ */

const basePurchaseShape = {
    // Idempotency operation identifier
    operationId: z
        .string()
        .trim()
        .min(1, "operationId cannot be empty if provided")
        .max(200, "operationId cannot exceed 200 characters")
        .optional(),

    // Unique purchase number (e.g. PO-2026-0001)
    purchaseNo: z
        .string()
        .trim()
        .min(1, "Purchase number is required")
        .max(100, "Purchase number cannot exceed 100 characters")
        .transform((val) => val.toUpperCase()),

    purchaseDate: optionalDateInputSchema,

    supplierInvoiceNo: optionalTrimmedString(100, "Supplier invoice number cannot exceed 100 characters"),

    supplierInvoiceDate: optionalDateInputSchema,

    dueDate: optionalDateInputSchema,

    warehouse: warehouseSchema,

    items: z
        .array(purchaseItemSchema)
        .min(1, "At least one purchase item is required")
        .max(500, "Cannot exceed 500 items per purchase order"),

    shippingCost: z
        .number()
        .finite("Shipping cost must be a finite number")
        .min(0, "Shipping cost cannot be negative")
        .max(10_000_000, "Shipping cost exceeds reasonable limit")
        .optional()
        .default(0),

    paidAmount: z
        .number()
        .finite("Paid amount must be a finite number")
        .min(0, "Paid amount cannot be negative")
        .max(100_000_000, "Paid amount exceeds reasonable limit")
        .optional()
        .default(0),

    paymentStatus: z.enum(["unpaid", "partial", "paid"]).optional(),

    notes: optionalTrimmedString(1000, "Notes cannot exceed 1000 characters"),

    // Offline metadata compatibility fields
    localId: optionalTrimmedString(100),
    supplierCode: optionalTrimmedString(50),
    supplierSnapshot: supplierSnapshotSchema.optional(),

    // Optional advisory total fields if passed by client; server re-calculates authoritatively
    subtotal: z.number().finite().min(0).optional(),
    discountTotal: z.number().finite().min(0).optional(),
    taxTotal: z.number().finite().min(0).optional(),
    grandTotal: z.number().finite().min(0).optional(),
};

function refinePaidAmountNotExceedingGrandTotal(data: {
    paidAmount?: number;
    items: Array<{ quantity: number; unitPrice: number; discountRate?: number; taxRate?: number }>;
    shippingCost?: number;
}): boolean {
    if (data.paidAmount !== undefined && data.paidAmount > 0 && Array.isArray(data.items) && data.items.length > 0) {
        const totals = calculatePurchaseTotals(data.items, data.shippingCost);
        return data.paidAmount <= totals.grandTotal;
    }
    return true;
}

/**
 * Server-facing Purchase Creation Schema (POST /api/purchases):
 * Strictly validates that supplierId is an existing server-side 24-hex MongoDB ObjectId.
 * Matches PurchaseService.createPurchase expectations.
 */
export const createPurchaseSchema = z
    .object({
        ...basePurchaseShape,
        supplierId: z
            .string()
            .trim()
            .refine(
                (val) => isValidMongoObjectId(val),
                "Invalid supplier ID (must be a 24-character hexadecimal ObjectId)"
            ),
    })
    .strict()
    .refine(
        refinePaidAmountNotExceedingGrandTotal,
        {
            message: "Paid amount cannot exceed grand total",
            path: ["paidAmount"],
        }
    );

export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;

/**
 * Offline Sync Payload Schema:
 * Used for client-side queueing in Dexie db.syncQueue where a purchase may reference
 * a pending local temporary supplier ID ("sup_...") and/or temporary product IDs ("prod_...").
 *
 * NOTE: The client's SyncManager resolves temporary supplier and product IDs to real server ObjectIds
 * before the purchase operation is uploaded to the server.
 * The server-facing API (POST /api/purchases) strictly uses createPurchaseSchema.
 */
export const offlinePurchasePayloadSchema = z
    .object({
        ...basePurchaseShape,
        supplierId: z
            .string()
            .trim()
            .refine(
                (val) => isValidSupplierId(val),
                "Invalid supplier ID (must be a 24-character hexadecimal ObjectId or offline temporary ID starting with 'sup_')"
            ),
        items: z
            .array(offlinePurchaseItemSchema)
            .min(1, "At least one purchase item is required")
            .max(500, "Cannot exceed 500 items per purchase order"),
    })
    .strict()
    .refine(
        refinePaidAmountNotExceedingGrandTotal,
        {
            message: "Paid amount cannot exceed grand total",
            path: ["paidAmount"],
        }
    );

export type OfflinePurchasePayloadInput = z.infer<typeof offlinePurchasePayloadSchema>;
