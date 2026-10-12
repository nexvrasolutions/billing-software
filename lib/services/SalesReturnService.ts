import mongoose from "mongoose";

import {
    Sale,
} from "@/lib/models/Sale";

import {
    SalesReturn,
    ISalesReturn,
} from "@/lib/models/SalesReturn";

import {
    Product,
} from "@/lib/models/Product";

import {
    Unit,
} from "@/lib/models/Unit";

import {
    StockService,
} from "@/lib/services/StockService";

import {
    AuditLogService,
} from "@/lib/services/AuditLogService";

/* =========================================================
   TYPES
========================================================= */

export interface SalesReturnUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

export interface SalesReturnItemInput {
    productId: string;
    quantity: number;
}

export interface CreateSalesReturnInput {
    salesReturnNo: string;

    saleId: string;

    customerId?: string;

    returnDate?: string | Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: SalesReturnItemInput[];

    refundAmount?: number;

    refundStatus?:
    | "pending"
    | "refunded"
    | "not_applicable";

    reason?: string;

    notes?: string;
}

/* =========================================================
   SERVICE
========================================================= */

export class SalesReturnService {

    /* =====================================================
       CREATE SALES RETURN
    ===================================================== */

    static async createSalesReturn(
        user: SalesReturnUserContext,
        input: CreateSalesReturnInput,
        operationId?: string
    ) {

        /* =================================================
           1. VALIDATE USER
        ================================================= */

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

        /* =================================================
           2. NORMALIZE OPERATION ID
        ================================================= */

        const normalizedOperationId =
            operationId?.trim() || undefined;

        /* =================================================
           3. FIRST IDEMPOTENCY CHECK
        ================================================= */

        if (normalizedOperationId) {

            const existingByOperation =
                await SalesReturn.findOne({
                    tenantId:
                        user.tenantId,

                    operationId:
                        normalizedOperationId,
                });

            if (existingByOperation) {
                return existingByOperation;
            }
        }

        /* =================================================
           4. VALIDATE SALES RETURN NUMBER
        ================================================= */

        if (!input.salesReturnNo?.trim()) {
            throw new Error(
                "Sales return number is required"
            );
        }

        /* =================================================
           5. VALIDATE SALE ID
        ================================================= */

        if (
            !mongoose.isValidObjectId(
                input.saleId
            )
        ) {
            throw new Error(
                "Invalid sale ID"
            );
        }

        /* =================================================
           6. VALIDATE WAREHOUSE
        ================================================= */

        if (
            !input.warehouse?.name?.trim()
        ) {
            throw new Error(
                "Warehouse name is required"
            );
        }

        /* =================================================
           7. VALIDATE ITEMS
        ================================================= */

        if (
            !Array.isArray(input.items) ||
            input.items.length === 0
        ) {
            throw new Error(
                "At least one return item is required"
            );
        }

        /* =================================================
           8. CHECK DUPLICATE RETURN NUMBER
        ================================================= */

        const existingReturn =
            await SalesReturn.findOne({
                tenantId:
                    user.tenantId,

                salesReturnNo:
                    input.salesReturnNo.trim(),
            });

        if (existingReturn) {
            throw new Error(
                "Sales return number already exists"
            );
        }

        /* =================================================
           9. FIND ORIGINAL SALE
        ================================================= */

        const sale =
            await Sale.findOne({
                _id:
                    input.saleId,

                tenantId:
                    user.tenantId,

                status:
                    "completed",
            });

        if (!sale) {
            throw new Error(
                "Original sale not found or not completed"
            );
        }

        /* =================================================
           10. VALIDATE CUSTOMER
        ================================================= */

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

            if (
                !sale.customerId ||
                sale.customerId.toString() !==
                input.customerId
            ) {
                throw new Error(
                    "Customer does not match the original sale"
                );
            }
        }

        /* =================================================
           11. FIND PREVIOUS RETURNS
        ================================================= */

        const previousReturns =
            await SalesReturn.find({
                tenantId:
                    user.tenantId,

                saleId:
                    sale._id,

                status:
                    "completed",
            }).lean();

        /* =================================================
           12. CALCULATE RETURNED QUANTITY
        ================================================= */

        const alreadyReturnedMap =
            new Map<string, number>();

