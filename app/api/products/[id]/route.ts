import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Product } from "@/lib/models/Product";
import { AuditLogService } from "@/lib/services/AuditLogService";

const TEST_TENANT_ID = "6abe48a86ae4b08a3e335303";
const TEST_USER_ID = "6abe4d3f6ae4b08a3e335463";

type RouteContext = {
    params: Promise<{ id: string }>;
};

// GET PRODUCT
export async function GET(
    request: Request,
    context: RouteContext
) {
    try {
        await connectDB();

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

        const product = await Product.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),
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
    request: Request,
    context: RouteContext
) {
    try {
        await connectDB();

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

        const body = await request.json();

        const product = await Product.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),
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

        // Capture important old values before changing the product
        const oldValues = {
            name: product.name,
            SKU: product.SKU,
            barcode: product.barcode,
            purchasePrice: product.purchasePrice,
            sellingPrice: product.sellingPrice,
            stockQuantity: product.stockQuantity,
            status: product.status,
        };

        // Update only fields supplied by the request
        if (body.name !== undefined) {
            product.name = body.name;
        }

        if (body.SKU !== undefined) {
            product.SKU = body.SKU;
        }

        if (body.barcode !== undefined) {
            product.barcode = body.barcode;
        }

        if (body.purchasePrice !== undefined) {
            product.purchasePrice = body.purchasePrice;
        }

        if (body.sellingPrice !== undefined) {
            product.sellingPrice = body.sellingPrice;
        }

        if (body.stockQuantity !== undefined) {
            product.stockQuantity = body.stockQuantity;
        }

        if (body.status !== undefined) {
            product.status = body.status;
        }

        await product.save();

        // Capture values after update
        const newValues = {
            name: product.name,
            SKU: product.SKU,
            barcode: product.barcode,
            purchasePrice: product.purchasePrice,
            sellingPrice: product.sellingPrice,
            stockQuantity: product.stockQuantity,
            status: product.status,
        };

        // Determine audit action
        let action = "UPDATE";

        if (oldValues.status === "active" && newValues.status === "inactive") {
            action = "DEACTIVATE";
        } else if (
            oldValues.status === "inactive" &&
            newValues.status === "active"
        ) {
            action = "ACTIVATE";
        }

        // Create audit log
        const auditLog = await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(TEST_USER_ID),
                tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),
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
        console.error("Update product error:", error);

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Failed to update product",
            },
            { status: 500 }
        );
    }
}