
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { Product } from "@/lib/models/Product";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";

type RouteContext = {
    params: Promise<{ id: string }>;
};

const updateProductSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    SKU: z.string().trim().min(1).max(100).optional(),
    barcode: z.string().trim().max(100).optional(),
    purchasePrice: z.number().finite().min(0).optional(),
    sellingPrice: z.number().finite().min(0).optional(),
    status: z.enum(["active", "inactive"]).optional(),
}).strict().refine(
    (data) => Object.keys(data).length > 0,
    "Provide at least one field to update"
);

// GET PRODUCT
export async function GET(
    request: NextRequest,
    context: RouteContext
) {
    try {
        // 1. Verify authentication and obtain the tenant context.
        const auth = await getAuthenticatedContext(request);

        if (!auth) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Authentication required",
                },
                { status: 401 }
            );
        }

        // 2. Check product-read permission.
        const canReadProducts = await hasPermission({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permission: "products.read",
        });

        if (!canReadProducts) {
            return NextResponse.json(
                {
                    success: false,
                    message: "You do not have permission to read products",
                },
                { status: 403 }
            );
        }

        // 3. Validate the product ID.
        const { id } = await context.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid product ID",
                },
                { status: 400 }
            );
        }

        // 4. Find the product within the authenticated tenant only.
        const product = await Product.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        }).lean();

        if (!product) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Product not found",
                },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            product,
        });
    } catch (error) {
        console.error("Get product error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to get product",
            },
            { status: 500 }
        );
    }
}

// UPDATE PRODUCT
export async function PUT(
    request: NextRequest,
    context: RouteContext
) {
    try {
        // 1. Verify authentication.
        const auth = await getAuthenticatedContext(request);

        if (!auth) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Authentication required",
                },
                { status: 401 }
            );
        }

        // 2. Check product-update permission.
        const allowed = await hasPermission({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permission: "products.update",
        });

        if (!allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message: "You do not have permission to update products",
                },
                { status: 403 }
            );
        }

        // 3. Validate the product ID.
        const { id } = await context.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid product ID",
                },
                { status: 400 }
            );
        }

        // 4. Parse the request body safely.
        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid JSON request body",
                },
                { status: 400 }
            );
        }

        // 5. Validate allowed fields.
        const parsed = updateProductSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid product data",
                    errors: parsed.error.issues.map((issue) => ({
                        field: issue.path.join("."),
                        message: issue.message,
                    })),
                },
                { status: 400 }
            );
        }

        const data = parsed.data;
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);

        // 6. Find the product within this tenant only.
        const product = await Product.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId,
        });

        if (!product) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Product not found",
                },
                { status: 404 }
            );
        }

        const oldValues = {
            name: product.name,
            SKU: product.SKU,
            barcode: product.barcode,
            purchasePrice: product.purchasePrice,
            sellingPrice: product.sellingPrice,
            stockQuantity: product.stockQuantity,
            status: product.status,
        };

        const newSKU = data.SKU?.toUpperCase();

        // 7. Check SKU and barcode conflicts within this tenant.
        const duplicateConditions: Record<string, unknown>[] = [];

        if (newSKU !== undefined && newSKU !== product.SKU) {
            duplicateConditions.push({ SKU: newSKU });
        }

        if (
            data.barcode !== undefined &&
            data.barcode !== product.barcode &&
            data.barcode !== ""
        ) {
            duplicateConditions.push({ barcode: data.barcode });
        }

        if (duplicateConditions.length > 0) {
            const duplicate = await Product.findOne({
                tenantId,
                _id: { $ne: product._id },
                $or: duplicateConditions,
            }).select("_id").lean();

            if (duplicate) {
                return NextResponse.json(
                    {
                        success: false,
                        message: "Another product already uses this SKU or barcode",
                    },
                    { status: 409 }
                );
            }
        }

        // 8. Apply only the validated changes.
        if (data.name !== undefined) {
            product.name = data.name;
        }

        if (newSKU !== undefined) {
            product.SKU = newSKU;
        }

        if (data.barcode !== undefined) {
            if (data.barcode === "") {
                product.barcode = undefined;
            } else {
                product.barcode = data.barcode;
            }
        }

        if (data.purchasePrice !== undefined) {
            product.purchasePrice = data.purchasePrice;
        }

        if (data.sellingPrice !== undefined) {
            product.sellingPrice = data.sellingPrice;
        }

        if (data.status !== undefined) {
            product.status = data.status;
        }

        await product.save();

        const newValues = {
            name: product.name,
            SKU: product.SKU,
            barcode: product.barcode,
            purchasePrice: product.purchasePrice,
            sellingPrice: product.sellingPrice,
            stockQuantity: product.stockQuantity,
            status: product.status,
        };

        // 9. Determine the audit action.
        let action = "UPDATE";

        if (
            oldValues.status === "active" &&
            newValues.status === "inactive"
        ) {
            action = "DEACTIVATE";
        } else if (
            oldValues.status === "inactive" &&
            newValues.status === "active"
        ) {
            action = "ACTIVATE";
        }

        // 10. Record the change.
        const auditLog = await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
            },
            {
                action,
                entity: "Product",
                entityId: product._id,
                description: `Product ${product.name} ${action.toLowerCase()}`,
                oldValues,
                newValues,
            }
        );

        return NextResponse.json({
            success: true,
            message: "Product updated successfully",
            product,
            auditLog,
        });
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === 11000
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Another product already uses this SKU or barcode",
                },
                { status: 409 }
            );
        }

        console.error("Update product error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to update product",
            },
            { status: 500 }
        );
    }
}

// DEACTIVATE PRODUCT (SOFT DELETE)
export async function DELETE(
    request: NextRequest,
    context: RouteContext
) {
    try {
        // 1. Verify authentication.
        const auth = await getAuthenticatedContext(request);

        if (!auth) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Authentication required",
                },
                { status: 401 }
            );
        }

        // 2. Check the dedicated deletion permission.
        const allowed = await hasPermission({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permission: "products.delete",
        });

        if (!allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message: "You do not have permission to deactivate products",
                },
                { status: 403 }
            );
        }

        // 3. Validate the product ID.
        const { id } = await context.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid product ID",
                },
                { status: 400 }
            );
        }

        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);

        // 4. Find the product within this tenant only.
        const product = await Product.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId,
        });

        if (!product) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Product not found",
                },
                { status: 404 }
            );
        }

        // 5. Avoid duplicate audit entries for an inactive product.
        if (product.status === "inactive") {
            return NextResponse.json({
                success: true,
                message: "Product is already inactive",
                product,
            });
        }

        const oldValues = {
            name: product.name,
            SKU: product.SKU,
            status: product.status,
        };

        // 6. Soft delete: preserve the database record.
        product.status = "inactive";
        await product.save();

        // 7. Record the change in the audit log.
        const auditLog = await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
            },
            {
                action: "DEACTIVATE",
                entity: "Product",
                entityId: product._id,
                description: `Product ${product.name} deactivated`,
                oldValues,
                newValues: {
                    name: product.name,
                    SKU: product.SKU,
                    status: product.status,
                },
            }
        );

        return NextResponse.json({
            success: true,
            message: "Product deactivated successfully",
            product,
            auditLog,
        });
    } catch (error) {
        console.error("Deactivate product error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to deactivate product",
            },
            { status: 500 }
        );
    }
}