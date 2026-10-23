import { z } from "zod";

// Helper to normalize strings: trims and converts empty strings to undefined
const optionalTrimmedString = (maxLen: number) =>
    z
        .string()
        .trim()
        .max(maxLen)
        .optional()
        .transform((val) => (val && val.length > 0 ? val : undefined));

/**
 * Optional string field for customer creation:
 * - undefined, null, or empty string -> undefined (omitted)
 * - non-empty string -> trimmed, validated with max length
 */
const createOptionalString = (maxLen: number, errorMsg?: string) =>
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
 * Optional email field for customer creation:
 * - undefined, null, or empty string -> undefined (omitted)
 * - non-empty string -> trimmed, lowercased, max 200 chars, valid email format
 */
const createOptionalEmail = z
    .union([z.string(), z.null()])
    .optional()
    .transform((val) => {
        if (val === undefined || val === null) return undefined;
        const trimmed = val.trim().toLowerCase();
        return trimmed.length > 0 ? trimmed : undefined;
    })
    .pipe(
        z.union([
            z
                .string()
                .max(200, "Email cannot exceed 200 characters")
                .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email format"),
            z.undefined(),
        ])
    );

/**
 * Clearable optional string field for customer update:
 * - undefined (omitted) -> undefined (preserve existing stored value)
 * - null, empty string, or whitespace-only -> null (explicitly clear field in database)
 * - non-empty string -> trimmed, validated with max length
 */
export const clearableOptionalString = (maxLen: number, errorMsg?: string) =>
    z
        .union([z.string(), z.null()])
        .optional()
        .transform((val) => {
            if (val === undefined) return undefined;
            if (val === null) return null;
            const trimmed = val.trim();
            return trimmed.length > 0 ? trimmed : null;
        })
        .pipe(
            z.union([
                z.string().max(maxLen, errorMsg || `Cannot exceed ${maxLen} characters`),
                z.null(),
                z.undefined(),
            ])
        );

/**
 * Clearable optional email field for customer update:
 * - undefined (omitted) -> undefined (preserve existing stored value)
 * - null, empty string, or whitespace-only -> null (explicitly clear field in database)
 * - non-empty string -> trimmed, lowercased, max 200 chars, valid email format
 */
export const clearableOptionalEmail = z
    .union([z.string(), z.null()])
    .optional()
    .transform((val) => {
        if (val === undefined) return undefined;
        if (val === null) return null;
        const trimmed = val.trim().toLowerCase();
        return trimmed.length > 0 ? trimmed : null;
    })
    .pipe(
        z.union([
            z
                .string()
                .max(200, "Email cannot exceed 200 characters")
                .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email format"),
            z.null(),
            z.undefined(),
        ])
    );

export const CUSTOMER_WRITE_PERMISSIONS = [
    "sales.create",
    "users.read",
];

export const CUSTOMER_READ_PERMISSIONS = [
    "sales.create",
    "sales.read",
    "users.read",
    "customers.read",
];

export const createCustomerSchema = z
    .object({
        name: z
            .string({ message: "Name is required" })
            .trim()
            .min(1, "Name is required")
            .max(200, "Customer name cannot exceed 200 characters"),
        phone: createOptionalString(30, "Phone number cannot exceed 30 characters"),
        email: createOptionalEmail,
        address: createOptionalString(500, "Address cannot exceed 500 characters"),
        status: z
            .enum(["active", "inactive"], {
                message: "Status must be either active or inactive",
            })
            .optional()
            .default("active"),
        operationId: optionalTrimmedString(100),
    })
    .strict();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
    .object({
        name: z
            .string({ message: "Customer name cannot be empty" })
            .trim()
            .min(1, "Customer name cannot be empty")
            .max(200, "Customer name cannot exceed 200 characters")
            .optional(),
        phone: clearableOptionalString(30, "Phone number cannot exceed 30 characters"),
        email: clearableOptionalEmail,
        address: clearableOptionalString(500, "Address cannot exceed 500 characters"),
    })
    .strict()
    .refine(
        (data) => Object.values(data).some((val) => val !== undefined),
        { message: "Provide at least one field to update" }
    );

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerLifecycleSchema = z
    .object({
        action: z.enum(["deactivate", "reactivate"], {
            message: "Action must be one of: deactivate, reactivate",
        }),
        reason: optionalTrimmedString(500),
    })
    .strict();

export type CustomerLifecycleInput = z.infer<typeof customerLifecycleSchema>;

export type CustomerLifecycleAction = CustomerLifecycleInput["action"];

/**
 * Validates whether a requested lifecycle action is permissible given the customer's current status.
 * Customer status domain: "active" | "inactive" (no "blocked" state exists in customer model).
 */
export function isValidCustomerTransition(
    currentStatus: "active" | "inactive",
    action: CustomerLifecycleAction
): { valid: boolean; newStatus?: "active" | "inactive"; error?: string } {
    switch (action) {
        case "deactivate":
            if (currentStatus !== "active") {
                return {
                    valid: false,
                    error: `Cannot deactivate a customer that is currently ${currentStatus}. Only active customers can be deactivated.`,
                };
            }
            return { valid: true, newStatus: "inactive" };
        case "reactivate":
            if (currentStatus !== "inactive") {
                return {
                    valid: false,
                    error: `Cannot reactivate a customer that is currently ${currentStatus}. Only inactive customers can be reactivated.`,
                };
            }
            return { valid: true, newStatus: "active" };
        default:
            return { valid: false, error: `Unsupported lifecycle action: ${action}` };
    }
}
