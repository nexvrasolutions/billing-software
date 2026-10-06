import mongoose from "mongoose";

import { Product } from "@/lib/models/Product";
import { StockMovement } from "@/lib/models/StockMovement";
import { AuditLogService } from "@/lib/services/AuditLogService";

export interface StockUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

export interface StockChangeInput {
    productId: string;

    /**
     * Positive quantity = stock increase
     * Negative quantity = stock decrease
     */
    quantity: number;

    type:
    | "purchase"
    | "sale"
    | "purchase_return"
    | "sales_return"
    | "adjustment";

    warehouse: {
        name: string;
        location?: string;
    };

    referenceId?: string;

    reason?: string;
}

export class StockService {
    /**
     * Change product stock and create a stock movement.
     *
     * Examples:
     *
     * Purchase:
     * quantity: 20
     *
     * Sale:
     * quantity: -5
     *
     * Sales return:
     * quantity: 5
     *
     * Purchase return:
     * quantity: -3
     *
     * Adjustment:
     * quantity: 10 or -10
     */
    static async changeStock(
        user: StockUserContext,
        input: StockChangeInput,
        session?: mongoose.ClientSession
    ) {
        // --------------------------------------------------
        // 1. Validate user
        // --------------------------------------------------

        if (!user.userId) {
            throw new Error("Authenticated user is required");
        }

        if (!user.tenantId) {
            throw new Error("Tenant context is required");
        }

        // --------------------------------------------------
        // 2. Validate product ID
        // --------------------------------------------------

        if (!mongoose.isValidObjectId(input.productId)) {
            throw new Error("Invalid product ID");
        }

        // --------------------------------------------------
        // 3. Validate quantity
        // --------------------------------------------------

        if (
            typeof input.quantity !== "number" ||
            !Number.isFinite(input.quantity) ||
            input.quantity === 0
        ) {
            throw new Error(
                "Stock quantity must be a valid non-zero number"
            );
        }

        // --------------------------------------------------
        // 4. Validate warehouse
        // --------------------------------------------------

        if (!input.warehouse?.name?.trim()) {
            throw new Error("Warehouse name is required");
        }

        // --------------------------------------------------
        // 5. Validate reference ID
        // --------------------------------------------------

        if (
            input.referenceId &&
            !mongoose.isValidObjectId(input.referenceId)
        ) {
            throw new Error("Invalid reference ID");
        }

        // --------------------------------------------------
        // 6. Find product
        // --------------------------------------------------

        const productQuery = Product.findOne({
            _id: input.productId,
            tenantId: user.tenantId,
            status: "active",
        });

        if (session) {
            productQuery.session(session);
        }

        const product = await productQuery;

        if (!product) {
            throw new Error(
                "Product not found or inactive"
            );
        }

        // --------------------------------------------------
        // 7. Get previous stock
        // --------------------------------------------------

        const previousStock = product.stockQuantity;

        // --------------------------------------------------
        // 8. Calculate new stock
        // --------------------------------------------------

        const newStock =
            previousStock + input.quantity;

        // --------------------------------------------------
        // 9. Prevent negative stock
        // --------------------------------------------------

        if (newStock < 0) {
            throw new Error(
                `Insufficient stock for product ${product.name}`
            );
        }

        // --------------------------------------------------
        // 10. Update product stock
        // --------------------------------------------------

        const updateQuery = Product.findOneAndUpdate(
            {
                _id: product._id,
                tenantId: user.tenantId,
                status: "active",

                // Extra protection when decreasing stock
                ...(input.quantity < 0
                    ? {
                        stockQuantity: {
                            $gte: Math.abs(
                                input.quantity
                            ),
                        },
                    }
                    : {}),
            },
            {
                $inc: {
                    stockQuantity: input.quantity,
                },
            },
            {
                new: true,
            }
        );

        if (session) {
            updateQuery.session(session);
        }

        const updatedProduct =
            await updateQuery;

        if (!updatedProduct) {
            throw new Error(
                `Insufficient stock for product ${product.name}`
            );
        }

        // --------------------------------------------------
        // 11. Create stock movement
        // --------------------------------------------------

        const movementData = {
            tenantId: user.tenantId,

            productId: product._id,

            type: input.type,

            quantity: input.quantity,

            referenceId: input.referenceId
                ? new mongoose.Types.ObjectId(
                    input.referenceId
                )
                : undefined,

            previousStock,

            newStock,

            warehouse: {
                name: input.warehouse.name.trim(),

                location:
                    input.warehouse.location?.trim(),
            },

            reason: input.reason,

            createdBy: user.userId,
        };

        let movement;

        if (session) {
            const result =
                await StockMovement.create(
                    [movementData],
                    { session }
                );

            movement = result[0];
        } else {
            movement =
                await StockMovement.create(
                    movementData
                );
        }

        // --------------------------------------------------
        // --------------------------------------------------
        // 12. Create audit log for stock adjustment
        // --------------------------------------------------

        let auditLog;

        if (input.type === "adjustment") {
            auditLog = await AuditLogService.createAuditLog(
                {
                    userId: user.userId,
                    tenantId: user.tenantId,
                },
                {
                    action: "STOCK_ADJUSTMENT",
                    entity: "Product",
                    entityId: product._id,
                    description:
                        input.reason?.trim() ||
                        `Stock adjusted for product ${product.name}`,
                    oldValues: {
                        stockQuantity: previousStock,
                    },
                    newValues: {
                        stockQuantity: newStock,
                    },
                },
                session
            );
        }

        // --------------------------------------------------
        // 13. Return result
        // --------------------------------------------------

        return {
            product: updatedProduct,
            movement,
            previousStock,
            newStock,
            quantityChanged: input.quantity,
            auditLog,
        };
    }

