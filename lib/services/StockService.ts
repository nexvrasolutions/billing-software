
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
     * Positive quantity = stock increase.
     * Negative quantity = stock decrease.
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
     * Changes stock.
     *
     * If a caller supplies a session, its existing transaction
     * is reused. Otherwise, this method creates and owns a
     * MongoDB transaction.
     */
    static async changeStock(
        user: StockUserContext,
        input: StockChangeInput,
        session?: mongoose.ClientSession,
        operationId?: string
    ) {
        const normalizedOperationId =
            operationId?.trim() || undefined;

        // Reuse the transaction owned by SalesService,
        // PurchaseService, or another calling service.
        if (session) {
            return this.changeStockInSession(
                user,
                input,
                session,
                normalizedOperationId
            );
        }

        // Standalone calls get their own transaction.
        const ownSession = await mongoose.startSession();

        try {
            let result:
                | Awaited<
                    ReturnType<
                        typeof StockService.changeStockInSession
                    >
                >
                | undefined;

            await ownSession.withTransaction(async () => {
                result = await this.changeStockInSession(
                    user,
                    input,
                    ownSession,
                    normalizedOperationId
                );
            });

            if (!result) {
                throw new Error(
                    "Stock transaction completed without a result"
                );
            }

            return result;
        } catch (error: unknown) {
            // A concurrent request may have completed the
            // same adjustment first. Look up the movement
            // only after the transaction has failed.
            const mongoError = error as { code?: number };

            if (
                mongoError?.code === 11000 &&
                input.type === "adjustment" &&
                normalizedOperationId
            ) {
                const existingMovement =
                    await StockMovement.findOne({
                        tenantId: user.tenantId,
                        operationId: normalizedOperationId,
                        type: "adjustment",
                    });

                if (existingMovement) {
                    const product = await Product.findOne({
                        _id: existingMovement.productId,
                        tenantId: user.tenantId,
                    });

                    return {
                        product,
                        movement: existingMovement,
                        previousStock:
                            existingMovement.previousStock,
                        newStock: existingMovement.newStock,
                        quantityChanged:
                            existingMovement.quantity,
                        auditLog: undefined,
                        alreadyProcessed: true,
                    };
                }
            }

            throw error;
        } finally {
            await ownSession.endSession();
        }
    }

    /**
     * Performs the stock update, movement creation, and
     * audit logging inside the supplied transaction.
     */
    private static async changeStockInSession(
        user: StockUserContext,
        input: StockChangeInput,
        session: mongoose.ClientSession,
        operationId?: string
    ) {
        // 1. Validate authenticated context.
        if (!user.userId) {
            throw new Error("Authenticated user is required");
        }

        if (!user.tenantId) {
            throw new Error("Tenant context is required");
        }

        // 2. Validate product ID.
        if (!mongoose.isValidObjectId(input.productId)) {
            throw new Error("Invalid product ID");
        }

        // 3. Validate quantity.
        if (
            typeof input.quantity !== "number" ||
            !Number.isFinite(input.quantity) ||
            input.quantity === 0
        ) {
            throw new Error(
                "Stock quantity must be a valid non-zero number"
            );
        }

        // 4. Validate movement type.
        const validTypes = [
            "purchase",
            "sale",
            "purchase_return",
            "sales_return",
            "adjustment",
        ] as const;

        if (
            !validTypes.includes(
                input.type as (typeof validTypes)[number]
            )
        ) {
            throw new Error("Invalid stock movement type");
        }

        // 5. Validate warehouse.
        if (!input.warehouse?.name?.trim()) {
            throw new Error("Warehouse name is required");
        }

        // 6. Validate reference ID.
        if (
            input.referenceId &&
            !mongoose.isValidObjectId(input.referenceId)
        ) {
            throw new Error("Invalid reference ID");
        }

        // 7. Idempotency check for adjustments.
        // A retry of the same operation must not change stock again.
        if (input.type === "adjustment" && operationId) {
            const existingMovement =
                await StockMovement.findOne({
                    tenantId: user.tenantId,
                    operationId,
                    type: "adjustment",
                }).session(session);

            if (existingMovement) {
                const existingProduct = await Product.findOne({
                    _id: existingMovement.productId,
                    tenantId: user.tenantId,
                }).session(session);

                return {
                    product: existingProduct,
                    movement: existingMovement,
                    previousStock:
                        existingMovement.previousStock,
                    newStock: existingMovement.newStock,
                    quantityChanged:
                        existingMovement.quantity,
                    auditLog: undefined,
                    alreadyProcessed: true,
                };
            }
        }

        // 8. Find the active product in this tenant only.
        const product = await Product.findOne({
            _id: input.productId,
            tenantId: user.tenantId,
            status: "active",
        }).session(session);

        if (!product) {
            throw new Error("Product not found or inactive");
        }

        // 9. Calculate stock change.
        const previousStock = product.stockQuantity;
        const newStock = previousStock + input.quantity;

        if (newStock < 0) {
            throw new Error(
                `Insufficient stock for product ${product.name}`
            );
        }

        // 10. Atomically update stock.
        // The stockQuantity condition prevents concurrent
        // decrements from taking stock below zero.
        const updatedProduct = await Product.findOneAndUpdate(
            {
                _id: product._id,
                tenantId: user.tenantId,
                status: "active",
                ...(input.quantity < 0
                    ? {
                        stockQuantity: {
                            $gte: Math.abs(input.quantity),
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
                session,
            }
        );

        if (!updatedProduct) {
            throw new Error(
                `Insufficient stock or product unavailable: ${product.name}`
            );
        }

        // 11. Create stock movement in the same transaction.
        const movementData = {
            tenantId: user.tenantId,
            productId: product._id,
            ...(input.type === "adjustment" && operationId
                ? { operationId }
                : {}),
            type: input.type,
            quantity: input.quantity,
            referenceId: input.referenceId
                ? new mongoose.Types.ObjectId(input.referenceId)
                : undefined,
            previousStock,
            newStock,
            warehouse: {
                name: input.warehouse.name.trim(),
                location: input.warehouse.location?.trim(),
            },
            reason: input.reason?.trim(),
            createdBy: user.userId,
        };

        // Do not catch duplicate-key errors here: the transaction
        // owner must be allowed to abort the transaction.
        const [movement] = await StockMovement.create(
            [movementData],
            { session }
        );

        // 12. Record audit history for manual adjustments.
        // An audit failure must roll back the stock update and
        // movement because all three writes share this session.
        let auditLog: unknown;

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
                        operationId,
                    },
                },
                session
            );
        }

        // 13. Return the result.
        return {
            product: updatedProduct,
            movement,
            previousStock,
            newStock,
            quantityChanged: input.quantity,
            auditLog,
            alreadyProcessed: false,
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
        }).select("_id name SKU stockQuantity unitId");

        if (!product) {
            throw new Error("Product not found or inactive");
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
            Math.floor(options?.page ?? 1),
            1
        );

        const limit = Math.min(
            Math.max(
                Math.floor(options?.limit ?? 20),
                1
            ),
            100
        );

        const filter: Record<string, unknown> = {
            tenantId: user.tenantId,
        };

        if (options?.productId) {
            if (!mongoose.isValidObjectId(options.productId)) {
                throw new Error("Invalid product ID");
            }

            filter.productId = new mongoose.Types.ObjectId(
                options.productId
            );
        }

        if (options?.type) {
            filter.type = options.type;
        }

        const skip = (page - 1) * limit;

        const [movements, total] = await Promise.all([
            StockMovement.find(filter)
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),

            StockMovement.countDocuments(filter),
        ]);

        return {
            movements,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }
}
