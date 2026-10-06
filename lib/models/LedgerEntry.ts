import mongoose, {
    Schema,
    Document,
    Model,
} from "mongoose";

export interface ILedgerEntry extends Document {
    tenantId: mongoose.Types.ObjectId;

    transactionId: mongoose.Types.ObjectId;

    transactionType:
    | "sale"
    | "purchase"
    | "receipt"
    | "payment"
    | "sales_refund"
    | "purchase_refund";

    account:
    | "cash"
    | "bank"
    | "accounts_receivable"
    | "accounts_payable"
    | "sales_revenue"
    | "inventory"
    | "sales_return"
    | "purchase_return";

    entryType: "debit" | "credit";

    amount: number;

    customerId?: mongoose.Types.ObjectId;

    supplierId?: mongoose.Types.ObjectId;

    referenceId?: mongoose.Types.ObjectId;

    description?: string;

    entryDate: Date;

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

const LedgerEntrySchema = new Schema<ILedgerEntry>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        transactionId: {
            type: Schema.Types.ObjectId,
            required: true,
            index: true,
        },

        transactionType: {
            type: String,
            enum: [
                "sale",
                "purchase",
                "receipt",
                "payment",
                "sales_refund",
                "purchase_refund",
            ],
            required: true,
            index: true,
        },

        account: {
            type: String,
            enum: [
                "cash",
                "bank",
                "accounts_receivable",
                "accounts_payable",
                "sales_revenue",
                "inventory",
                "sales_return",
                "purchase_return",
            ],
            required: true,
            index: true,
        },

        entryType: {
            type: String,
            enum: ["debit", "credit"],
            required: true,
        },

        amount: {
            type: Number,
            required: true,
            min: 0.01,
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

        referenceId: {
            type: Schema.Types.ObjectId,
            index: true,
        },

        description: {
            type: String,
            trim: true,
        },

        entryDate: {
            type: Date,
            required: true,
            default: Date.now,
            index: true,
        },

        createdBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

/*
 * Useful indexes
 */

LedgerEntrySchema.index({
    tenantId: 1,
    transactionId: 1,
});

LedgerEntrySchema.index({
    tenantId: 1,
    entryDate: -1,
});

LedgerEntrySchema.index({
    tenantId: 1,
    account: 1,
    entryDate: -1,
});

export const LedgerEntry: Model<ILedgerEntry> =
    mongoose.models.LedgerEntry ||
    mongoose.model<ILedgerEntry>(
        "LedgerEntry",
        LedgerEntrySchema
    );