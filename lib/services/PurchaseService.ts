import mongoose from "mongoose";

import { Purchase } from "@/lib/models/Purchase";
import { Product } from "@/lib/models/Product";
import { Supplier } from "@/lib/models/Supplier";
import { Unit } from "@/lib/models/Unit";
import { StockService } from "@/lib/services/StockService";
import { AuditLogService } from "@/lib/services/AuditLogService";

/* =========================
   User Context
========================= */

export interface PurchaseUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

/* =========================
   Purchase Item Input
========================= */

export interface PurchaseItemInput {
    productId: string;
    quantity: number;
    unitPrice: number;
    discountRate?: number;
    taxRate?: number;
}

/* =========================
   Create Purchase Input
========================= */

export interface CreatePurchaseInput {
    purchaseNo: string;

    supplierId: string;

    purchaseDate?: Date;

    supplierInvoiceNo?: string;

    supplierInvoiceDate?: Date;

    dueDate?: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: PurchaseItemInput[];

    shippingCost?: number;

    paidAmount?: number;

    paymentStatus?: "unpaid" | "partial" | "paid";

    notes?: string;
}

/* =========================
   Purchase Service
========================= */

export class PurchaseService {

    // ============================================================
    // CREATE PURCHASE
    // ============================================================

    static async createPurchase(
        user: PurchaseUserContext,
        input: CreatePurchaseInput,
        operationId?: string
    ) {
        /*
         * operationId comes from the server-side sync system.
         *
         * It identifies one exact offline operation.
         *
         * Example:
         *
         * OP-PURCHASE-001
         *
         * If the same operation is retried,
         * we must not create another purchase.
         */

        const normalizedOperationId =
            operationId?.trim() || undefined;

        const session =
            await mongoose.startSession();

        try {
            let createdPurchase = null;

            await session.withTransaction(
                async () => {

                    // ----------------------------------------------------
                    // 1. Validate user
                    // ----------------------------------------------------

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

                    // ----------------------------------------------------
                    // 2. Validate purchase number
                    // ----------------------------------------------------

                    if (!input.purchaseNo?.trim()) {
                        throw new Error(
                            "Purchase number is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 3. Idempotency check
                    // ----------------------------------------------------
                    //
                    // If this exact offline operation was already
                    // processed, return the existing purchase.
                    //
                    // This prevents:
                    //
                    // duplicate purchase
                    // duplicate stock increase
                    // duplicate audit log
                    //

                    if (normalizedOperationId) {

                        const existingOperationPurchase =
                            await Purchase.findOne({
                                tenantId: user.tenantId,
                                operationId:
                                    normalizedOperationId,
                            }).session(session);

                        if (existingOperationPurchase) {
                            (existingOperationPurchase as unknown as { alreadyProcessed?: boolean }).alreadyProcessed = true;
                            createdPurchase =
                                existingOperationPurchase;

                            return;
                        }
                    }

                    // ----------------------------------------------------
                    // 4. Validate supplier ID
                    // ----------------------------------------------------

                    if (
                        !mongoose.isValidObjectId(
                            input.supplierId
                        )
                    ) {
                        throw new Error(
                            "Invalid supplier ID"
                        );
                    }

                    // ----------------------------------------------------
                    // 5. Validate warehouse
                    // ----------------------------------------------------

                    if (
                        !input.warehouse?.name?.trim()
                    ) {
                        throw new Error(
                            "Warehouse name is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 6. Validate items
                    // ----------------------------------------------------

                    if (
                        !Array.isArray(input.items) ||
                        input.items.length === 0
                    ) {
                        throw new Error(
                            "At least one purchase item is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 7. Check duplicate purchase number
                    // ----------------------------------------------------

                    const existingPurchase =
                        await Purchase.findOne({
                            tenantId: user.tenantId,
                            purchaseNo:
                                input.purchaseNo.trim(),
                        }).session(session);

                    if (existingPurchase) {
                        throw new Error(
                            `Purchase ${input.purchaseNo} already exists`
                        );
                    }

                    // ----------------------------------------------------
                    // 8. Find supplier
                    // ----------------------------------------------------

                    const supplier =
                        await Supplier.findOne({
                            _id: input.supplierId,
                            tenantId: user.tenantId,
                            status: "active",
                            isDeleted: false,
                        }).session(session);

                    if (!supplier) {
                        throw new Error(
                            "Supplier not found or inactive"
                        );
                    }

                    // ----------------------------------------------------
                    // 9. Prepare purchase items
                    // ----------------------------------------------------

                    const purchaseItems = [];

                    let subtotal = 0;
                    let discountTotal = 0;
                    let taxTotal = 0;

                    // ----------------------------------------------------
                    // 10. Process every product
                    // ----------------------------------------------------

                    for (const item of input.items) {

                        // ------------------------------------------------
                        // Product ID validation
                        // ------------------------------------------------

                        if (
                            !mongoose.isValidObjectId(
                                item.productId
                            )
                        ) {
                            throw new Error(
                                `Invalid product ID: ${item.productId}`
                            );
                        }

                        // ------------------------------------------------
                        // Quantity validation
                        // ------------------------------------------------

                        if (
                            typeof item.quantity !== "number" ||
                            !Number.isFinite(
                                item.quantity
                            ) ||
                            item.quantity <= 0
                        ) {
                            throw new Error(
                                `Invalid quantity for product ${item.productId}`
                            );
                        }

                        // ------------------------------------------------
                        // Unit price validation
                        // ------------------------------------------------

                        if (
                            typeof item.unitPrice !== "number" ||
                            !Number.isFinite(
                                item.unitPrice
                            ) ||
                            item.unitPrice < 0
                        ) {
                            throw new Error(
                                `Invalid unit price for product ${item.productId}`
                            );
                        }

                        // ------------------------------------------------
                        // Find product
                        // ------------------------------------------------

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

                        // ------------------------------------------------
                        // Find unit
                        // ------------------------------------------------

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

                        // ------------------------------------------------
                        // Discount
                        // ------------------------------------------------

                        const discountRate =
                            item.discountRate ?? 0;

                        if (
                            typeof discountRate !== "number" ||
                            !Number.isFinite(
                                discountRate
                            ) ||
                            discountRate < 0 ||
                            discountRate > 100
                        ) {
                            throw new Error(
                                `Invalid discount rate for ${product.name}`
                            );
                        }

                        // ------------------------------------------------
                        // Gross amount
                        // ------------------------------------------------

                        const grossAmount =
                            item.quantity *
                            item.unitPrice;

                        // ------------------------------------------------
                        // Discount amount
                        // ------------------------------------------------

                        const discountAmount =
                            (grossAmount *
                                discountRate) /
                            100;

                        // ------------------------------------------------
                        // Taxable amount
                        // ------------------------------------------------

                        const taxableAmount =
                            grossAmount -
                            discountAmount;

                        // ------------------------------------------------
                        // Tax
                        // ------------------------------------------------

                        const taxRate =
                            item.taxRate ?? 0;

                        if (
                            typeof taxRate !== "number" ||
                            !Number.isFinite(
                                taxRate
                            ) ||
                            taxRate < 0
                        ) {
                            throw new Error(
                                `Invalid tax rate for ${product.name}`
                            );
                        }

                        const taxAmount =
                            (taxableAmount *
                                taxRate) /
                            100;

                        // ------------------------------------------------
                        // Line total
                        // ------------------------------------------------

                        const lineTotal =
                            taxableAmount +
                            taxAmount;

                        // ------------------------------------------------
                        // Update totals
                        // ------------------------------------------------

                        subtotal += grossAmount;

                        discountTotal +=
                            discountAmount;

                        taxTotal += taxAmount;

                        // ------------------------------------------------
                        // Purchase item
                        // ------------------------------------------------

                        purchaseItems.push({
                            productId: product._id,

                            productSnapshot: {
                                name: product.name,
                                SKU: product.SKU,
                                unit: unit.shortName,
                            },

                            quantity:
                                item.quantity,

                            unitPrice:
                                item.unitPrice,

                            discountRate,

                            discountAmount,

                            tax: {
                                rate: taxRate,
                                amount: taxAmount,
                            },

                            total: lineTotal,
                        });
                    }

                    // ----------------------------------------------------
                    // 11. Shipping
                    // ----------------------------------------------------

                    const shippingCost =
                        input.shippingCost ?? 0;

                    if (
                        typeof shippingCost !== "number" ||
                        !Number.isFinite(
                            shippingCost
                        ) ||
                        shippingCost < 0
                    ) {
                        throw new Error(
                            "Invalid shipping cost"
                        );
                    }

                    // ----------------------------------------------------
                    // 12. Calculate grand total
                    // ----------------------------------------------------

                    const grandTotal =
                        subtotal -
                        discountTotal +
                        taxTotal +
                        shippingCost;

                    // ----------------------------------------------------
                    // 13. Paid amount
                    // ----------------------------------------------------

                    const paidAmount =
                        input.paidAmount ?? 0;

                    if (
                        typeof paidAmount !== "number" ||
                        !Number.isFinite(
                            paidAmount
                        ) ||
                        paidAmount < 0
                    ) {
                        throw new Error(
                            "Invalid paid amount"
                        );
                    }

                    if (
                        paidAmount > grandTotal
                    ) {
                        throw new Error(
                            "Paid amount cannot exceed grandTotal"
                        );
                    }

                    // ----------------------------------------------------
                    // 14. Due amount
                    // ----------------------------------------------------

                    const dueAmount =
                        grandTotal -
                        paidAmount;

                    // ----------------------------------------------------
                    // 15. Payment status
                    // ----------------------------------------------------

                    let paymentStatus:
                        | "unpaid"
                        | "partial"
                        | "paid";

                    if (
                        paidAmount === 0
                    ) {
                        paymentStatus =
                            "unpaid";
                    } else if (
                        paidAmount < grandTotal
                    ) {
                        paymentStatus =
                            "partial";
                    } else {
                        paymentStatus =
                            "paid";
                    }

                    // ----------------------------------------------------
                    // 16. Create purchase
                    // ----------------------------------------------------

                    const purchase =
                        new Purchase({

                            tenantId:
                                user.tenantId,

                            // Offline operation identifier
                            operationId:
                                normalizedOperationId,

                            purchaseNo:
                                input.purchaseNo.trim(),

                            supplierId:
                                supplier._id,

                            supplierSnapshot: {
                                name:
                                    supplier.name,

                                supplierCode:
                                    supplier.supplierCode,

                                phone:
                                    supplier.contact?.phone,

                                gstin:
                                    supplier.tax?.gstin,
                            },

                            purchaseDate:
                                input.purchaseDate ??
                                new Date(),

                            supplierInvoiceNo:
                                input.supplierInvoiceNo,

                            supplierInvoiceDate:
                                input.supplierInvoiceDate,

                            dueDate:
                                input.dueDate,

                            warehouse: {
                                name:
                                    input.warehouse.name.trim(),

                                location:
                                    input.warehouse.location?.trim(),
                            },

                            items:
                                purchaseItems,

                            subtotal,

                            discountTotal,

                            taxTotal,

                            shippingCost,

                            grandTotal,

                            paidAmount,

                            dueAmount,

                            paymentStatus,

                            status:
                                "received",

                            notes:
                                input.notes,

                            createdBy:
                                user.userId,
                        });

                    // ----------------------------------------------------
                    // 17. Save purchase
                    // ----------------------------------------------------

                    await purchase.save({
                        session,
                    });

                    // ----------------------------------------------------
                    // 18. Increase stock
                    // ----------------------------------------------------

                    for (
                        const item of purchaseItems
                    ) {

                        await StockService.changeStock(
                            user,

                            {
                                productId:
                                    item.productId.toString(),

                                // Purchase increases stock
                                quantity:
                                    item.quantity,

                                type:
                                    "purchase",

                                warehouse: {
                                    name:
                                        input.warehouse.name.trim(),

                                    location:
                                        input.warehouse.location?.trim(),
                                },

                                referenceId:
                                    purchase._id.toString(),

                                reason:
                                    `Purchase ${purchase.purchaseNo}`,
                            },

                            session
                        );
                    }

                    // ----------------------------------------------------
                    // 19. Create audit log
                    // ----------------------------------------------------

                    await AuditLogService.createAuditLog(
                        {
                            userId:
                                user.userId,

                            tenantId:
                                user.tenantId,
                        },

                        {
                            action:
                                "CREATE",

                            entity:
                                "Purchase",

                            entityId:
                                purchase._id,

                            description:
                                `Purchase ${purchase.purchaseNo} created`,

                            newValues: {
                                purchaseNo:
                                    purchase.purchaseNo,

                                supplierId:
                                    purchase.supplierId,

                                grandTotal:
                                    purchase.grandTotal,

                                paidAmount:
                                    purchase.paidAmount,

                                dueAmount:
                                    purchase.dueAmount,

                                paymentStatus:
                                    purchase.paymentStatus,

                                status:
                                    purchase.status,
                            },
                        },

                        session
                    );

                    // ----------------------------------------------------
                    // 20. Store created purchase
                    // ----------------------------------------------------

                    createdPurchase =
                        purchase;
                }
            );

            return createdPurchase;

        } catch (error: unknown) {

            /*
             * Concurrent idempotency protection.
             *
             * If two identical operations arrive at the same time,
             * the unique tenantId + operationId index prevents
             * duplicate purchases.
             *
             * The transaction that loses the race is rolled back.
             * We then return the already-created purchase.
             */

            const mongoError =
                error as mongoose.mongo.MongoServerError;

            if (
                normalizedOperationId &&
                mongoError?.code === 11000
            ) {

                const existingOperationPurchase =
                    await Purchase.findOne({
                        tenantId:
                            user.tenantId,

                        operationId:
                            normalizedOperationId,
                    });

                if (
                    existingOperationPurchase
                ) {
                    (existingOperationPurchase as unknown as { alreadyProcessed?: boolean }).alreadyProcessed = true;
                    return existingOperationPurchase;
                }
            }

            throw error;

        } finally {

            await session.endSession();
        }
    }

    // ============================================================
    // GET ONE PURCHASE
    // ============================================================

    static async getPurchase(
        user: PurchaseUserContext,
        purchaseId: string
    ) {

        if (
            !mongoose.isValidObjectId(
                purchaseId
            )
        ) {
            throw new Error(
                "Invalid purchase ID"
            );
        }

        const purchase =
            await Purchase.findOne({
                _id: purchaseId,
                tenantId: user.tenantId,
            });

        if (!purchase) {
            throw new Error(
                "Purchase not found"
            );
        }

        return purchase;
    }

    // ============================================================
    // GET PURCHASES
    // ============================================================

    static async getPurchases(
        user: PurchaseUserContext,
        options?: {
            page?: number;
            limit?: number;

            supplierId?: string;

            paymentStatus?:
            | "unpaid"
            | "partial"
            | "paid";

            status?:
            | "draft"
            | "received"
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

        // ----------------------------------------------------------
        // Supplier filter
        // ----------------------------------------------------------

        if (
            options?.supplierId
        ) {

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

        // ----------------------------------------------------------
        // Payment status
        // ----------------------------------------------------------

        if (
            options?.paymentStatus
        ) {

            filter.paymentStatus =
                options.paymentStatus;
        }

        // ----------------------------------------------------------
        // Purchase status
        // ----------------------------------------------------------

        if (
            options?.status
        ) {

            filter.status =
                options.status;
        }

        const skip =
            (page - 1) *
            limit;

        const [
            purchases,
            total,
        ] = await Promise.all([

            Purchase.find(
                filter
            )
                .sort({
                    purchaseDate: -1,
                    _id: -1,
                })
                .skip(skip)
                .limit(limit)
                .lean(),

            Purchase.countDocuments(
                filter
            ),
        ]);

        return {

            purchases,

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