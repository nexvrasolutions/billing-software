import { z } from "zod";

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

/**
 * Validates whether a value is a 24-character hexadecimal MongoDB ObjectId string.
 * Browser-safe and does not depend on Mongoose or Node.js modules.
 */
export function isValidObjectId(value: unknown): boolean {
    return typeof value === "string" && OBJECT_ID_REGEX.test(value.trim());
}

export const createProductSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        SKU: z.string().trim().min(1).max(100),
        barcode: z.string().trim().max(100).optional(),
        categoryId: z.string().refine(
            (value) => isValidObjectId(value),
            "Invalid category ID"
        ),
        unitId: z.string().refine(
            (value) => isValidObjectId(value),
            "Invalid unit ID"
        ),
        purchasePrice: z.number().finite().min(0),
        sellingPrice: z.number().finite().min(0),
        taxRate: z.number().finite().min(0).max(100).optional().nullable(),
        hsnCode: z.string().trim().max(20).optional().nullable(),
        openingStock: z.number().finite().min(0).optional(),
        operationId: z.string().trim().min(1).max(200).optional(),
        status: z.enum(["active", "inactive"]).optional(),
    })
    .strict();

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        SKU: z.string().trim().min(1).max(100).optional(),
        barcode: z.string().trim().max(100).optional(),
        purchasePrice: z.number().finite().min(0).optional(),
        sellingPrice: z.number().finite().min(0).optional(),
        taxRate: z.number().finite().min(0).max(100).optional().nullable(),
        hsnCode: z.string().trim().max(20).optional().nullable(),
        status: z.enum(["active", "inactive"]).optional(),
    })
    .strict()
    .refine(
        (data) => Object.keys(data).length > 0,
        "Provide at least one field to update"
    );

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/**
 * Safely parse a finite number from a number or numeric string.
 * Rejects NaN, Infinity, -Infinity, empty/whitespace strings, and non-numeric strings.
 * Preserves 0 and other finite numbers.
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

