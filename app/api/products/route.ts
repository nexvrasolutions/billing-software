
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Product } from "@/lib/models/Product";
import { Category } from "@/lib/models/Category";
import { Unit } from "@/lib/models/Unit";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission, getGrantedPermissions } from "@/lib/auth/hasPermission";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { StockService } from "@/lib/services/StockService";
import {
    PRODUCT_COST_PERMISSIONS,
    hasCostPermission,
    filterProductsList,
} from "@/lib/catalog/productProjection";
import { createProductSchema } from "@/lib/validations/product";

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

        const includeCost = request.nextUrl.searchParams.get("includeCost") === "true";

        if (includeCost) {
            const granted = await getGrantedPermissions({
                userId: auth.userId,
                tenantId: auth.tenantId,
                roleId: auth.roleId,
                permissions: [...PRODUCT_COST_PERMISSIONS],
            });

            if (!hasCostPermission(granted)) {
                return NextResponse.json(
                    {
                        success: false,
                        message: "You do not have permission to view product purchase costs",
                    },
                    { status: 403 }
                );
            }
        }

        await connectDB();

        const query = Product.find({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        }).sort({ createdAt: -1 });

        if (!includeCost) {
            query.select("-purchasePrice -__v");
        } else {
            query.select("-__v");
        }

        const rawProducts = await query.lean();
        const products = filterProductsList(rawProducts, includeCost);

        return NextResponse.json({
            success: true,
            count: products.length,
            products,
        });
    } catch (error) {
        if (isDatabaseConnectionError(error)) {
            console.warn("GET /api/products: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                {
                    success: false,
                    message: "Database connection unavailable",
                    offline: true,
                },
                { status: 503 }
            );
        }
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
    let duplicateCheckTenantId: mongoose.Types.ObjectId | undefined;
    let duplicateCheckOpId: string | undefined;

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
        const normalizedOperationId = data.operationId?.trim() || undefined;
        duplicateCheckTenantId = tenantId;
        duplicateCheckOpId = normalizedOperationId;

        await connectDB();

        // Idempotency check: if an operationId was provided and product was already created, return it.
        if (normalizedOperationId) {
            const existingByOpId = await Product.findOne({
                tenantId,
                operationId: normalizedOperationId,
            }).lean();

            if (existingByOpId) {
                return NextResponse.json(
                    {
                        success: true,
                        message: "Product created successfully",
                        product: existingByOpId,
                        alreadyProcessed: true,
                    },
                    { status: 200 }
                );
            }
        }

        // Confirm the category and unit belong to this tenant.
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

        // Normalize the SKU and clean optional barcode.
        const sku = data.SKU.toUpperCase();
        const cleanBarcode = data.barcode?.trim() ? data.barcode.trim().toUpperCase() : undefined;

        const duplicateConditions: Record<string, unknown>[] = [
            { tenantId, SKU: sku },
        ];

        if (cleanBarcode) {
            duplicateConditions.push({
                tenantId,
                barcode: cleanBarcode,
            });
        }

        const duplicate = await Product.findOne({
            $or: duplicateConditions,
        })
            .select("_id SKU barcode")
            .lean();

        if (duplicate) {
            const isSkuMatch = duplicate.SKU?.toUpperCase() === sku;
            const isBarcodeMatch = Boolean(
                cleanBarcode &&
                duplicate.barcode &&
                duplicate.barcode.trim().toUpperCase() === cleanBarcode
            );

            let message = "A product with this SKU or barcode already exists";
            if (isSkuMatch && !isBarcodeMatch) {
                message = "A product with this SKU already exists";
            } else if (isBarcodeMatch && !isSkuMatch) {
                message = "A product with this barcode already exists";
            }

            return NextResponse.json(
                {
                    success: false,
                    message,
                },
                { status: 409 }
            );
        }

        // Product creation, audit logging, and initial stock movement share one transaction.
        const session = await mongoose.startSession();

        try {
            const createdProduct = await session.withTransaction(async () => {
                const [product] = await Product.create(
                    [
                        {
                            tenantId,
                            name: data.name,
                            SKU: sku,
                            ...(cleanBarcode
                                ? { barcode: cleanBarcode }
                                : {}),
                            categoryId: new mongoose.Types.ObjectId(
                                data.categoryId
                            ),
                            unitId: new mongoose.Types.ObjectId(data.unitId),
                            purchasePrice: data.purchasePrice,
                            sellingPrice: data.sellingPrice,
                            stockQuantity: 0,
                            ...(typeof data.taxRate === "number"
                                ? { taxRate: data.taxRate }
                                : {}),
                            ...(data.hsnCode?.trim()
                                ? { hsnCode: data.hsnCode.trim() }
                                : {}),
                            ...(normalizedOperationId
                                ? { operationId: normalizedOperationId }
                                : {}),
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
                            taxRate: product.taxRate,
                            hsnCode: product.hsnCode,
                            operationId: normalizedOperationId,
                            status: product.status,
                        },
                    },
                    session
                );

                const openingStock =
                    typeof data.openingStock === "number" &&
                    Number.isFinite(data.openingStock) &&
                    data.openingStock > 0
                        ? data.openingStock
                        : 0;

                if (openingStock > 0) {
                    const movementOpId = normalizedOperationId
                        ? `${normalizedOperationId}:opening-stock`
                        : `${product._id.toString()}:opening-stock`;

                    await StockService.changeStock(
                        {
                            userId: new mongoose.Types.ObjectId(auth.userId),
                            tenantId,
                        },
                        {
                            productId: product._id.toString(),
                            quantity: openingStock,
                            type: "adjustment",
                            warehouse: { name: "Main Store" },
                            reason: "Initial opening stock",
                        },
                        session,
                        movementOpId
                    );

                    product.stockQuantity = openingStock;
                }

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
            const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
            if (keyPattern?.operationId && duplicateCheckOpId && duplicateCheckTenantId) {
                const existing = await Product.findOne({
                    tenantId: duplicateCheckTenantId,
                    operationId: duplicateCheckOpId,
                })
                    .populate("category", "name")
                    .populate("unit", "name shortName")
                    .lean();

                if (existing) {
                    return NextResponse.json({
                        success: true,
                        message: "Product already created",
                        product: existing,
                        alreadyProcessed: true,
                    });
                }
            }

            let message = "A product with this SKU or barcode already exists";
            if (keyPattern) {
                if (keyPattern.barcode) {
                    message = "A product with this barcode already exists";
                } else if (keyPattern.SKU) {
                    message = "A product with this SKU already exists";
                } else if (keyPattern.operationId) {
                    message = "A product with this operation ID already exists";
                }
            }

            return NextResponse.json(
                {
                    success: false,
                    message,
                },
                { status: 409 }
            );
        }

        if (isDatabaseConnectionError(error)) {
            console.warn("POST /api/products: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                {
                    success: false,
                    message: "Database connection unavailable",
                    offline: true,
                },
                { status: 503 }
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