import { z } from "zod";
import { GSTIN_PATTERN } from "@/lib/tax";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const SUPPLIER_WRITE_PERMISSIONS = [
    "purchases.create",
    "products.create",
    "products.update",
    "users.read",
];

export const SUPPLIER_READ_PERMISSIONS = [
    "purchases.read",
    "purchases.create",
    "products.create",
    "products.update",
    "users.read",
];

// Helper to normalize strings: trims and converts empty strings to undefined
const optionalTrimmedString = (maxLen: number) =>
    z
        .string()
        .trim()
        .max(maxLen)
        .optional()
        .transform((val) => (val && val.length > 0 ? val : undefined));

export const createSupplierSchema = z
    .object({
        name: z
            .string()
            .trim()
            .min(1, "Supplier name is required")
            .max(200, "Name cannot exceed 200 characters"),
        supplierCode: z
            .string()
            .trim()
            .max(50, "Supplier code cannot exceed 50 characters")
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined)),
        contactPerson: optionalTrimmedString(200),
        phone: optionalTrimmedString(30),
        altPhone: optionalTrimmedString(30),
        email: z
            .string()
            .trim()
            .max(200)
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toLowerCase() : undefined))
            .refine((val) => !val || EMAIL_PATTERN.test(val), "Invalid email format"),
        website: optionalTrimmedString(200),
        address: optionalTrimmedString(500),
        line1: optionalTrimmedString(500),
        line2: optionalTrimmedString(500),
        city: optionalTrimmedString(100),
        state: optionalTrimmedString(100),
        pincode: optionalTrimmedString(20),
        country: optionalTrimmedString(100),
        gstin: z
            .string()
            .trim()
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined))
            .refine(
                (val) => !val || GSTIN_PATTERN.test(val),
                "Invalid GSTIN format (15 alphanumeric characters expected)"
            ),
        pan: z
            .string()
            .trim()
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined))
            .refine((val) => !val || PAN_PATTERN.test(val), "Invalid PAN format (10 characters expected)"),
        paymentType: z.enum(["cash", "credit"]).optional().default("cash"),
        creditDays: z
            .union([z.number(), z.string()])
            .optional()
            .transform((val) => {
                if (val === undefined || val === null || val === "") return 0;
                const num = Number(val);
                return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
            }),
        creditLimit: z
            .union([z.number(), z.string()])
            .optional()
            .transform((val) => {
                if (val === undefined || val === null || val === "") return 0;
                const num = Number(val);
                return Number.isFinite(num) ? Math.max(0, num) : 0;
            }),
        category: optionalTrimmedString(100),
        notes: optionalTrimmedString(1000),
        status: z.enum(["active", "inactive", "blocked"]).optional().default("active"),
    })
    .strict();

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
    .object({
        name: z.string().trim().min(1, "Name cannot be empty").max(200).optional(),
        supplierCode: z
            .string()
            .trim()
            .max(50)
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined)),
        contactPerson: optionalTrimmedString(200),
        phone: optionalTrimmedString(30),
        altPhone: optionalTrimmedString(30),
        email: z
            .string()
            .trim()
            .max(200)
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toLowerCase() : undefined))
            .refine((val) => !val || EMAIL_PATTERN.test(val), "Invalid email format"),
        website: optionalTrimmedString(200),
        address: optionalTrimmedString(500),
        line1: optionalTrimmedString(500),
        line2: optionalTrimmedString(500),
        city: optionalTrimmedString(100),
        state: optionalTrimmedString(100),
        pincode: optionalTrimmedString(20),
        country: optionalTrimmedString(100),
        gstin: z
            .string()
            .trim()
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined))
            .refine(
                (val) => !val || GSTIN_PATTERN.test(val),
                "Invalid GSTIN format (15 alphanumeric characters expected)"
            ),
        pan: z
            .string()
            .trim()
            .optional()
            .transform((val) => (val && val.length > 0 ? val.toUpperCase() : undefined))
            .refine((val) => !val || PAN_PATTERN.test(val), "Invalid PAN format (10 characters expected)"),
        paymentType: z.enum(["cash", "credit"]).optional(),
        creditDays: z
            .union([z.number(), z.string()])
            .optional()
            .transform((val) => {
                if (val === undefined || val === null || val === "") return undefined;
                const num = Number(val);
                return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
            }),
        creditLimit: z
            .union([z.number(), z.string()])
            .optional()
            .transform((val) => {
                if (val === undefined || val === null || val === "") return undefined;
                const num = Number(val);
                return Number.isFinite(num) ? Math.max(0, num) : 0;
            }),
        category: optionalTrimmedString(100),
        notes: optionalTrimmedString(1000),
    })
    .strict()
    .refine((data) => Object.keys(data).length > 0, "Provide at least one field to update");

export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const supplierLifecycleSchema = z
    .object({
        action: z.enum(["deactivate", "reactivate", "block", "unblock"], {
            message: "Action must be one of: deactivate, reactivate, block, unblock",
        }),
        reason: optionalTrimmedString(500),
    })
    .strict();

export type SupplierLifecycleInput = z.infer<typeof supplierLifecycleSchema>;

export type SupplierLifecycleAction = SupplierLifecycleInput["action"];

/**
 * Validates whether a requested lifecycle action is permissible given the supplier's current status.
 */
