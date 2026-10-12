
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { connectDB } from "@/lib/db/mongodb";
import { Product } from "@/lib/models/Product";
import { Category } from "@/lib/models/Category";
import { Unit } from "@/lib/models/Unit";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";
import { AuditLogService } from "@/lib/services/AuditLogService";

const createProductSchema = z
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
        status: z.enum(["active", "inactive"]).optional(),
    })
    .strict();

// GET: List products belonging to the authenticated tenant.
export async function GET(request: NextRequest) {
    try {
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

        await connectDB();

        const products = await Product.find({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        })
            .sort({ createdAt: -1 })
            .lean();

        return NextResponse.json({
            success: true,
            count: products.length,
            products,
        });
    } catch (error) {
        console.error("List products error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to list products",
            },
            { status: 500 }
        );
    }
}

// POST: Create a product and its audit log atomically.
export async function POST(request: NextRequest) {
    try {
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

        const allowed = await hasPermission({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permission: "products.create",
        });

        if (!allowed) {
            return NextResponse.json(
                {
                    success: false,
                    message: "You do not have permission to create products",
                },
                { status: 403 }
            );
        }

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

        const parsed = createProductSchema.safeParse(body);

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

        // Confirm the category and unit belong to this tenant.
        await connectDB();

        const [category, unit] = await Promise.all([
            Category.findOne({
                _id: new mongoose.Types.ObjectId(data.categoryId),
                tenantId,
                status: "active",
            })
                .select("_id")
                .lean(),

            Unit.findOne({
                _id: new mongoose.Types.ObjectId(data.unitId),
                tenantId,
                status: "active",
            })
                .select("_id")
                .lean(),
        ]);

        if (!category) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Active category not found for this business",
                },
                { status: 400 }
            );
        }

        if (!unit) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Active unit not found for this business",
                },
                { status: 400 }
            );
        }

        // Normalize the SKU and check for existing duplicates.
        const sku = data.SKU.toUpperCase();

        const duplicateConditions: Record<string, unknown>[] = [
            { tenantId, SKU: sku },
        ];

        if (data.barcode) {
            duplicateConditions.push({
                tenantId,
                barcode: data.barcode,
            });
        }

        const duplicate = await Product.findOne({
            $or: duplicateConditions,
        })
            .select("_id SKU barcode")
            .lean();

        if (duplicate) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "A product with this SKU or barcode already exists",
                },
                { status: 409 }
            );
        }

        // Product creation and audit logging share one transaction.
        const session = await mongoose.startSession();

        try {
            const createdProduct = await session.withTransaction(async () => {
                const [product] = await Product.create(
                    [
                        {
                            tenantId,
                            name: data.name,
                            SKU: sku,
                            ...(data.barcode
                                ? { barcode: data.barcode }
                                : {}),
                            categoryId: new mongoose.Types.ObjectId(
                                data.categoryId
                            ),
                            unitId: new mongoose.Types.ObjectId(data.unitId),
                            purchasePrice: data.purchasePrice,
                            sellingPrice: data.sellingPrice,
                            stockQuantity: 0,
                            status: data.status ?? "active",
                        },
                    ],
                    { session }
                );

                await AuditLogService.createAuditLog(
                    {
                        userId: new mongoose.Types.ObjectId(auth.userId),
                        tenantId,
                    },
                    {
                        action: "CREATE",
                        entity: "Product",
                        entityId: product._id,
                        description: `Product ${product.name} created`,
                        newValues: {
                            name: product.name,
                            SKU: product.SKU,
                            barcode: product.barcode,
                            categoryId: product.categoryId,
                            unitId: product.unitId,
                            purchasePrice: product.purchasePrice,
                            sellingPrice: product.sellingPrice,
                            stockQuantity: product.stockQuantity,
                            status: product.status,
                        },
                    },
                    session
                );

                return product.toObject();
            });

            if (!createdProduct) {
                throw new Error(
                    "Product creation transaction did not complete"
                );
            }

            return NextResponse.json(
                {
                    success: true,
                    message: "Product created successfully",
                    product: createdProduct,
                },
                { status: 201 }
            );
        } finally {
            await session.endSession();
        }
    } catch (error) {
        // MongoDB unique indexes also protect against concurrent requests.
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === 11000
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "A product with this SKU or barcode already exists",
                },
                { status: 409 }
            );
        }

        console.error("Create product error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to create product",
                error:
                    process.env.NODE_ENV === "development"
                        ? error instanceof Error
                            ? error.message
                            : String(error)
                        : undefined,
            },
            { status: 500 }
        );
    }
}