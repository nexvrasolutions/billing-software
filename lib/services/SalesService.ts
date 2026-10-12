import mongoose from "mongoose";

import { Sale } from "@/lib/models/Sale";
import { Product } from "@/lib/models/Product";
import { Customer } from "@/lib/models/Customer";
import { Unit } from "@/lib/models/Unit";
import { StockService } from "@/lib/services/StockService";
import { LedgerService } from "@/lib/services/LedgerService";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    BusinessPermissionError,
    SALE_DATE_RULES,
} from "@/lib/auth/businessPermissions";

export interface SalesUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    // Device of the authenticated session (recorded in the audit log).
    deviceId?: mongoose.Types.ObjectId;
}

/**
 * What the caller is allowed to do beyond a plain sale. Computed from the
 * user's CURRENT permissions by the caller (route or sync processing).
 * When omitted, the strictest policy applies.
 */
export interface SalePolicy {
    // sales.priceOverride: a price other than the selling price, or a discount.
    allowPriceOverride: boolean;
    // sales.backdate: a sale date older than referenceTime - maxAgeMs.
    allowBackdate: boolean;
    // Online: now. Offline sync: when the server first received the operation.
    referenceTime: Date;
    maxAgeMs: number;
}

function strictSalePolicy(): SalePolicy {
    return {
        allowPriceOverride: false,
        allowBackdate: false,
        referenceTime: new Date(),
        maxAgeMs: SALE_DATE_RULES.onlineMaxAgeMs,
    };
}

/** Sale date after the date rules; throws when the date is not allowed. */
function resolveSaleDate(
    value: unknown,
    policy: SalePolicy,
    now: Date
): { saleDate: Date; backdated: boolean } {
    if (value === undefined || value === null || value === "") {
        return { saleDate: now, backdated: false };
    }

    const saleDate =
        value instanceof Date || typeof value === "string"
            ? new Date(value)
            : new Date(Number.NaN);

    if (!Number.isFinite(saleDate.getTime())) {
        throw new Error("Invalid sale date");
    }

    // Never in the future (beyond a small clock difference), whatever the
    // user's permissions.
    if (saleDate.getTime() > now.getTime() + SALE_DATE_RULES.maxFutureMs) {
        throw new Error("Sale date cannot be in the future");
    }

    const oldestAllowed = policy.referenceTime.getTime() - policy.maxAgeMs;
    const backdated = saleDate.getTime() < oldestAllowed;

    if (backdated && !policy.allowBackdate) {
        throw new BusinessPermissionError(
            "This sale date is too far in the past; it requires the sales.backdate permission"
        );
    }

    return { saleDate, backdated };
}

/** True for a duplicate-key error on the tenant's invoice-number index. */
function isDuplicateInvoiceError(error: unknown): boolean {
    const mongoError = error as { code?: unknown; keyPattern?: Record<string, unknown> } | null;
    return mongoError?.code === 11000 && Boolean(mongoError.keyPattern?.invoiceNo);
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
        operationId?: string,
        policy: SalePolicy = strictSalePolicy()
    ) {
        const session =
            await mongoose.startSession();

        // Invoice numbers are stored upper-case and trimmed (schema), and
        // are unique per tenant (database index tenantId + invoiceNo).
        const invoiceNo =
            typeof input.invoiceNo === "string"
                ? input.invoiceNo.trim().toUpperCase()
                : "";

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

                    if (!invoiceNo) {
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
                    // 5b. Sale date rules (future dates, backdating)
                    // ----------------------------------------------------

                    const { saleDate, backdated } =
                        resolveSaleDate(
                            input.saleDate,
                            policy,
                            new Date()
                        );

                    // ----------------------------------------------------
                    // 6. Check duplicate invoice
                    // ----------------------------------------------------
                    //
                    // The unique index (tenantId + invoiceNo) also rejects
                    // a concurrent duplicate; see the catch block below.

                    const existingInvoice =
                        await Sale.findOne({
                            tenantId: user.tenantId,
                            invoiceNo,
                        }).session(session);

                    if (existingInvoice) {
                        throw new Error(
                            `Invoice ${invoiceNo} already exists`
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
                    let priceOverridden = false;

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
                        // Price override / discount permission
                        // ------------------------------------------------

                        const lineOverridesPrice =
                            Math.abs(unitPrice - product.sellingPrice) > 1e-9 ||
                            discountRate > 0;

                        if (
                            lineOverridesPrice &&
                            !policy.allowPriceOverride
                        ) {
                            throw new BusinessPermissionError(
                                `Changing the price of ${product.name} or giving a discount requires the sales.priceOverride permission`
                            );
                        }

                        priceOverridden ||= lineOverridesPrice;

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

                        invoiceNo,

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

                        saleDate,

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
                    // 18b. Audit log (same transaction: if it fails, the
                    //      sale, stock and ledger changes roll back)
                    // ----------------------------------------------------

                    await AuditLogService.createAuditLog(
                        {
                            userId: user.userId,
                            tenantId: user.tenantId,
                            deviceId: user.deviceId,
                        },
                        {
                            action: "CREATE",
                            entity: "Sale",
                            entityId: sale._id,
                            description:
                                `Sale ${sale.invoiceNo} created`,
                            newValues: {
                                invoiceNo: sale.invoiceNo,
                                saleDate: sale.saleDate,
                                grandTotal: sale.grandTotal,
                                paidAmount: sale.paidAmount,
                                paymentStatus: sale.paymentStatus,
                                itemCount: saleItems.length,
                                operationId: sale.operationId,
                                priceOverridden,
                                backdated,
                            },
                        },
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

            // A concurrent sale took this invoice number first.
            if (isDuplicateInvoiceError(error)) {
                throw new Error(
                    `Invoice ${invoiceNo} already exists`
                );
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