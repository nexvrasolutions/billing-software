import mongoose from "mongoose";
import { z } from "zod";

export const createProductSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        SKU: z.string().trim().min(1).max(100),
        barcode: z.string().trim().max(100).optional(),
        categoryId: z.string().refine(
            (value) => mongoose.Types.ObjectId.isValid(value),
            "Invalid category ID"
        ),
        unitId: z.string().refine(
            (value) => mongoose.Types.ObjectId.isValid(value),
            "Invalid unit ID"
        ),
        purchasePrice: z.number().finite().min(0),
        sellingPrice: z.number().finite().min(0),
        taxRate: z.number().finite().min(0).max(100).optional().nullable(),
        hsnCode: z.string().trim().max(20).optional().nullable(),
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
