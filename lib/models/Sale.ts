
import mongoose, { Schema, Document, Model } from "mongoose";

/* =========================
   Sale Item
========================= */

export interface ISaleItem {
    productId: mongoose.Types.ObjectId;

    productSnapshot: {
        name: string;
        SKU: string;
        unit: string;
    };

    quantity: number;

    unitPrice: number;

    discountRate: number;
    discountAmount: number;

    tax: {
        rate: number;
        amount: number;
    };

    total: number;
}

/* =========================
   Sale
========================= */

export interface ISale extends Document {
    tenantId: mongoose.Types.ObjectId;

    // Used for offline-sync idempotency
    operationId?: string;

    invoiceNo: string;

    customerId?: mongoose.Types.ObjectId;

    customerSnapshot?: {
        name: string;
        phone?: string;
        email?: string;
    };

    saleDate: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: ISaleItem[];

    subtotal: number;

    discountTotal: number;

    taxTotal: number;

    shippingCost: number;

    otherCharges: number;

    roundOff: number;

    grandTotal: number;

    paidAmount: number;

    dueAmount: number;

    paymentStatus: "unpaid" | "partial" | "paid";

    paymentMethod?:
    | "cash"
    | "bank"
    | "upi"
    | "card"
    | "credit";

    status: "draft" | "completed" | "cancelled";

    notes?: string;

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

/* =========================
   Sale Item Schema
========================= */

const SaleItemSchema = new Schema<ISaleItem>(
    {
        productId: {
            type: Schema.Types.ObjectId,
            ref: "Product",
            required: true,
        },

        productSnapshot: {
            name: {
                type: String,
                required: true,
                trim: true,
            },

            SKU: {
                type: String,
                required: true,
                trim: true,
                uppercase: true,
            },

            unit: {
                type: String,
                required: true,
                trim: true,
            },
        },

        quantity: {
            type: Number,
            required: true,
            min: 0.001,
        },

        unitPrice: {
            type: Number,
            required: true,
            min: 0,
        },

        discountRate: {
            type: Number,
            default: 0,
            min: 0,
        },

        discountAmount: {
            type: Number,
            default: 0,
            min: 0,
        },

        tax: {
            rate: {
                type: Number,
                default: 0,
                min: 0,
            },

            amount: {
                type: Number,
                default: 0,
                min: 0,
            },
        },

        total: {
            type: Number,
            required: true,
            min: 0,
        },
    },
    {
        _id: false,
    }
);

/* =========================
   Sale Schema
========================= */

const SaleSchema = new Schema<ISale>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        // Used to identify the exact offline operation
        // and prevent duplicate processing during retries.
        operationId: {
            type: String,
            trim: true,
        },

        invoiceNo: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },

        customerId: {
            type: Schema.Types.ObjectId,
            ref: "Customer",
            index: true,
        },

        customerSnapshot: {
            name: {
                type: String,
                trim: true,
            },

            phone: {
                type: String,
                trim: true,
            },

            email: {
                type: String,
                trim: true,
                lowercase: true,
            },
        },

        saleDate: {
            type: Date,
            required: true,
            default: Date.now,
            index: true,
        },

        warehouse: {
            name: {
                type: String,
                required: true,
                trim: true,
            },

            location: {
                type: String,
                trim: true,
            },
        },

        items: {
            type: [SaleItemSchema],
            required: true,
            validate: {
                validator: (items: ISaleItem[]) => items.length > 0,
                message: "Sale must contain at least one item",
            },
        },

        subtotal: {
            type: Number,
            required: true,
            min: 0,
        },

        discountTotal: {
            type: Number,
            default: 0,
            min: 0,
        },

        taxTotal: {
            type: Number,
            default: 0,
            min: 0,
        },

        shippingCost: {
            type: Number,
            default: 0,
            min: 0,
        },

        otherCharges: {
            type: Number,
            default: 0,
            min: 0,
        },

        roundOff: {
            type: Number,
            default: 0,
        },

        grandTotal: {
            type: Number,
            required: true,
            min: 0,
        },

        paidAmount: {
            type: Number,
            default: 0,
            min: 0,
        },

        dueAmount: {
            type: Number,
            default: 0,
            min: 0,
        },

        paymentStatus: {
            type: String,
            enum: ["unpaid", "partial", "paid"],
            default: "unpaid",
            index: true,
        },

        paymentMethod: {
            type: String,
            enum: ["cash", "bank", "upi", "card", "credit"],
        },

        status: {
            type: String,
            enum: ["draft", "completed", "cancelled"],
            default: "draft",
            index: true,
        },

        notes: {
            type: String,
            trim: true,
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

/* =========================
   Indexes
========================= */

// Each invoice number must be unique inside a tenant.
// Matches the existing database index "tenantId_1_invoiceNo_1" exactly.
SaleSchema.index(
    {
        tenantId: 1,
        invoiceNo: 1,
    },
    {
        unique: true,
    }
);

// Each offline operation can be processed only once inside a tenant.
// The partial filter allows online sales without an operationId.
// Matches the existing database index "tenantId_1_operationId_1" exactly.
SaleSchema.index(
    {
        tenantId: 1,
        operationId: 1,
    },
    {
        unique: true,
        partialFilterExpression: {
            operationId: {
                $exists: true,
            },
        },
    }
);

SaleSchema.index({
    tenantId: 1,
    customerId: 1,
});

SaleSchema.index({
    tenantId: 1,
    saleDate: -1,
});

SaleSchema.index({
    tenantId: 1,
    paymentStatus: 1,
});

SaleSchema.index({
    tenantId: 1,
    status: 1,
});

/* =========================
   Model
========================= */

export const Sale: Model<ISale> =
    mongoose.models.Sale ||
    mongoose.model<ISale>("Sale", SaleSchema);
