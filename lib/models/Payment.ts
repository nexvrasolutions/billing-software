import mongoose, {
    Schema,
    Document,
    Model,
} from "mongoose";

export interface IPayment extends Document {
    tenantId: mongoose.Types.ObjectId;

    /*
     * Idempotency key for offline/sync operations.
     *
     * One operationId can create only one payment
     * within a tenant.
     */
    operationId?: string;

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

    paymentDate: Date;

    customerId?: mongoose.Types.ObjectId;
    supplierId?: mongoose.Types.ObjectId;

    saleId?: mongoose.Types.ObjectId;
    purchaseId?: mongoose.Types.ObjectId;
    salesReturnId?: mongoose.Types.ObjectId;
    purchaseReturnId?: mongoose.Types.ObjectId;

    referenceNo?: string;
    notes?: string;

    status:
    | "pending"
    | "completed"
    | "failed"
    | "cancelled";

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

const PaymentSchema = new Schema<IPayment>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        /*
         * Idempotency key.
         *
         * Used mainly for offline/sync operations.
         */
        operationId: {
            type: String,
            trim: true,
        },

        paymentNo: {
            type: String,
            required: true,
            trim: true,
        },

        type: {
            type: String,
            enum: [
                "receipt",
                "payment",
                "sales_refund",
                "purchase_refund",
            ],
            required: true,
            index: true,
        },

        amount: {
            type: Number,
            required: true,
            min: 0.01,
        },

        paymentMethod: {
            type: String,
            enum: [
                "cash",
                "upi",
                "card",
                "bank",
                "credit",
                "other",
            ],
            required: true,
        },

        paymentDate: {
            type: Date,
            required: true,
            default: Date.now,
        },

        customerId: {
            type: Schema.Types.ObjectId,
            ref: "Customer",
            index: true,
        },

        supplierId: {
            type: Schema.Types.ObjectId,
            ref: "Supplier",
            index: true,
        },

        saleId: {
            type: Schema.Types.ObjectId,
            ref: "Sale",
            index: true,
        },

        purchaseId: {
            type: Schema.Types.ObjectId,
            ref: "Purchase",
            index: true,
        },

        salesReturnId: {
            type: Schema.Types.ObjectId,
            ref: "SalesReturn",
            index: true,
        },

        purchaseReturnId: {
            type: Schema.Types.ObjectId,
            ref: "PurchaseReturn",
            index: true,
        },

        referenceNo: {
            type: String,
            trim: true,
        },

        notes: {
            type: String,
            trim: true,
        },

        status: {
            type: String,
            enum: [
                "pending",
                "completed",
                "failed",
                "cancelled",
            ],
            default: "completed",
            index: true,
        },

        createdBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
    },
    {
        timestamps: true,
    }
);

/*
 * Payment number must be unique
 * within each tenant.
 */
PaymentSchema.index(
    { tenantId: 1, paymentNo: 1 },
    { unique: true }
);

/*
 * Idempotency protection.
 *
 * If operationId exists:
 *
 * tenant A + OP-001 → allowed
 * tenant A + OP-001 → duplicate
 *
 * tenant B + OP-001 → allowed
 *
 * This allows the same operationId to exist
 * in different tenants.
 */
PaymentSchema.index(
    { tenantId: 1, operationId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            operationId: {
                $exists: true,
            },
        },
    }
);

/*
 * Useful for payment reports
 * such as daily/monthly collections.
 */
PaymentSchema.index({
    tenantId: 1,
    paymentDate: -1,
});

/*
 * Useful for filtering payments
 * by method.
 */
PaymentSchema.index({
    tenantId: 1,
    paymentMethod: 1,
});

/*
 * Useful for finding customer
 * payment history.
 */
PaymentSchema.index({
    tenantId: 1,
    customerId: 1,
    paymentDate: -1,
});

/*
 * Useful for finding supplier
 * payment history.
 */
PaymentSchema.index({
    tenantId: 1,
    supplierId: 1,
    paymentDate: -1,
});

export const Payment: Model<IPayment> =
    mongoose.models.Payment ||
    mongoose.model<IPayment>(
        "Payment",
        PaymentSchema
    );