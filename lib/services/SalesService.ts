import mongoose from "mongoose";

import { Sale } from "@/lib/models/Sale";
import { Product } from "@/lib/models/Product";
import { Customer } from "@/lib/models/Customer";
import { Unit } from "@/lib/models/Unit";
import { StockService } from "@/lib/services/StockService";
import { LedgerService } from "@/lib/services/LedgerService";

export interface SalesUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

export interface SaleItemInput {
    productId: string;
    quantity: number;
    unitPrice?: number;
    discountRate?: number;
    taxRate?: number;
}

export interface CreateSaleInput {
    invoiceNo: string;

    customerId?: string;

    saleDate?: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: SaleItemInput[];

    paidAmount?: number;

    paymentMethod?:
    | "cash"
    | "bank"
    | "upi"
    | "card"
    | "credit";

    notes?: string;
}

export class SalesService {
    // ============================================================
    // CREATE SALE
    // ============================================================

    static async createSale(
        user: SalesUserContext,
        input: CreateSaleInput,
        operationId?: string
    ) {
        const session =
            await mongoose.startSession();

        /*
         * operationId is supplied by SyncService when the sale
         * comes from an offline synchronization operation.
         *
         * Online sales normally do not have an operationId.
         */
        const normalizedOperationId =
            operationId?.trim() || undefined;

        try {
            let createdSale = null;

            await session.withTransaction(
                async () => {
                    // ----------------------------------------------------
                    // 1. Validate user and tenant
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
                    // 2. Validate invoice number
                    // ----------------------------------------------------

                    if (!input.invoiceNo?.trim()) {
                        throw new Error(
                            "Invoice number is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 3. Validate warehouse
                    // ----------------------------------------------------

                    if (!input.warehouse?.name?.trim()) {
                        throw new Error(
                            "Warehouse name is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 4. Validate sale items
                    // ----------------------------------------------------

                    if (
                        !Array.isArray(input.items) ||
                        input.items.length === 0
                    ) {
                        throw new Error(
                            "At least one sale item is required"
                        );
                    }

                    // ----------------------------------------------------
                    // 5. IDEMPOTENCY CHECK
                    // ----------------------------------------------------
                    //
                    // If this exact offline operation has already
                    // created a sale, return that existing sale.
                    //
                    // This is what makes retrying the same operation safe.
                    // ----------------------------------------------------

                    if (normalizedOperationId) {
                        const existingOperationSale =
                            await Sale.findOne({
                                tenantId: user.tenantId,
                                operationId:
                                    normalizedOperationId,
                            }).session(session);

                        if (existingOperationSale) {
                            createdSale =
                                existingOperationSale;

                            return;
                        }
                    }

                    // ----------------------------------------------------
                    // 6. Check duplicate invoice
                    // ----------------------------------------------------

                    const existingInvoice =
                        await Sale.findOne({
                            tenantId: user.tenantId,
                            invoiceNo:
                                input.invoiceNo.trim(),
                        }).session(session);

                    if (existingInvoice) {
                        throw new Error(
                            `Invoice ${input.invoiceNo} already exists`
                        );
                    }

                    // ----------------------------------------------------
                    // 7. Find customer
                    // ----------------------------------------------------

                    let customer = null;

                    if (input.customerId) {
                        if (
                            !mongoose.isValidObjectId(
                                input.customerId
                            )
                        ) {
                            throw new Error(
                                "Invalid customer ID"
                            );
                        }

                        customer =
                            await Customer.findOne({
                                _id: input.customerId,
                                tenantId:
                                    user.tenantId,
                                status: "active",
                            }).session(session);

                        if (!customer) {
                            throw new Error(
                                "Customer not found or inactive"
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // 8. Prepare sale items
                    // ----------------------------------------------------

                    const saleItems = [];

                    let subtotal = 0;
                    let discountTotal = 0;
                    let taxTotal = 0;

                    // ----------------------------------------------------
                    // 9. Process each product
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
                        // Find product
                        // ------------------------------------------------

                        const product =
                            await Product.findOne({
                                _id: item.productId,
                                tenantId:
                                    user.tenantId,
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
                                tenantId:
                                    user.tenantId,
                                status: "active",
                            }).session(session);

                        if (!unit) {
                            throw new Error(
                                `Unit not found for product ${product.name}`
                            );
                        }

                        // ------------------------------------------------
                        // Unit price
                        // ------------------------------------------------

                        const unitPrice =
                            item.unitPrice ??
                            product.sellingPrice;

                        if (
                            typeof unitPrice !== "number" ||
                            !Number.isFinite(
                                unitPrice
                            ) ||
                            unitPrice < 0
                        ) {
                            throw new Error(
                                `Invalid price for ${product.name}`
                            );
                        }

                        // ------------------------------------------------
                        // Discount
                        // ------------------------------------------------

                        const discountRate =
                            item.discountRate ?? 0;

                        if (
                            typeof discountRate !==
                            "number" ||
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
                        // Calculate gross amount
                        // ------------------------------------------------

                        const grossAmount =
                            item.quantity *
                            unitPrice;

                        // ------------------------------------------------
                        // Calculate discount
                        // ------------------------------------------------

                        const discountAmount =
                            (grossAmount *
                                discountRate) /
                            100;

                        // ------------------------------------------------
                        // Calculate taxable amount
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
                        // Add totals
                        // ------------------------------------------------

                        subtotal +=
                            grossAmount;

                        discountTotal +=
                            discountAmount;

                        taxTotal +=
                            taxAmount;

                        // ------------------------------------------------
                        // Create sale item
                        // ------------------------------------------------

                        saleItems.push({
                            productId:
                                product._id,

                            productSnapshot: {
                                name:
                                    product.name,

                                SKU:
                                    product.SKU,

                                unit:
                                    unit.shortName,
                            },

                            quantity:
                                item.quantity,

                            unitPrice,

                            discountRate,

                            discountAmount,

                            tax: {
                                rate:
                                    taxRate,

                                amount:
                                    taxAmount,
                            },

                            total:
                                lineTotal,
                        });
                    }

                    // ----------------------------------------------------
                    // 10. Additional charges
                    // ----------------------------------------------------

                    const shippingCost = 0;

                    const otherCharges = 0;

                    const roundOff = 0;

                    // ----------------------------------------------------
                    // 11. Calculate grand total
                    // ----------------------------------------------------

                    const grandTotal =
                        subtotal -
                        discountTotal +
                        taxTotal +
                        shippingCost +
                        otherCharges +
                        roundOff;

                    // ----------------------------------------------------
                    // 12. Validate paid amount
                    // ----------------------------------------------------

                    const paidAmount =
                        input.paidAmount ?? 0;

                    if (
                        typeof paidAmount !==
                        "number" ||
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
                        paidAmount >
                        grandTotal
                    ) {
                        throw new Error(
                            "Paid amount cannot exceed grandTotal"
                        );
                    }

                    // ----------------------------------------------------
                    // 13. Calculate due amount
                    // ----------------------------------------------------

                    const dueAmount =
                        grandTotal -
                        paidAmount;

                    // ----------------------------------------------------
                    // 14. Payment status
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
                        paidAmount <
                        grandTotal
                    ) {
                        paymentStatus =
                            "partial";
                    } else {
                        paymentStatus =
                            "paid";
                    }

                    // ----------------------------------------------------
                    // 15. Create sale document
                    // ----------------------------------------------------

                    const sale = new Sale({
                        tenantId:
                            user.tenantId,

                        /*
                         * IMPORTANT:
                         * Store the sync operation ID in the actual
                         * business transaction.
                         */
                        operationId:
                            normalizedOperationId,

                        invoiceNo:
                            input.invoiceNo.trim(),

                        customerId:
                            customer?._id,

                        customerSnapshot:
                            customer
                                ? {
                                    name:
                                        customer.name,

                                    phone:
                                        customer.phone,

                                    email:
                                        customer.email,
                                }
                                : undefined,

                        saleDate:
                            input.saleDate ??
                            new Date(),

                        warehouse: {
                            name:
                                input.warehouse.name.trim(),

                            location:
                                input.warehouse.location?.trim(),
                        },

                        items:
                            saleItems,

                        subtotal,

                        discountTotal,

                        taxTotal,

                        shippingCost,

                        otherCharges,

                        roundOff,

                        grandTotal,

                        paidAmount,

                        dueAmount,

                        paymentStatus,

                        paymentMethod:
                            input.paymentMethod,

                        status:
                            "completed",

                        notes:
                            input.notes,

                        createdBy:
                            user.userId,
                    });

                    // ----------------------------------------------------
                    // 16. Save sale
                    // ----------------------------------------------------

                    await sale.save({
                        session,
                    });

                    // ----------------------------------------------------
                    // 17. Update stock
                    // ----------------------------------------------------

                    for (
                        const item of saleItems
                    ) {
                        await StockService.changeStock(
                            user,
                            {
                                productId:
                                    item.productId.toString(),

                                // Sale decreases stock
                                quantity:
                                    -item.quantity,

                                type:
                                    "sale",

                                warehouse: {
                                    name:
                                        input.warehouse.name.trim(),

                                    location:
                                        input.warehouse.location?.trim(),
                                },

                                referenceId:
                                    sale._id.toString(),

                                reason:
                                    `Sale ${sale.invoiceNo}`,
                            },
                            session
                        );
                    }

                    // ----------------------------------------------------
                    // 18. Create ledger entries
                    // ----------------------------------------------------

                    await LedgerService.createEntries(
                        user,
                        [
                            {
                                transactionId:
                                    sale._id.toString(),

                                transactionType:
                                    "sale",

                                account:
                                    "accounts_receivable",

                                entryType:
                                    "debit",

                                amount:
                                    sale.grandTotal,

                                customerId:
                                    sale.customerId?.toString(),

                                description:
                                    `Sale receivable - ${sale.invoiceNo}`,

                                entryDate:
                                    sale.saleDate,
                            },

                            {
                                transactionId:
                                    sale._id.toString(),

                                transactionType:
                                    "sale",

                                account:
                                    "sales_revenue",

                                entryType:
                                    "credit",

                                amount:
                                    sale.grandTotal,

                                description:
                                    `Sales revenue - ${sale.invoiceNo}`,

                                entryDate:
                                    sale.saleDate,
                            },
                        ],
                        session
                    );

                    // ----------------------------------------------------
                    // 19. Store created sale
                    // ----------------------------------------------------

                    createdSale =
                        sale;
                }
            );

            return createdSale;
        } catch (error: unknown) {
            /*
             * ----------------------------------------------------------
             * CONCURRENT IDEMPOTENCY PROTECTION
             * ----------------------------------------------------------
             *
             * Two sync requests could arrive at almost exactly the
             * same time.
             *
             * Both could initially see:
             *
             *     operationId = not found
             *
             * One transaction will successfully create the Sale.
             *
             * The second transaction will hit the unique
             * tenantId + operationId index.
             *
             * After its transaction is aborted, find the already
             * committed sale and return it.
             *
             * This prevents duplicate stock/ledger processing.
             * ----------------------------------------------------------
             */

            const mongoError =
                error as
                | mongoose.mongo.MongoServerError
                | undefined;

            if (
                normalizedOperationId &&
                mongoError?.code === 11000
            ) {
                const existingOperationSale =
                    await Sale.findOne({
                        tenantId:
                            user.tenantId,

                        operationId:
                            normalizedOperationId,
                    });

                if (
                    existingOperationSale
                ) {
                    return existingOperationSale;
                }
            }

            throw error;
        } finally {
            await session.endSession();
        }
    }

    // ============================================================
    // GET ONE SALE
    // ============================================================

    static async getSale(
        user: SalesUserContext,
        saleId: string
    ) {
        // ----------------------------------------------------------
        // Validate sale ID
        // ----------------------------------------------------------

        if (
            !mongoose.isValidObjectId(
                saleId
            )
        ) {
            throw new Error(
                "Invalid sale ID"
            );
        }

        // ----------------------------------------------------------
        // Find sale
        // ----------------------------------------------------------

        const sale =
            await Sale.findOne({
                _id: saleId,
                tenantId:
                    user.tenantId,
            });

        if (!sale) {
            throw new Error(
                "Sale not found"
            );
        }

        return sale;
    }

    // ============================================================
    // GET SALES
    // ============================================================

    static async getSales(
        user: SalesUserContext,
        options?: {
            page?: number;

            limit?: number;

            customerId?: string;

            paymentStatus?:
            | "unpaid"
            | "partial"
            | "paid";

            status?:
            | "draft"
            | "completed"
            | "cancelled";
        }
    ) {
        // ----------------------------------------------------------
        // Pagination
        // ----------------------------------------------------------

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

        // ----------------------------------------------------------
        // Base filter
        // ----------------------------------------------------------

        const filter: Record<
            string,
            unknown
        > = {
            tenantId:
                user.tenantId,
        };

        // ----------------------------------------------------------
        // Customer filter
        // ----------------------------------------------------------

        if (options?.customerId) {
            if (
                !mongoose.isValidObjectId(
                    options.customerId
                )
            ) {
                throw new Error(
                    "Invalid customer ID"
                );
            }

            filter.customerId =
                new mongoose.Types.ObjectId(
                    options.customerId
                );
        }

        // ----------------------------------------------------------
        // Payment status filter
        // ----------------------------------------------------------

        if (
            options?.paymentStatus
        ) {
            filter.paymentStatus =
                options.paymentStatus;
        }

        // ----------------------------------------------------------
        // Sale status filter
        // ----------------------------------------------------------

        if (options?.status) {
            filter.status =
                options.status;
        }

        // ----------------------------------------------------------
        // Calculate pagination
        // ----------------------------------------------------------

        const skip =
            (page - 1) * limit;

        // ----------------------------------------------------------
        // Fetch sales + total
        // ----------------------------------------------------------

        const [
            sales,
            total,
        ] = await Promise.all([
            Sale.find(filter)
                .sort({
                    saleDate: -1,
                    _id: -1,
                })
                .skip(skip)
                .limit(limit)
                .lean(),

            Sale.countDocuments(
                filter
            ),
        ]);

        // ----------------------------------------------------------
        // Return result
        // ----------------------------------------------------------

        return {
            sales,

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