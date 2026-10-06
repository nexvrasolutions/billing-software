import mongoose from "mongoose";

import { Purchase } from "@/lib/models/Purchase";
import { PurchaseReturn } from "@/lib/models/PurchaseReturn";
import { Product } from "@/lib/models/Product";
import { Supplier } from "@/lib/models/Supplier";
import { Unit } from "@/lib/models/Unit";
import { StockService } from "@/lib/services/StockService";
import { AuditLogService } from "@/lib/services/AuditLogService";

export interface PurchaseReturnUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

export interface PurchaseReturnItemInput {
    productId: string;
    quantity: number;
}

export interface CreatePurchaseReturnInput {
    purchaseReturnNo: string;

    purchaseId: string;

    returnDate?: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: PurchaseReturnItemInput[];

    refundAmount?: number;

    refundStatus?:
    | "pending"
    | "refunded"
    | "not_applicable";

    reason?: string;

    notes?: string;
}

export class PurchaseReturnService {
    static async createPurchaseReturn(
        user: PurchaseReturnUserContext,
        input: CreatePurchaseReturnInput,
        operationId?: string
    ) {
        const session = await mongoose.startSession();

        /*
         * Normalize operationId.
         *
         * Example:
         *
         * "  OP-123  "
         *
         * becomes:
         *
         * "OP-123"
         */
        const normalizedOperationId =
            operationId?.trim() || undefined;
        console.log(
            "DEBUG operationId:",
            normalizedOperationId
        );

        console.log(
            "DEBUG schema has operationId:",
            !!PurchaseReturn.schema.path("operationId")
        );

        console.log(
            "DEBUG schema paths:",
            Object.keys(PurchaseReturn.schema.paths)
        );

        try {
            let createdReturn = null;

            await session.withTransaction(async () => {
                // =========================================================
                // 1. USER / TENANT VALIDATION
                // =========================================================

                if (!user.userId) {
                    throw new Error(
                        "Authenticated user is required"
                    );
                }

                if (!user.tenantId) {
                    throw new Error(
                        "Tenant context is required"
                    );
                }


                // =========================================================
                // 2. BASIC VALIDATION
                // =========================================================

                if (!input.purchaseReturnNo?.trim()) {
                    throw new Error(
                        "Purchase return number is required"
                    );
                }

                if (
                    !mongoose.isValidObjectId(
                        input.purchaseId
                    )
                ) {
                    throw new Error(
                        "Invalid purchase ID"
                    );
                }

                if (!input.warehouse?.name?.trim()) {
                    throw new Error(
                        "Warehouse name is required"
                    );
                }

                if (
                    !Array.isArray(input.items) ||
                    input.items.length === 0
                ) {
                    throw new Error(
                        "At least one return item is required"
                    );
                }


                // =========================================================
                // 3. IDEMPOTENCY CHECK
                // =========================================================
                //
                // If this operation was already processed,
                // return the existing PurchaseReturn.
                //
                // IMPORTANT:
                // We return BEFORE stock is changed.
                //
                // Therefore a retry cannot decrease stock twice.
                // =========================================================

                if (normalizedOperationId) {
                    const existingOperationReturn =
                        await PurchaseReturn.findOne({
                            tenantId: user.tenantId,
                            operationId:
                                normalizedOperationId,
                        }).session(session);

                    if (existingOperationReturn) {
                        createdReturn =
                            existingOperationReturn;

                        return;
                    }
                }


                // =========================================================
                // 4. DUPLICATE RETURN NUMBER
                // =========================================================

                const existingReturn =
                    await PurchaseReturn.findOne({
                        tenantId: user.tenantId,
                        purchaseReturnNo:
                            input.purchaseReturnNo.trim(),
                    }).session(session);

                if (existingReturn) {
                    throw new Error(
                        `Purchase return ${input.purchaseReturnNo} already exists`
                    );
                }


                // =========================================================
                // 5. ORIGINAL PURCHASE
                // =========================================================

                const purchase =
                    await Purchase.findOne({
                        _id: input.purchaseId,
                        tenantId: user.tenantId,
                        status: "received",
                    }).session(session);

                if (!purchase) {
                    throw new Error(
                        "Original purchase not found or not received"
                    );
                }


                // =========================================================
                // 6. SUPPLIER
                // =========================================================

                const supplier =
                    await Supplier.findOne({
                        _id: purchase.supplierId,
                        tenantId: user.tenantId,
                        status: "active",
                        isDeleted: false,
                    }).session(session);

                if (!supplier) {
                    throw new Error(
                        "Supplier not found or inactive"
                    );
                }


                // =========================================================
                // 7. PREVIOUS RETURNS
                // =========================================================

                const previousReturns =
                    await PurchaseReturn.find({
                        tenantId: user.tenantId,
                        purchaseId: purchase._id,
                        status: "completed",
                    })
                        .session(session)
                        .lean();


                // =========================================================
                // 8. PREVIOUS RETURN MAP
                // =========================================================

                const previouslyReturned =
                    new Map<string, number>();

                for (const previousReturn of previousReturns) {
                    for (const item of previousReturn.items) {
                        const productId =
                            item.productId.toString();

                        const current =
                            previouslyReturned.get(
                                productId
                            ) ?? 0;

                        previouslyReturned.set(
                            productId,
                            current + item.quantity
                        );
                    }
                }


                // =========================================================
                // 9. PREVENT DUPLICATE PRODUCTS
                // =========================================================

                const requestedProducts =
                    new Set<string>();

                for (const item of input.items) {
                    if (
                        !mongoose.isValidObjectId(
                            item.productId
                        )
                    ) {
                        throw new Error(
                            `Invalid product ID: ${item.productId}`
                        );
                    }

                    if (
                        requestedProducts.has(
                            item.productId
                        )
                    ) {
                        throw new Error(
                            `Duplicate product in return: ${item.productId}`
                        );
                    }

                    requestedProducts.add(
                        item.productId
                    );
                }


                // =========================================================
                // 10. BUILD RETURN ITEMS
                // =========================================================

                const returnItems = [];

                let subtotal = 0;

                let discountTotal = 0;

                let taxTotal = 0;


                for (const item of input.items) {
                    // -----------------------------------------------------
                    // Quantity validation
                    // -----------------------------------------------------

                    if (
                        typeof item.quantity !== "number" ||
                        !Number.isFinite(item.quantity) ||
                        item.quantity <= 0
                    ) {
                        throw new Error(
                            `Invalid return quantity for product ${item.productId}`
                        );
                    }


                    // -----------------------------------------------------
                    // Find product in original purchase
                    // -----------------------------------------------------

                    const purchaseItem =
                        purchase.items.find(
                            (purchaseItem) =>
                                purchaseItem.productId.toString() ===
                                item.productId
                        );

                    if (!purchaseItem) {
                        throw new Error(
                            `Product ${item.productId} was not part of the original purchase`
                        );
                    }


                    // -----------------------------------------------------
                    // Calculate available return quantity
                    // -----------------------------------------------------

                    const purchasedQuantity =
                        purchaseItem.quantity;

                    const alreadyReturned =
                        previouslyReturned.get(
                            item.productId
                        ) ?? 0;

                    const availableToReturn =
                        purchasedQuantity -
                        alreadyReturned;


                    if (
                        item.quantity >
                        availableToReturn
                    ) {
                        throw new Error(
                            `Cannot return ${item.quantity} units of ${purchaseItem.productSnapshot.name}. Only ${availableToReturn} units are available for return.`
                        );
                    }


                    // -----------------------------------------------------
                    // Product validation
                    // -----------------------------------------------------

                    const product =
                        await Product.findOne({
                            _id: item.productId,
                            tenantId: user.tenantId,
                            status: "active",
                        }).session(session);

                    if (!product) {
                        throw new Error(
                            `Product not found or inactive: ${item.productId}`
                        );
                    }


                    // -----------------------------------------------------
                    // Unit validation
                    // -----------------------------------------------------

                    const unit =
                        await Unit.findOne({
                            _id: product.unitId,
                            tenantId: user.tenantId,
                            status: "active",
                        }).session(session);

                    if (!unit) {
                        throw new Error(
                            `Unit not found for product ${product.name}`
                        );
                    }


                    // -----------------------------------------------------
                    // Price / discount / tax calculation
                    // -----------------------------------------------------

                    const unitPrice =
                        purchaseItem.unitPrice;

                    const discountRate =
                        purchaseItem.discountRate ?? 0;

                    const discountPerUnit =
                        (unitPrice * discountRate) / 100;

                    const discountAmount =
                        item.quantity *
                        discountPerUnit;

                    const grossAmount =
                        item.quantity *
                        unitPrice;

                    const taxableAmount =
                        grossAmount -
                        discountAmount;

                    const taxRate =
                        purchaseItem.tax?.rate ?? 0;

                    const taxAmount =
                        (taxableAmount * taxRate) / 100;

                    const lineTotal =
                        taxableAmount +
                        taxAmount;


                    // -----------------------------------------------------
                    // Totals
                    // -----------------------------------------------------

                    subtotal += grossAmount;

                    discountTotal +=
                        discountAmount;

                    taxTotal += taxAmount;


                    // -----------------------------------------------------
                    // Return item snapshot
                    // -----------------------------------------------------

                    returnItems.push({
                        productId: product._id,

                        productSnapshot: {
                            name: product.name,
                            SKU: product.SKU,
                            unit: unit.shortName,
                        },

                        quantity: item.quantity,

                        unitPrice,

                        discountRate,

                        discountAmount,

                        tax: {
                            rate: taxRate,
                            amount: taxAmount,
                        },

                        total: lineTotal,
                    });
                }


                // =========================================================
                // 11. SHIPPING
                // =========================================================

                const shippingCost = 0;


                // =========================================================
                // 12. GRAND TOTAL
                // =========================================================

                const grandTotal =
                    subtotal -
                    discountTotal +
                    taxTotal +
                    shippingCost;


                // =========================================================
                // 13. REFUND
                // =========================================================

                const refundAmount =
                    input.refundAmount ?? 0;

                if (
                    typeof refundAmount !== "number" ||
                    !Number.isFinite(refundAmount) ||
                    refundAmount < 0
                ) {
                    throw new Error(
                        "Invalid refund amount"
                    );
                }

                if (refundAmount > grandTotal) {
                    throw new Error(
                        "Refund amount cannot exceed return total"
                    );
                }


                let refundStatus =
                    input.refundStatus ??
                    "not_applicable";

                if (
                    refundAmount > 0 &&
                    !input.refundStatus
                ) {
                    refundStatus = "pending";
                }


                // =========================================================
                // 14. CREATE PURCHASE RETURN
                // =========================================================

                const purchaseReturn =
                    new PurchaseReturn({
                        tenantId: user.tenantId,

                        // IMPORTANT:
                        // Store operationId on the return.
                        operationId:
                            normalizedOperationId,

                        purchaseReturnNo:
                            input.purchaseReturnNo.trim(),

                        purchaseId:
                            purchase._id,

                        supplierId:
                            supplier._id,

                        supplierSnapshot: {
                            name: supplier.name,

                            supplierCode:
                                supplier.supplierCode,

                            phone:
                                supplier.contact?.phone,

                            gstin:
                                supplier.tax?.gstin,
                        },

                        returnDate:
                            input.returnDate ??
                            new Date(),

                        warehouse: {
                            name:
                                input.warehouse.name.trim(),

                            location:
                                input.warehouse.location?.trim(),
                        },

                        items: returnItems,

                        subtotal,

                        discountTotal,

                        taxTotal,

                        shippingCost,

                        grandTotal,

                        refundAmount,

                        refundStatus,

                        status: "completed",

                        reason:
                            input.reason,

                        notes:
                            input.notes,

                        createdBy:
                            user.userId,
                    });


                await purchaseReturn.save({
                    session,
                });


                // =========================================================
                // 15. CHANGE STOCK
                // =========================================================
                //
                // Purchase return means goods are going BACK
                // to the supplier.
                //
                // Therefore stock decreases.
                //
                // Example:
                //
                // Stock = 51
                // Return = 1
                // New stock = 50
                //
                // This runs ONLY when the return is actually created.
                // A retry with the same operationId exits earlier.
                // =========================================================

                for (const item of returnItems) {
                    await StockService.changeStock(
                        user,
                        {
                            productId:
                                item.productId.toString(),

                            quantity:
                                -item.quantity,

                            type:
                                "purchase_return",

                            warehouse: {
                                name:
                                    input.warehouse.name.trim(),

                                location:
                                    input.warehouse.location?.trim(),
                            },

                            referenceId:
                                purchaseReturn._id.toString(),

                            reason:
                                `Purchase Return ${purchaseReturn.purchaseReturnNo}`,
                        },
                        session
                    );
                }


                // =========================================================
                // 16. AUDIT LOG
                // =========================================================

                await AuditLogService.createAuditLog(
                    {
                        userId:
                            user.userId,

                        tenantId:
                            user.tenantId,
                    },
                    {
                        action: "CREATE",

                        entity:
                            "PurchaseReturn",

                        entityId:
                            purchaseReturn._id,

                        description:
                            `Purchase Return ${purchaseReturn.purchaseReturnNo} created`,

                        newValues: {
                            purchaseReturnNo:
                                purchaseReturn.purchaseReturnNo,

                            purchaseId:
                                purchaseReturn.purchaseId,

                            supplierId:
                                purchaseReturn.supplierId,

                            grandTotal:
                                purchaseReturn.grandTotal,

                            refundAmount:
                                purchaseReturn.refundAmount,

                            refundStatus:
                                purchaseReturn.refundStatus,

                            status:
                                purchaseReturn.status,

                            reason:
                                purchaseReturn.reason,
                        },
                    },
                    session
                );


                // =========================================================
                // 17. RETURN CREATED DOCUMENT
                // =========================================================

                createdReturn =
                    purchaseReturn;
            });


            return createdReturn;

        } catch (error: unknown) {

            // =============================================================
            // DUPLICATE OPERATION ID
            // =============================================================
            //
            // This handles a concurrency situation:
            //
            // Request A:
            // operationId = OP-123
            //
            // Request B:
            // operationId = OP-123
            //
            // Both arrive at almost exactly the same time.
            //
            // MongoDB unique index guarantees that only one can win.
            //
            // The losing request gets error code 11000.
            //
            // Instead of returning an error, we fetch the PurchaseReturn
            // created by the winning request.
            // =============================================================

            if (
                normalizedOperationId &&
                error &&
                typeof error === "object" &&
                "code" in error &&
                (error as { code?: number }).code === 11000
            ) {
                const existingOperationReturn =
                    await PurchaseReturn.findOne({
                        tenantId: user.tenantId,
                        operationId:
                            normalizedOperationId,
                    });

                if (existingOperationReturn) {
                    return existingOperationReturn;
                }
            }


            // =============================================================
            // OTHER ERRORS
            // =============================================================

            throw error;

        } finally {
            await session.endSession();
        }
    }


