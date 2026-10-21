import { z } from "zod";
import { GSTIN_PATTERN } from "@/lib/tax";
import { EMAIL_PATTERN, PAN_PATTERN } from "@/lib/validations/supplier";

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid ID");

const syncEmailSchema = z
    .string()
    .trim()
    .max(200)
    .optional()
    .refine((val) => !val || EMAIL_PATTERN.test(val), "Invalid email format");

const syncGstinSchema = z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine(
        (val) => !val || GSTIN_PATTERN.test(val.toUpperCase()),
        "Invalid GSTIN format (15 alphanumeric characters expected)"
    );

const syncPanSchema = z
    .string()
    .trim()
    .max(20)
    .optional()
    .refine(
        (val) => !val || PAN_PATTERN.test(val.toUpperCase()),
        "Invalid PAN format (10 characters expected)"
    );

const syncCreditDaysSchema = z
    .union([
        z.number().int().min(0).max(3650),
        z.string().trim().regex(/^\d+$/, "Credit days must be a non-negative integer"),
    ])
    .optional()
    .refine((val) => {
        if (val === undefined || val === null || val === "") return true;
        const num = Number(val);
        return Number.isInteger(num) && num >= 0 && num <= 3650;
    }, "Credit days must be between 0 and 3650");

const syncCreditLimitSchema = z
    .union([
        z.number().min(0),
        z.string().trim().regex(/^\d+(\.\d+)?$/, "Credit limit must be a non-negative number"),
    ])
    .optional()
    .refine((val) => {
        if (val === undefined || val === null || val === "") return true;
        const num = Number(val);
        return Number.isFinite(num) && num >= 0;
    }, "Credit limit must be a non-negative number");

export const customerUpdatePayloadSchema = z.strictObject({
    customerId: objectIdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().max(200).optional(),
    address: z.string().trim().max(500).optional(),
    status: z.enum(["active", "inactive"]).optional(),
});

export const supplierCreatePayloadSchema = z.strictObject({
    localId: z.string().trim().min(1).max(100).optional(),
    supplierCode: z.string().trim().max(50).optional(),
    name: z.string().trim().min(1, "Supplier name is required").max(200),
    contactPerson: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    altPhone: z.string().trim().max(30).optional(),
    email: syncEmailSchema,
    website: z.string().trim().max(200).optional(),
    address: z.string().trim().max(500).optional(),
    line1: z.string().trim().max(500).optional(),
    line2: z.string().trim().max(500).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    pincode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(100).optional(),
    gstin: syncGstinSchema,
    pan: syncPanSchema,
    paymentType: z.enum(["cash", "credit"]).optional(),
    creditDays: syncCreditDaysSchema,
    creditLimit: syncCreditLimitSchema,
    category: z.string().trim().max(100).optional(),
    notes: z.string().trim().max(1000).optional(),
    status: z.literal("active").optional(),
});

export const supplierUpdatePayloadSchema = z.strictObject({
    supplierId: objectIdSchema,
    name: z.string().trim().min(1, "Name cannot be empty").max(200).optional(),
    contactPerson: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    altPhone: z.string().trim().max(30).optional(),
    email: syncEmailSchema,
    website: z.string().trim().max(200).optional(),
    address: z.string().trim().max(500).optional(),
    line1: z.string().trim().max(500).optional(),
    line2: z.string().trim().max(500).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    pincode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(100).optional(),
    gstin: syncGstinSchema,
    pan: syncPanSchema,
    paymentType: z.enum(["cash", "credit"]).optional(),
    creditDays: syncCreditDaysSchema,
    creditLimit: syncCreditLimitSchema,
    category: z.string().trim().max(100).optional(),
    notes: z.string().trim().max(1000).optional(),
});

/**
 * Narrow compatibility normalizer for legacy queued Supplier UPDATE payloads.
 * Only strips the harmless, no-op `status: "active"` field.
 * Leaves all other fields untouched so strict schema validation continues to catch
 * illegal lifecycle transitions, banking details, or unexpected fields.
 */
export function normalizeSupplierUpdatePayload<T extends Record<string, unknown>>(payload: T): T {
    if (payload && typeof payload === "object" && (payload as any).status === "active") {
        const { status: _status, ...rest } = payload as any;
        return rest as T;
    }
    return payload;
}

export const standardCreateSchema = z.strictObject({
    operationId: z.string().trim().min(1).max(200),
    operationType: z.literal("CREATE"),
    entityType: z.enum(["Sale", "Purchase", "SalesReturn", "PurchaseReturn", "Payment", "StockAdjustment", "Product", "Customer"]),
    entityId: objectIdSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
    owner: z.strictObject({
        tenantId: objectIdSchema,
        userId: objectIdSchema,
        deviceId: objectIdSchema,
    }),
});

export const customerUpdateSchema = z.strictObject({
    operationId: z.string().trim().min(1).max(200),
    operationType: z.literal("UPDATE"),
    entityType: z.literal("Customer"),
    entityId: objectIdSchema.optional(),
    payload: customerUpdatePayloadSchema,
    owner: z.strictObject({
        tenantId: objectIdSchema,
        userId: objectIdSchema,
        deviceId: objectIdSchema,
    }),
});

export const supplierCreateSchema = z.strictObject({
    operationId: z.string().trim().min(1).max(200),
    operationType: z.literal("CREATE"),
    entityType: z.literal("Supplier"),
    entityId: objectIdSchema.optional(),
    payload: supplierCreatePayloadSchema,
    owner: z.strictObject({
        tenantId: objectIdSchema,
        userId: objectIdSchema,
        deviceId: objectIdSchema,
    }),
});

export const supplierUpdateSchema = z.strictObject({
    operationId: z.string().trim().min(1).max(200),
    operationType: z.literal("UPDATE"),
    entityType: z.literal("Supplier"),
    entityId: objectIdSchema.optional(),
    payload: supplierUpdatePayloadSchema,
    owner: z.strictObject({
        tenantId: objectIdSchema,
        userId: objectIdSchema,
        deviceId: objectIdSchema,
    }),
});

export const uploadSchema = z.union([
    supplierCreateSchema,
    supplierUpdateSchema,
    customerUpdateSchema,
    standardCreateSchema,
]);
