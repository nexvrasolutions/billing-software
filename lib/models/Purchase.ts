import mongoose, { Schema, Document, Model } from "mongoose";

/* =========================
   Purchase Item
========================= */

export interface IPurchaseItem {
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
   Purchase
========================= */

export interface IPurchase extends Document {
    tenantId: mongoose.Types.ObjectId;

    // Used for offline-sync idempotency
    operationId?: string;

    purchaseNo: string;

    supplierId: mongoose.Types.ObjectId;

    supplierSnapshot: {
        name: string;
        supplierCode: string;
        phone?: string;
        gstin?: string;
    };

    purchaseDate: Date;

    supplierInvoiceNo?: string;
    supplierInvoiceDate?: Date;

    dueDate?: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: IPurchaseItem[];

    subtotal: number;
    discountTotal: number;
    taxTotal: number;
    shippingCost: number;
    grandTotal: number;

    paidAmount: number;
    dueAmount: number;

    paymentStatus: "unpaid" | "partial" | "paid";

    status: "draft" | "received" | "cancelled";

    notes?: string;

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

/* =========================
   Purchase Item Schema
========================= */

const PurchaseItemSchema = new Schema<IPurchaseItem>(
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

        // Discount percentage
        discountRate: {
            type: Number,
            default: 0,
            min: 0,
            max: 100,
        },

        // Actual discount amount in currency
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
   Purchase Schema
========================= */

const PurchaseSchema = new Schema<IPurchase>(
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

        purchaseNo: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },

        supplierId: {
            type: Schema.Types.ObjectId,
            ref: "Supplier",
            required: true,
            index: true,
        },

        supplierSnapshot: {
            name: {
                type: String,
                required: true,
                trim: true,
            },

            supplierCode: {
                type: String,
                required: true,
                trim: true,
                uppercase: true,
            },

            phone: {
                type: String,
                trim: true,
            },

            gstin: {
                type: String,
                trim: true,
                uppercase: true,
            },
        },

        purchaseDate: {
            type: Date,
            required: true,
            default: Date.now,
        },

        supplierInvoiceNo: {
            type: String,
            trim: true,
        },

        supplierInvoiceDate: {
            type: Date,
        },

        dueDate: {
            type: Date,
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
            type: [PurchaseItemSchema],
            required: true,

            validate: {
                validator: function (items: IPurchaseItem[]) {
                    return items.length > 0;
                },
                message: "Purchase must contain at least one item",
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
        },

        status: {
            type: String,
            enum: ["draft", "received", "cancelled"],
            default: "draft",
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

// Purchase number unique for each tenant
PurchaseSchema.index(
    {
        tenantId: 1,
        purchaseNo: 1,
    },
    {
        unique: true,
    }
);

// Each offline operation can be processed only once
// inside a tenant.
//
// Partial unique index allows normal online purchases
// that do not have an operationId.
PurchaseSchema.index(
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

// Find purchases by supplier
PurchaseSchema.index({
    tenantId: 1,
    supplierId: 1,
});

// Find purchases by date
PurchaseSchema.index({
    tenantId: 1,
    purchaseDate: -1,
});

// Find unpaid / partial purchases
PurchaseSchema.index({
    tenantId: 1,
    paymentStatus: 1,
});

/* =========================
   Model
========================= */

export const Purchase: Model<IPurchase> =
    mongoose.models.Purchase ||
    mongoose.model<IPurchase>("Purchase", PurchaseSchema);