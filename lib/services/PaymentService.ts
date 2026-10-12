
import mongoose from "mongoose";

import { Payment } from "@/lib/models/Payment";
import { Sale } from "@/lib/models/Sale";
import { Purchase } from "@/lib/models/Purchase";
import { SalesReturn } from "@/lib/models/SalesReturn";
import { PurchaseReturn } from "@/lib/models/PurchaseReturn";

import { LedgerService } from "@/lib/services/LedgerService";
import { AuditLogService } from "@/lib/services/AuditLogService";

export interface PaymentUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
}

export interface CreatePaymentInput {
    paymentNo: string;
    type:
    | "receipt"
    | "payment"
    | "sales_refund"
    | "purchase_refund";
    amount: number;
    paymentMethod:
    | "cash"
    | "upi"
    | "card"
    | "bank"
    | "credit"
    | "other";
    paymentDate?: Date | string;
    customerId?: string;
    supplierId?: string;
    saleId?: string;
    purchaseId?: string;
    salesReturnId?: string;
    purchaseReturnId?: string;
    referenceNo?: string;
    notes?: string;
    status?:
    | "pending"
    | "completed"
    | "failed"
    | "cancelled";
}

type PaymentDocument = InstanceType<typeof Payment>;

interface CreatePaymentResult {
    payment: PaymentDocument;
    sale?: {
        id: mongoose.Types.ObjectId;
        invoiceNo: string;
        grandTotal: number;
        paidAmount: number;
        dueAmount: number;
        paymentStatus: string;
    };
    purchase?: {
        id: mongoose.Types.ObjectId;
        purchaseNo: string;
        grandTotal: number;
        paidAmount: number;
        dueAmount: number;
        paymentStatus: string;
    };
    salesReturn?: {
        id: mongoose.Types.ObjectId;
        salesReturnNo: string;
        refundAmount: number;
        refundStatus: string;
    };
    purchaseReturn?: {
        id: mongoose.Types.ObjectId;
        purchaseReturnNo: string;
        refundAmount: number;
        refundStatus: string;
    };
    alreadyProcessed: boolean;
}