        for (
            const previousReturn
            of previousReturns
        ) {

            for (
                const item
                of previousReturn.items
            ) {

                const productId =
                    item.productId.toString();

                const current =
                    alreadyReturnedMap.get(
                        productId
                    ) ?? 0;

                alreadyReturnedMap.set(
                    productId,
                    current +
                    item.quantity
                );
            }
        }

        /* =================================================
           13. VALIDATE CURRENT ITEMS
        ================================================= */

        const currentProductIds =
            new Set<string>();

        for (
            const item
            of input.items
        ) {

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
                typeof item.quantity !==
                "number" ||
                !Number.isFinite(
                    item.quantity
                ) ||
                item.quantity <= 0
            ) {
                throw new Error(
                    "Return quantity must be greater than zero"
                );
            }

            if (
                currentProductIds.has(
                    item.productId
                )
            ) {
                throw new Error(
                    `Product ${item.productId} appears more than once`
                );
            }

            currentProductIds.add(
                item.productId
            );
        }

        /* =================================================
           14. PREPARE RETURN ITEMS
        ================================================= */

        const returnItems: ISalesReturn["items"] =
            [];

        for (
            const inputItem
            of input.items
        ) {

            /* ---------------------------------------------
               Find product in original sale
            --------------------------------------------- */

            const saleItem =
                sale.items.find(
                    (item) =>
                        item.productId.toString() ===
                        inputItem.productId
                );

            if (!saleItem) {
                throw new Error(
                    `Product ${inputItem.productId} was not part of the original sale`
                );
            }

            /* ---------------------------------------------
               Previously returned quantity
            --------------------------------------------- */

            const previouslyReturned =
                alreadyReturnedMap.get(
                    inputItem.productId
                ) ?? 0;

            /* ---------------------------------------------
               Available quantity
            --------------------------------------------- */

            const availableToReturn =
                saleItem.quantity -
                previouslyReturned;

            if (
                inputItem.quantity >
                availableToReturn
            ) {
                throw new Error(
                    `Cannot return ${inputItem.quantity} units. Only ${availableToReturn} units are available to return for ${saleItem.productSnapshot.name}`
                );
            }

            /* ---------------------------------------------
               Find current product
            --------------------------------------------- */

            const product =
                await Product.findOne({
                    _id:
                        inputItem.productId,

                    tenantId:
                        user.tenantId,

                    status:
                        "active",
                });

            if (!product) {
                throw new Error(
                    `Product ${inputItem.productId} not found or inactive`
                );
            }

            /* ---------------------------------------------
               Find unit
            --------------------------------------------- */

            const unit =
                await Unit.findOne({
                    _id:
                        product.unitId,

                    tenantId:
                        user.tenantId,

                    status:
                        "active",
                });

            if (!unit) {
                throw new Error(
                    `Unit not found for product ${product.name}`
                );
            }

            /* ---------------------------------------------
               Original sale price
            --------------------------------------------- */

            const unitPrice =
                saleItem.unitPrice;

            const discountRate =
                saleItem.discountRate;

            /* ---------------------------------------------
               Gross amount
            --------------------------------------------- */

            const grossAmount =
                inputItem.quantity *
                unitPrice;

            /* ---------------------------------------------
               Discount
            --------------------------------------------- */

            const discountAmount =
                (
                    grossAmount *
                    discountRate
                ) / 100;

            /* ---------------------------------------------
               Amount after discount
            --------------------------------------------- */

            const amountAfterDiscount =
                grossAmount -
                discountAmount;

            /* ---------------------------------------------
               Tax
            --------------------------------------------- */

            const taxRate =
                saleItem.tax?.rate ??
                0;

            const taxAmount =
                (
                    amountAfterDiscount *
                    taxRate
                ) / 100;

            /* ---------------------------------------------
               Total
            --------------------------------------------- */

            const total =
                amountAfterDiscount +
                taxAmount;

            /* ---------------------------------------------
               Add item
            --------------------------------------------- */

            returnItems.push({
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
                    inputItem.quantity,

                unitPrice,

                discountRate,

                discountAmount,

                tax: {
                    rate:
                        taxRate,

                    amount:
                        taxAmount,
                },

                total,
            });
        }

        /* =================================================
           15. CALCULATE TOTALS
        ================================================= */

        const subtotal =
            returnItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    item.quantity *
                    item.unitPrice,
                0
            );

        const discountTotal =
            returnItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    item.discountAmount,
                0
            );

        const taxTotal =
            returnItems.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    item.tax.amount,
                0
            );

        const shippingCost = 0;

        /* =================================================
           16. GRAND TOTAL
        ================================================= */

        const grandTotal =
            subtotal -
            discountTotal +
            taxTotal +
            shippingCost;

        /* =================================================
           17. REFUND AMOUNT
        ================================================= */

        const refundAmount =
            input.refundAmount ??
            grandTotal;

        if (
            typeof refundAmount !==
            "number" ||
            !Number.isFinite(
                refundAmount
            ) ||
            refundAmount < 0
        ) {
            throw new Error(
                "Invalid refund amount"
            );
        }

        if (
            refundAmount >
            grandTotal
        ) {
            throw new Error(
                "Refund amount cannot exceed return total"
            );
        }

        /* =================================================
           18. REFUND STATUS
        ================================================= */

        const refundStatus =
            input.refundStatus ??
            "not_applicable";

        /* =================================================
           19. START SESSION
        ================================================= */

        const session =
            await mongoose.startSession();

        try {

            let createdReturn:
                | mongoose.HydratedDocument<ISalesReturn>
                | undefined;

            /* =================================================
               20. TRANSACTION
            ================================================= */

            await session.withTransaction(
                async () => {

                    /* -----------------------------------------
                       SECOND IDEMPOTENCY CHECK
                    ----------------------------------------- */

                    if (
                        normalizedOperationId
                    ) {

                        const existingByOperation =
                            await SalesReturn.findOne({
                                tenantId:
                                    user.tenantId,

                                operationId:
                                    normalizedOperationId,
                            }).session(
                                session
                            );

                        if (
                            existingByOperation
                        ) {

                            createdReturn =
                                existingByOperation;

                            return;
                        }
                    }

                    /* -----------------------------------------
                       CREATE SALES RETURN
                    ----------------------------------------- */

                    const result =
                        await SalesReturn.create(
                            [
                                {
                                    tenantId:
                                        user.tenantId,

                                    /*
                                     * THIS IS THE FIELD THAT
                                     * PREVIOUSLY CAUSED YOUR
                                     * TYPESCRIPT ERROR.
                                     */
                                    operationId:
                                        normalizedOperationId,

                                    salesReturnNo:
                                        input
                                            .salesReturnNo
                                            .trim(),

                                    saleId:
                                        sale._id,

                                    customerId:
                                        sale.customerId ??
                                        undefined,

                                    customerSnapshot:
                                        sale.customerSnapshot
                                            ? {
                                                name:
                                                    sale
                                                        .customerSnapshot
                                                        .name,

                                                phone:
                                                    sale
                                                        .customerSnapshot
                                                        .phone,

                                                email:
                                                    sale
                                                        .customerSnapshot
                                                        .email,
                                            }
                                            : undefined,

                                    returnDate:
                                        input.returnDate
                                            ? new Date(
                                                input.returnDate
                                            )
                                            : new Date(),

                                    warehouse: {
                                        name:
                                            input
                                                .warehouse
                                                .name
                                                .trim(),

                                        location:
                                            input
                                                .warehouse
                                                .location
                                                ?.trim(),
                                    },

                                    items:
                                        returnItems,

                                    subtotal,

                                    discountTotal,

                                    taxTotal,

                                    shippingCost,

                                    grandTotal,

                                    refundAmount,

                                    refundStatus,

                                    status:
                                        "completed",

                                    reason:
                                        input
                                            .reason
                                            ?.trim(),

                                    notes:
                                        input
                                            .notes
                                            ?.trim(),

                                    createdBy:
                                        user.userId,
                                },
                            ],
                            {
                                session,
                            }
                        );

                    /* -----------------------------------------
                       GET CREATED DOCUMENT
                    ----------------------------------------- */

                    const newReturn =
                        result[0];

                    createdReturn =
                        newReturn;

                    /* -----------------------------------------
                       INCREASE STOCK
                    ----------------------------------------- */

                    for (
                        const item
                        of input.items
                    ) {

                        await StockService.changeStock(
                            user,
                            {
                                productId:
                                    item.productId,

                                quantity:
                                    item.quantity,

                                type:
                                    "sales_return",

                                warehouse: {
                                    name:
                                        input
                                            .warehouse
                                            .name
                                            .trim(),

                                    location:
                                        input
                                            .warehouse
                                            .location
                                            ?.trim(),
                                },

                                referenceId:
                                    newReturn
                                        ._id
                                        .toString(),

                                reason:
                                    `Sales Return ${newReturn.salesReturnNo}`,
                            },
                            session
                        );
                    }

                    /* -----------------------------------------
                       AUDIT LOG
                    ----------------------------------------- */

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
                                "SalesReturn",

                            entityId:
                                newReturn._id,

                            description:
                                `Sales Return ${newReturn.salesReturnNo} created`,

                            newValues: {
                                salesReturnNo:
                                    newReturn
                                        .salesReturnNo,

                                operationId:
                                    newReturn
                                        .operationId,

                                saleId:
                                    newReturn
                                        .saleId,

                                customerId:
                                    newReturn
                                        .customerId,

                                grandTotal:
                                    newReturn
                                        .grandTotal,

                                refundAmount:
                                    newReturn
                                        .refundAmount,

                                refundStatus:
                                    newReturn
                                        .refundStatus,

                                status:
                                    newReturn
                                        .status,

                                reason:
                                    newReturn
                                        .reason,
                            },
                        },
                        session
                    );
                }
            );

            /* =================================================
               21. SAFETY CHECK
            ================================================= */

            if (!createdReturn) {
                throw new Error(
                    "Sales return creation failed"
                );
            }

            return createdReturn;

        } catch (error: unknown) {

            /* =================================================
               22. DUPLICATE OPERATION ID
            ================================================= */

            const mongoError =
                error as {
                    code?: number;
                };

            if (
                normalizedOperationId &&
                mongoError.code === 11000
            ) {

                const existingByOperation =
                    await SalesReturn.findOne({
                        tenantId:
                            user.tenantId,

                        operationId:
                            normalizedOperationId,
                    });

                if (
                    existingByOperation
                ) {
                    return existingByOperation;
                }
            }

            throw error;

        } finally {

            await session.endSession();
        }
    }

    /* =====================================================
       GET ONE SALES RETURN
    ===================================================== */

    static async getSalesReturn(
        user: SalesReturnUserContext,
        salesReturnId: string
    ) {

        if (
            !mongoose.isValidObjectId(
                salesReturnId
            )
        ) {
            throw new Error(
                "Invalid sales return ID"
            );
        }

        const salesReturn =
            await SalesReturn.findOne({
                _id:
                    salesReturnId,

                tenantId:
                    user.tenantId,
            }).lean();

        if (!salesReturn) {
            throw new Error(
                "Sales return not found"
            );
        }

        return salesReturn;
    }

    /* =====================================================
       GET SALES RETURNS
    ===================================================== */

    static async getSalesReturns(
        user: SalesReturnUserContext,
        options?: {
            saleId?: string;

            customerId?: string;

            status?:
            | "draft"
            | "completed"
            | "cancelled";

            page?: number;

            limit?: number;
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

        /* ---------------------------------------------
           Sale filter
        --------------------------------------------- */

        if (options?.saleId) {

            if (
                !mongoose.isValidObjectId(
                    options.saleId
                )
            ) {
                throw new Error(
                    "Invalid sale ID"
                );
            }

            filter.saleId =
                new mongoose.Types.ObjectId(
                    options.saleId
                );
        }

        /* ---------------------------------------------
           Customer filter
        --------------------------------------------- */

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

        /* ---------------------------------------------
           Status filter
        --------------------------------------------- */

        if (options?.status) {
            filter.status =
                options.status;
        }

        /* ---------------------------------------------
           Pagination
        --------------------------------------------- */

        const skip =
            (page - 1) *
            limit;

        /* ---------------------------------------------
           Query
        --------------------------------------------- */

        const [
            salesReturns,
            total,
        ] = await Promise.all([

            SalesReturn.find(filter)
                .sort({
                    returnDate: -1,
                    _id: -1,
                })
                .skip(skip)
                .limit(limit)
                .lean(),

            SalesReturn.countDocuments(
                filter
            ),
        ]);

        return {
            salesReturns,

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