    // =====================================================================
    // GET SINGLE PURCHASE RETURN
    // =====================================================================

    static async getPurchaseReturn(
        user: PurchaseReturnUserContext,
        purchaseReturnId: string
    ) {
        if (
            !mongoose.isValidObjectId(
                purchaseReturnId
            )
        ) {
            throw new Error(
                "Invalid purchase return ID"
            );
        }


        const purchaseReturn =
            await PurchaseReturn.findOne({
                _id: purchaseReturnId,

                tenantId:
                    user.tenantId,
            });


        if (!purchaseReturn) {
            throw new Error(
                "Purchase return not found"
            );
        }


        return purchaseReturn;
    }


    // =====================================================================
    // GET PURCHASE RETURNS
    // =====================================================================

    static async getPurchaseReturns(
        user: PurchaseReturnUserContext,
        options?: {
            page?: number;
            limit?: number;
            purchaseId?: string;
            supplierId?: string;
            status?:
            | "draft"
            | "completed"
            | "cancelled";
        }
    ) {
        const page =
            Math.max(
                options?.page ?? 1,
                1
            );


        const limit =
            Math.min(
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
            tenantId:
                user.tenantId,
        };


        // ---------------------------------------------------------------
        // Purchase filter
        // ---------------------------------------------------------------

        if (options?.purchaseId) {
            if (
                !mongoose.isValidObjectId(
                    options.purchaseId
                )
            ) {
                throw new Error(
                    "Invalid purchase ID"
                );
            }


            filter.purchaseId =
                new mongoose.Types.ObjectId(
                    options.purchaseId
                );
        }


        // ---------------------------------------------------------------
        // Supplier filter
        // ---------------------------------------------------------------

        if (options?.supplierId) {
            if (
                !mongoose.isValidObjectId(
                    options.supplierId
                )
            ) {
                throw new Error(
                    "Invalid supplier ID"
                );
            }


            filter.supplierId =
                new mongoose.Types.ObjectId(
                    options.supplierId
                );
        }


        // ---------------------------------------------------------------
        // Status filter
        // ---------------------------------------------------------------

        if (options?.status) {
            filter.status =
                options.status;
        }


        // ---------------------------------------------------------------
        // Pagination
        // ---------------------------------------------------------------

        const skip =
            (page - 1) *
            limit;


        const [
            purchaseReturns,
            total,
        ] = await Promise.all([
            PurchaseReturn.find(filter)
                .sort({
                    returnDate: -1,
                    _id: -1,
                })
                .skip(skip)
                .limit(limit)
                .lean(),

            PurchaseReturn.countDocuments(
                filter
            ),
        ]);


        return {
            purchaseReturns,

            pagination: {
                page,
                limit,
                total,

                totalPages:
                    Math.ceil(
                        total / limit
                    ),
            },
        };
    }
}