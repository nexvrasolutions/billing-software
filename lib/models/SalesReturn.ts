import mongoose, {
    Document,
    Model,
    Schema,
} from "mongoose";

/* =========================================================
   TYPES
========================================================= */

export interface ISalesReturnItem {
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

export interface ISalesReturn extends Document {
    tenantId: mongoose.Types.ObjectId;

    /*
     * Offline synchronization idempotency key.
     *
     * Same tenant + same operationId
     * must never create two SalesReturns.
     */
    operationId?: string;

    salesReturnNo: string;

    saleId: mongoose.Types.ObjectId;

    customerId?: mongoose.Types.ObjectId;

    customerSnapshot?: {
        name?: string;
        phone?: string;
        email?: string;
    };

    returnDate: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: ISalesReturnItem[];

    subtotal: number;

    discountTotal: number;

    taxTotal: number;

    shippingCost: number;

    grandTotal: number;

    refundAmount: number;

    refundStatus:
    | "pending"
    | "refunded"
    | "not_applicable";

    status:
    | "draft"
    | "completed"
    | "cancelled";

    reason?: string;

    notes?: string;

    createdBy: mongoose.Types.ObjectId;

    createdAt: Date;

    updatedAt: Date;
}

/* =========================================================
   ITEM SCHEMA
========================================================= */

const SalesReturnItemSchema =
    new Schema<ISalesReturnItem>(
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
                min: 0.000001,
            },

            unitPrice: {
                type: Number,
                required: true,
                min: 0,
            },

            discountRate: {
                type: Number,
                required: true,
                min: 0,
                default: 0,
            },

            discountAmount: {
                type: Number,
                required: true,
                min: 0,
                default: 0,
            },

            tax: {
                rate: {
                    type: Number,
                    required: true,
                    min: 0,
                    default: 0,
                },

                amount: {
                    type: Number,
                    required: true,
                    min: 0,
                    default: 0,
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

/* =========================================================
   SALES RETURN SCHEMA
========================================================= */

const SalesReturnSchema =
    new Schema<ISalesReturn>(
        {
            tenantId: {
                type: Schema.Types.ObjectId,
                ref: "Tenant",
                required: true,
            },

            /*
             * IMPORTANT:
             *
             * This field is used by the offline sync
             * system to prevent duplicate SalesReturns.
             */
            operationId: {
                type: String,
                trim: true,
            },

            salesReturnNo: {
                type: String,
                required: true,
                trim: true,
            },

            saleId: {
                type: Schema.Types.ObjectId,
                ref: "Sale",
                required: true,
            },

            customerId: {
                type: Schema.Types.ObjectId,
                ref: "Customer",
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
                },
            },

            returnDate: {
                type: Date,
                required: true,
                default: Date.now,
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
                type: [SalesReturnItemSchema],
                required: true,

                validate: {
                    validator: (
                        value: ISalesReturnItem[]
                    ) => value.length > 0,

                    message:
                        "At least one sales return item is required",
                },
            },

            subtotal: {
                type: Number,
                required: true,
                min: 0,
            },

            discountTotal: {
                type: Number,
                required: true,
                min: 0,
                default: 0,
            },

            taxTotal: {
                type: Number,
                required: true,
                min: 0,
                default: 0,
            },

            shippingCost: {
                type: Number,
                required: true,
                min: 0,
                default: 0,
            },

            grandTotal: {
                type: Number,
                required: true,
                min: 0,
            },

            refundAmount: {
                type: Number,
                required: true,
                min: 0,
            },

            refundStatus: {
                type: String,

                enum: [
                    "pending",
                    "refunded",
                    "not_applicable",
                ],

                required: true,

                default: "not_applicable",
            },

            status: {
                type: String,

                enum: [
                    "draft",
                    "completed",
                    "cancelled",
                ],

                required: true,

                default: "completed",
            },

            reason: {
                type: String,
                trim: true,
            },

            notes: {
                type: String,
                trim: true,
            },

            createdBy: {
                type: Schema.Types.ObjectId,
                ref: "User",
                required: true,
            },
        },

        {
            timestamps: true,
        }
    );

/* =========================================================
   INDEXES
========================================================= */

/*
 * Tenant + return date
 */
SalesReturnSchema.index({
    tenantId: 1,
    returnDate: -1,
});

/*
 * Tenant + sale
 */
SalesReturnSchema.index({
    tenantId: 1,
    saleId: 1,
});

/*
 * Sales return number must be unique
 * within a tenant.
 */
SalesReturnSchema.index(
    {
        tenantId: 1,
        salesReturnNo: 1,
    },
    {
        unique: true,
    }
);

/*
 * OFFLINE IDEMPOTENCY INDEX
 *
 * Same tenant + same operationId
 * can exist only once.
 *
 * Partial index allows older online
 * SalesReturns without operationId.
 */
SalesReturnSchema.index(
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

/* =========================================================
   MODEL
========================================================= */

export const SalesReturn: Model<ISalesReturn> =
    mongoose.models.SalesReturn ||
    mongoose.model<ISalesReturn>(
        "SalesReturn",
        SalesReturnSchema
    );

export default SalesReturn;