    /**
     * Get current stock for a product.
     */
    static async getStock(
        user: StockUserContext,
        productId: string
    ) {
        if (!mongoose.isValidObjectId(productId)) {
            throw new Error("Invalid product ID");
        }

        const product = await Product.findOne({
            _id: productId,
            tenantId: user.tenantId,
            status: "active",
        }).select(
            "_id name SKU stockQuantity unitId"
        );

        if (!product) {
            throw new Error(
                "Product not found or inactive"
            );
        }

        return product;
    }

    /**
     * Get stock movement history.
     */
    static async getMovements(
        user: StockUserContext,
        options?: {
            productId?: string;
            type?:
            | "purchase"
            | "sale"
            | "purchase_return"
            | "sales_return"
            | "adjustment";
            page?: number;
            limit?: number;
        }
    ) {
        const page = Math.max(
            options?.page ?? 1,
            1
        );

        const limit = Math.min(
            Math.max(
                options?.limit ?? 20,
                1
            ),
            100
        );

        const filter: Record<
            string,
            unknown
        > = {
            tenantId: user.tenantId,
        };

        // Filter by product
        if (options?.productId) {
            if (
                !mongoose.isValidObjectId(
                    options.productId
                )
            ) {
                throw new Error(
                    "Invalid product ID"
                );
            }

            filter.productId =
                new mongoose.Types.ObjectId(
                    options.productId
                );
        }

        // Filter by movement type
        if (options?.type) {
            filter.type = options.type;
        }

        const skip =
            (page - 1) * limit;

        const [movements, total] =
            await Promise.all([
                StockMovement.find(filter)
                    .sort({
                        createdAt: -1,
                        _id: -1,
                    })
                    .skip(skip)
                    .limit(limit)
                    .lean(),

                StockMovement.countDocuments(
                    filter
                ),
            ]);

        return {
            movements,
            pagination: {
                page,
                limit,
                total,
                totalPages:
                    Math.ceil(total / limit),
            },
        };
    }
}