export class PaymentService {
    static async createPayment(
        user: PaymentUserContext,
        input: CreatePaymentInput,
        operationId?: string
    ): Promise<CreatePaymentResult> {
        const normalizedOperationId =
            operationId?.trim() || undefined;

        const session = await mongoose.startSession();

        try {
            let result: CreatePaymentResult | null = null;

            try {
                await session.withTransaction(async () => {
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

                    // Idempotency: return the existing payment
                    // if this operation has already been processed.
                    if (normalizedOperationId) {
                        const existingOperationPayment =
                            await Payment.findOne({
                                tenantId: user.tenantId,
                                operationId: normalizedOperationId,
                            }).session(session);

                        if (existingOperationPayment) {
                            result = {
                                payment: existingOperationPayment,
                                alreadyProcessed: true,
                            };

                            return;
                        }
                    }

                    if (!input.paymentNo?.trim()) {
                        throw new Error(
                            "Payment number is required"
                        );
                    }

                    const existingPayment =
                        await Payment.findOne({
                            tenantId: user.tenantId,
                            paymentNo: input.paymentNo.trim(),
                        }).session(session);

                    if (existingPayment) {
                        throw new Error(
                            `Payment ${input.paymentNo} already exists`
                        );
                    }

                    if (
                        typeof input.amount !== "number" ||
                        !Number.isFinite(input.amount) ||
                        input.amount <= 0
                    ) {
                        throw new Error(
                            "Payment amount must be greater than zero"
                        );
                    }

                    const allowedMethods = [
                        "cash",
                        "upi",
                        "card",
                        "bank",
                        "credit",
                        "other",
                    ] as const;

                    if (
                        !allowedMethods.includes(input.paymentMethod)
                    ) {
                        throw new Error("Invalid payment method");
                    }

                    const allowedTypes = [
                        "receipt",
                        "payment",
                        "sales_refund",
                        "purchase_refund",
                    ] as const;

                    if (!allowedTypes.includes(input.type)) {
                        throw new Error("Invalid payment type");
                    }

                    const status = input.status ?? "completed";

                    if (
                        input.paymentMethod === "credit" &&
                        status === "completed"
                    ) {
                        throw new Error(
                            "Credit payment cannot be completed"
                        );
                    }

                    // =====================================================
                    // RECEIPT — customer pays us
                    // =====================================================
                    if (input.type === "receipt") {
                        if (
                            !input.saleId ||
                            !mongoose.isValidObjectId(input.saleId)
                        ) {
                            throw new Error(
                                "Valid sale ID is required for receipt"
                            );
                        }

                        const sale = await Sale.findOne({
                            _id: input.saleId,
                            tenantId: user.tenantId,
                            status: "completed",
                        }).session(session);

                        if (!sale) {
                            throw new Error(
                                "Sale not found or not completed"
                            );
                        }

                        if (input.customerId) {
                            if (
                                !mongoose.isValidObjectId(
                                    input.customerId
                                )
                            ) {
                                throw new Error("Invalid customer ID");
                            }

                            if (
                                !sale.customerId ||
                                sale.customerId.toString() !==
                                input.customerId
                            ) {
                                throw new Error(
                                    "Customer does not match the sale"
                                );
                            }
                        }

                        if (
                            status === "completed" &&
                            input.amount > sale.dueAmount
                        ) {
                            throw new Error(
                                "Payment amount cannot exceed sale due amount"
                            );
                        }

                        const payment = new Payment({
                            tenantId: user.tenantId,
                            operationId: normalizedOperationId,
                            paymentNo: input.paymentNo.trim(),
                            type: "receipt",
                            amount: input.amount,
                            paymentMethod: input.paymentMethod,
                            paymentDate:
                                input.paymentDate ?? new Date(),
                            customerId: sale.customerId,
                            saleId: sale._id,
                            referenceNo: input.referenceNo,
                            notes: input.notes,
                            status,
                            createdBy: user.userId,
                        });

                        await payment.save({ session });

                        if (status === "completed") {
                            sale.paidAmount += input.amount;
                            sale.dueAmount =
                                sale.grandTotal - sale.paidAmount;

                            if (sale.dueAmount <= 0) {
                                sale.dueAmount = 0;
                                sale.paymentStatus = "paid";
                            } else {
                                sale.paymentStatus = "partial";
                            }

                            await sale.save({ session });

                            const moneyAccount =
                                input.paymentMethod === "cash"
                                    ? "cash"
                                    : "bank";

                            await LedgerService.createEntries(
                                user,
                                [
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType: "receipt",
                                        account: moneyAccount,
                                        entryType: "debit",
                                        amount: input.amount,
                                        customerId:
                                            sale.customerId?.toString(),
                                        referenceId:
                                            sale._id.toString(),
                                        description:
                                            `Receipt ${payment.paymentNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType: "receipt",
                                        account: "accounts_receivable",
                                        entryType: "credit",
                                        amount: input.amount,
                                        customerId:
                                            sale.customerId?.toString(),
                                        referenceId:
                                            sale._id.toString(),
                                        description:
                                            `Customer payment for ${sale.invoiceNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                ],
                                session
                            );
                        }

                        await AuditLogService.createAuditLog(
                            {
                                userId: user.userId,
                                tenantId: user.tenantId,
                            },
                            {
                                action: "CREATE",
                                entity: "Payment",
                                entityId: payment._id,
                                description:
                                    `Payment ${payment.paymentNo} created`,
                                newValues: {
                                    paymentNo: payment.paymentNo,
                                    type: payment.type,
                                    amount: payment.amount,
                                    paymentMethod: payment.paymentMethod,
                                    status: payment.status,
                                    operationId: payment.operationId,
                                    customerId: payment.customerId,
                                    saleId: payment.saleId,
                                    referenceNo: payment.referenceNo,
                                },
                            },
                            session
                        );

                        result = {
                            payment,
                            sale: {
                                id: sale._id,
                                invoiceNo: sale.invoiceNo,
                                grandTotal: sale.grandTotal,
                                paidAmount: sale.paidAmount,
                                dueAmount: sale.dueAmount,
                                paymentStatus: sale.paymentStatus,
                            },
                            alreadyProcessed: false,
                        };
                    }

                    // =====================================================
                    // PAYMENT — we pay supplier
                    // =====================================================
                    else if (input.type === "payment") {
                        if (
                            !input.purchaseId ||
                            !mongoose.isValidObjectId(
                                input.purchaseId
                            )
                        ) {
                            throw new Error(
                                "Valid purchase ID is required for payment"
                            );
                        }

                        const purchase = await Purchase.findOne({
                            _id: input.purchaseId,
                            tenantId: user.tenantId,
                            status: "received",
                        }).session(session);

                        if (!purchase) {
                            throw new Error(
                                "Purchase not found or not received"
                            );
                        }

                        if (input.supplierId) {
                            if (
                                !mongoose.isValidObjectId(
                                    input.supplierId
                                )
                            ) {
                                throw new Error("Invalid supplier ID");
                            }

                            if (
                                !purchase.supplierId ||
                                purchase.supplierId.toString() !==
                                input.supplierId
                            ) {
                                throw new Error(
                                    "Supplier does not match the purchase"
                                );
                            }
                        }

                        if (
                            status === "completed" &&
                            input.amount > purchase.dueAmount
                        ) {
                            throw new Error(
                                "Payment amount cannot exceed purchase due amount"
                            );
                        }

                        const payment = new Payment({
                            tenantId: user.tenantId,
                            operationId: normalizedOperationId,
                            paymentNo: input.paymentNo.trim(),
                            type: "payment",
                            amount: input.amount,
                            paymentMethod: input.paymentMethod,
                            paymentDate:
                                input.paymentDate ?? new Date(),
                            supplierId: purchase.supplierId,
                            purchaseId: purchase._id,
                            referenceNo: input.referenceNo,
                            notes: input.notes,
                            status,
                            createdBy: user.userId,
                        });

                        await payment.save({ session });

                        if (status === "completed") {
                            purchase.paidAmount += input.amount;
                            purchase.dueAmount =
                                purchase.grandTotal -
                                purchase.paidAmount;

                            if (purchase.dueAmount <= 0) {
                                purchase.dueAmount = 0;
                                purchase.paymentStatus = "paid";
                            } else {
                                purchase.paymentStatus = "partial";
                            }

                            await purchase.save({ session });

                            const moneyAccount =
                                input.paymentMethod === "cash"
                                    ? "cash"
                                    : "bank";

                            await LedgerService.createEntries(
                                user,
                                [
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType: "payment",
                                        account: "accounts_payable",
                                        entryType: "debit",
                                        amount: input.amount,
                                        supplierId:
                                            purchase.supplierId?.toString(),
                                        referenceId:
                                            purchase._id.toString(),
                                        description:
                                            `Supplier payment for ${purchase.purchaseNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType: "payment",
                                        account: moneyAccount,
                                        entryType: "credit",
                                        amount: input.amount,
                                        supplierId:
                                            purchase.supplierId?.toString(),
                                        referenceId:
                                            purchase._id.toString(),
                                        description:
                                            `Payment ${payment.paymentNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                ],
                                session
                            );
                        }

                        await AuditLogService.createAuditLog(
                            {
                                userId: user.userId,
                                tenantId: user.tenantId,
                            },
                            {
                                action: "CREATE",
                                entity: "Payment",
                                entityId: payment._id,
                                description:
                                    `Payment ${payment.paymentNo} created`,
                                newValues: {
                                    paymentNo: payment.paymentNo,
                                    type: payment.type,
                                    amount: payment.amount,
                                    paymentMethod: payment.paymentMethod,
                                    status: payment.status,
                                    operationId: payment.operationId,
                                    supplierId: payment.supplierId,
                                    purchaseId: payment.purchaseId,
                                    referenceNo: payment.referenceNo,
                                },
                            },
                            session
                        );

                        result = {
                            payment,
                            purchase: {
                                id: purchase._id,
                                purchaseNo: purchase.purchaseNo,
                                grandTotal: purchase.grandTotal,
                                paidAmount: purchase.paidAmount,
                                dueAmount: purchase.dueAmount,
                                paymentStatus: purchase.paymentStatus,
                            },
                            alreadyProcessed: false,
                        };
                    }

                    // =====================================================
                    // SALES REFUND — we refund customer
                    // =====================================================
                    else if (input.type === "sales_refund") {
                        if (
                            !input.salesReturnId ||
                            !mongoose.isValidObjectId(
                                input.salesReturnId
                            )
                        ) {
                            throw new Error(
                                "Valid sales return ID is required"
                            );
                        }

                        const salesReturn =
                            await SalesReturn.findOne({
                                _id: input.salesReturnId,
                                tenantId: user.tenantId,
                                status: "completed",
                            }).session(session);

                        if (!salesReturn) {
                            throw new Error(
                                "Sales return not found or not completed"
                            );
                        }

                        if (
                            salesReturn.refundStatus === "refunded"
                        ) {
                            throw new Error(
                                "Sales return has already been refunded"
                            );
                        }

                        if (
                            input.amount >
                            salesReturn.refundAmount
                        ) {
                            throw new Error(
                                "Refund amount cannot exceed sales return refund amount"
                            );
                        }

                        const payment = new Payment({
                            tenantId: user.tenantId,
                            operationId: normalizedOperationId,
                            paymentNo: input.paymentNo.trim(),
                            type: "sales_refund",
                            amount: input.amount,
                            paymentMethod: input.paymentMethod,
                            paymentDate:
                                input.paymentDate ?? new Date(),
                            customerId: salesReturn.customerId,
                            salesReturnId: salesReturn._id,
                            referenceNo: input.referenceNo,
                            notes: input.notes,
                            status,
                            createdBy: user.userId,
                        });

                        await payment.save({ session });

                        if (
                            status === "completed" &&
                            input.amount === salesReturn.refundAmount
                        ) {
                            salesReturn.refundStatus = "refunded";
                            await salesReturn.save({ session });

                            const moneyAccount =
                                input.paymentMethod === "cash"
                                    ? "cash"
                                    : "bank";

                            await LedgerService.createEntries(
                                user,
                                [
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType: "sales_refund",
                                        account: "sales_return",
                                        entryType: "debit",
                                        amount: input.amount,
                                        customerId:
                                            salesReturn.customerId?.toString(),
                                        referenceId:
                                            salesReturn._id.toString(),
                                        description:
                                            `Sales refund for ${salesReturn.salesReturnNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType: "sales_refund",
                                        account: moneyAccount,
                                        entryType: "credit",
                                        amount: input.amount,
                                        customerId:
                                            salesReturn.customerId?.toString(),
                                        referenceId:
                                            salesReturn._id.toString(),
                                        description:
                                            `Refund payment ${payment.paymentNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                ],
                                session
                            );
                        }

                        await AuditLogService.createAuditLog(
                            {
                                userId: user.userId,
                                tenantId: user.tenantId,
                            },
                            {
                                action: "CREATE",
                                entity: "Payment",
                                entityId: payment._id,
                                description:
                                    `Payment ${payment.paymentNo} created`,
                                newValues: {
                                    paymentNo: payment.paymentNo,
                                    type: payment.type,
                                    amount: payment.amount,
                                    paymentMethod: payment.paymentMethod,
                                    status: payment.status,
                                    operationId: payment.operationId,
                                    customerId: payment.customerId,
                                    salesReturnId:
                                        payment.salesReturnId,
                                    referenceNo: payment.referenceNo,
                                },
                            },
                            session
                        );

                        result = {
                            payment,
                            salesReturn: {
                                id: salesReturn._id,
                                salesReturnNo:
                                    salesReturn.salesReturnNo,
                                refundAmount:
                                    salesReturn.refundAmount,
                                refundStatus:
                                    salesReturn.refundStatus,
                            },
                            alreadyProcessed: false,
                        };
                    }

                    // =====================================================
                    // PURCHASE REFUND — supplier refunds us
                    // =====================================================
                    else if (input.type === "purchase_refund") {
                        if (
                            !input.purchaseReturnId ||
                            !mongoose.isValidObjectId(
                                input.purchaseReturnId
                            )
                        ) {
                            throw new Error(
                                "Valid purchase return ID is required"
                            );
                        }

                        const purchaseReturn =
                            await PurchaseReturn.findOne({
                                _id: input.purchaseReturnId,
                                tenantId: user.tenantId,
                                status: "completed",
                            }).session(session);

                        if (!purchaseReturn) {
                            throw new Error(
                                "Purchase return not found or not completed"
                            );
                        }

                        if (
                            purchaseReturn.refundStatus === "refunded"
                        ) {
                            throw new Error(
                                "Purchase return has already been refunded"
                            );
                        }

                        if (
                            input.amount >
                            purchaseReturn.refundAmount
                        ) {
                            throw new Error(
                                "Refund amount cannot exceed purchase return refund amount"
                            );
                        }

                        const payment = new Payment({
                            tenantId: user.tenantId,
                            operationId: normalizedOperationId,
                            paymentNo: input.paymentNo.trim(),
                            type: "purchase_refund",
                            amount: input.amount,
                            paymentMethod: input.paymentMethod,
                            paymentDate:
                                input.paymentDate ?? new Date(),
                            supplierId: purchaseReturn.supplierId,
                            purchaseReturnId: purchaseReturn._id,
                            referenceNo: input.referenceNo,
                            notes: input.notes,
                            status,
                            createdBy: user.userId,
                        });

                        await payment.save({ session });

                        if (
                            status === "completed" &&
                            input.amount ===
                            purchaseReturn.refundAmount
                        ) {
                            purchaseReturn.refundStatus = "refunded";
                            await purchaseReturn.save({ session });

                            const moneyAccount =
                                input.paymentMethod === "cash"
                                    ? "cash"
                                    : "bank";

                            await LedgerService.createEntries(
                                user,
                                [
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType:
                                            "purchase_refund",
                                        account: moneyAccount,
                                        entryType: "debit",
                                        amount: input.amount,
                                        supplierId:
                                            purchaseReturn.supplierId?.toString(),
                                        referenceId:
                                            purchaseReturn._id.toString(),
                                        description:
                                            `Purchase refund for ${purchaseReturn.purchaseReturnNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                    {
                                        transactionId:
                                            payment._id.toString(),
                                        transactionType:
                                            "purchase_refund",
                                        account: "purchase_return",
                                        entryType: "credit",
                                        amount: input.amount,
                                        supplierId:
                                            purchaseReturn.supplierId?.toString(),
                                        referenceId:
                                            purchaseReturn._id.toString(),
                                        description:
                                            `Refund payment ${payment.paymentNo}`,
                                        entryDate: payment.paymentDate,
                                    },
                                ],
                                session
                            );
                        }

                        await AuditLogService.createAuditLog(
                            {
                                userId: user.userId,
                                tenantId: user.tenantId,
                            },
                            {
                                action: "CREATE",
                                entity: "Payment",
                                entityId: payment._id,
                                description:
                                    `Payment ${payment.paymentNo} created`,
                                newValues: {
                                    paymentNo: payment.paymentNo,
                                    type: payment.type,
                                    amount: payment.amount,
                                    paymentMethod: payment.paymentMethod,
                                    status: payment.status,
                                    operationId: payment.operationId,
                                    supplierId: payment.supplierId,
                                    purchaseReturnId:
                                        payment.purchaseReturnId,
                                    referenceNo: payment.referenceNo,
                                },
                            },
                            session
                        );

                        result = {
                            payment,
                            purchaseReturn: {
                                id: purchaseReturn._id,
                                purchaseReturnNo:
                                    purchaseReturn.purchaseReturnNo,
                                refundAmount:
                                    purchaseReturn.refundAmount,
                                refundStatus:
                                    purchaseReturn.refundStatus,
                            },
                            alreadyProcessed: false,
                        };
                    }
                });

                if (!result) {
                    throw new Error(
                        "Payment operation did not return a result"
                    );
                }

                return result;
            } catch (error: unknown) {
                const isDuplicateKeyError =
                    typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    error.code === 11000;

                if (
                    normalizedOperationId &&
                    isDuplicateKeyError
                ) {
                    const existingPayment =
                        await Payment.findOne({
                            tenantId: user.tenantId,
                            operationId: normalizedOperationId,
                        });

                    if (existingPayment) {
                        return {
                            payment: existingPayment,
                            alreadyProcessed: true,
                        };
                    }
                }

                throw error;
            }
        } finally {
            await session.endSession();
        }
    }

    static async getPayment(
        user: PaymentUserContext,
        paymentId: string
    ) {
        if (!mongoose.isValidObjectId(paymentId)) {
            throw new Error("Invalid payment ID");
        }

        const payment = await Payment.findOne({
            _id: paymentId,
            tenantId: user.tenantId,
        });

        if (!payment) {
            throw new Error("Payment not found");
        }

        return payment;
    }

    static async getPayments(
        user: PaymentUserContext,
        options?: {
            page?: number;
            limit?: number;
            type?:
            | "receipt"
            | "payment"
            | "sales_refund"
            | "purchase_refund";
            status?:
            | "pending"
            | "completed"
            | "failed"
            | "cancelled";
            paymentMethod?:
            | "cash"
            | "upi"
            | "card"
            | "bank"
            | "credit"
            | "other";
            customerId?: string;
            supplierId?: string;
        }
    ) {
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

        const page = Math.max(
            options?.page ?? 1,
            1
        );

        const limit = Math.min(
            Math.max(options?.limit ?? 20, 1),
            100
        );

        const filter: Record<string, unknown> = {
            tenantId: user.tenantId,
        };

        if (options?.type) {
            filter.type = options.type;
        }

        if (options?.status) {
            filter.status = options.status;
        }

        if (options?.paymentMethod) {
            filter.paymentMethod = options.paymentMethod;
        }

        if (options?.customerId) {
            if (
                !mongoose.isValidObjectId(
                    options.customerId
                )
            ) {
                throw new Error("Invalid customer ID");
            }

            filter.customerId =
                new mongoose.Types.ObjectId(
                    options.customerId
                );
        }

        if (options?.supplierId) {
            if (
                !mongoose.isValidObjectId(
                    options.supplierId
                )
            ) {
                throw new Error("Invalid supplier ID");
            }

            filter.supplierId =
                new mongoose.Types.ObjectId(
                    options.supplierId
                );
        }

        const skip = (page - 1) * limit;

        const [payments, total] = await Promise.all([
            Payment.find(filter)
                .sort({
                    paymentDate: -1,
                    _id: -1,
                })
                .skip(skip)
                .limit(limit)
                .lean(),

            Payment.countDocuments(filter),
        ]);

        return {
            payments,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }
}