export function isValidSupplierTransition(
    currentStatus: "active" | "inactive" | "blocked",
    action: SupplierLifecycleAction
): { valid: boolean; newStatus?: "active" | "inactive" | "blocked"; error?: string } {
    switch (action) {
        case "deactivate":
            if (currentStatus !== "active") {
                return {
                    valid: false,
                    error: `Cannot deactivate a supplier that is currently ${currentStatus}. Only active suppliers can be deactivated.`,
                };
            }
            return { valid: true, newStatus: "inactive" };
        case "reactivate":
            if (currentStatus !== "inactive") {
                return {
                    valid: false,
                    error: `Cannot reactivate a supplier that is currently ${currentStatus}. Only inactive suppliers can be reactivated.`,
                };
            }
            return { valid: true, newStatus: "active" };
        case "block":
            if (currentStatus !== "active") {
                return {
                    valid: false,
                    error: `Cannot block a supplier that is currently ${currentStatus}. Only active suppliers can be blocked.`,
                };
            }
            return { valid: true, newStatus: "blocked" };
        case "unblock":
            if (currentStatus !== "blocked") {
                return {
                    valid: false,
                    error: `Cannot unblock a supplier that is currently ${currentStatus}. Only blocked suppliers can be unblocked.`,
                };
            }
            return { valid: true, newStatus: "active" };
        default:
            return { valid: false, error: `Unsupported lifecycle action: ${action}` };
    }
}

export interface SupplierValidationErrorItem {
    field?: string;
    message: string;
}

export interface SupplierFormErrors {
    fieldErrors: Record<string, string>;
    unmappedErrors: string[];
    generalError: string | null;
}

export const SUPPLIER_FORM_FIELD_MAP: Record<string, string> = {
    name: "name",
    contactPerson: "contactPerson",
    "contact.contactPerson": "contactPerson",
    phone: "phone",
    "contact.phone": "phone",
    altPhone: "phone",
    "contact.altPhone": "phone",
    email: "email",
    "contact.email": "email",
    gstin: "gstin",
    "tax.gstin": "gstin",
    address: "address",
    "address.line1": "address",
    line1: "address",
};

/**
 * Parses API validation error responses from PUT/POST /api/suppliers
 * and separates them into field-specific errors and unmapped general errors.
 */
export function parseSupplierValidationErrors(
    data: unknown,
    fallbackGenericMessage = "Failed to update supplier"
): SupplierFormErrors {
    const fieldErrors: Record<string, string> = {};
    const unmappedErrors: string[] = [];

    if (!data || typeof data !== "object") {
        return {
            fieldErrors: {},
            unmappedErrors: [],
            generalError: fallbackGenericMessage,
        };
    }

    const payload = data as {
        message?: unknown;
        errors?: unknown;
    };

    const hasErrorsArray = Array.isArray(payload.errors) && payload.errors.length > 0;

    if (hasErrorsArray) {
        for (const item of payload.errors as unknown[]) {
            if (item && typeof item === "object") {
                const errObj = item as Record<string, unknown>;
                const field = typeof errObj.field === "string" ? errObj.field.trim() : "";
                const message = typeof errObj.message === "string" ? errObj.message.trim() : "";

                if (!message) continue;

                const mappedFormKey = field ? SUPPLIER_FORM_FIELD_MAP[field] : undefined;

                if (mappedFormKey) {
                    if (!fieldErrors[mappedFormKey]) {
                        fieldErrors[mappedFormKey] = message;
                    }
                } else {
                    unmappedErrors.push(field ? `${field}: ${message}` : message);
                }
            } else if (typeof item === "string" && item.trim()) {
                unmappedErrors.push(item.trim());
            }
        }
    }

    let generalError: string | null = null;

    if (unmappedErrors.length > 0) {
        generalError = unmappedErrors.join("; ");
    } else if (Object.keys(fieldErrors).length === 0) {
        generalError =
            typeof payload.message === "string" && payload.message.trim()
                ? payload.message.trim()
                : fallbackGenericMessage;
    }

    return {
        fieldErrors,
        unmappedErrors,
        generalError,
    };
}

export interface SupplierBadgeInfo {
    label: string;
    variant: "archived" | "active" | "inactive" | "blocked";
    className: string;
}

/**
 * Determines the single, authoritative display badge for a supplier.
 * When a supplier is soft-deleted (isDeleted === true), ONLY the "Archived" badge is returned,
 * regardless of whether their underlying status was active, inactive, or blocked.
 */
export function getSupplierDisplayBadge(supplier: {
    status?: "active" | "inactive" | "blocked" | string;
    isDeleted?: boolean;
}): SupplierBadgeInfo {
    if (supplier.isDeleted) {
        return {
            label: "Archived",
            variant: "archived",
            className:
                "rounded-full bg-destructive/10 text-destructive border border-destructive/20 px-2 py-0.5 text-xs font-medium",
        };
    }

    switch (supplier.status) {
        case "blocked":
            return {
                label: "Blocked",
                variant: "blocked",
                className:
                    "rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 px-2 py-0.5 text-xs font-medium capitalize",
            };
        case "inactive":
            return {
                label: "Inactive",
                variant: "inactive",
                className:
                    "rounded-full bg-muted text-muted-foreground border border-border px-2 py-0.5 text-xs font-medium capitalize",
            };
        case "active":
        default:
            return {
                label: "Active",
                variant: "active",
                className:
                    "rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 px-2 py-0.5 text-xs font-medium capitalize",
            };
    }
}

