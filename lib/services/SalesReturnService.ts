import mongoose, {
    Schema,
    Document,
    Model,
} from "mongoose";

export interface ISalesReturn extends Document {
    tenantId: mongoose.Types.ObjectId;

    // Idempotency / Offline Sync
    operationId?: string;

    salesReturnNo: string;

    saleId: mongoose.Types.ObjectId;

    customerId?: mongoose.Types.ObjectId;

    customerSnapshot: {
        name: string;
        phone?: string;
        email?: string;
    };

    returnDate: Date;

    warehouse: {
        name: string;
        location?: string;
    };

    items: {
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
    }[];

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

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

const SalesReturnSchema =
    new Schema<ISalesReturn>(
        {
            tenantId: {
                type: Schema.Types.ObjectId,
                ref: "Tenant",
                required: true,
                index: true,
            },

            // =================================================
            // IDEMPOTENCY / OFFLINE SYNC
            // =================================================

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
                index: true,
            },

            customerId: {
                type: Schema.Types.ObjectId,
                ref: "Customer",
                index: true,
            },

            customerSnapshot: {
                name: {
                    type: String,
                    required: true,
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

            items: [
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
                        default: 0,
                        min: 0,
                        max: 100,
                    },

                    discountAmount: {
                        type: Number,
                        required: true,
                        default: 0,
                        min: 0,
                    },

                    tax: {
                        rate: {
                            type: Number,
                            required: true,
                            default: 0,
                            min: 0,
                        },

                        amount: {
                            type: Number,
                            required: true,
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
            ],

            subtotal: {
                type: Number,
                required: true,
                min: 0,
            },

            discountTotal: {
                type: Number,
                required: true,
                default: 0,
                min: 0,
            },

            taxTotal: {
                type: Number,
                required: true,
                default: 0,
                min: 0,
            },

            shippingCost: {
                type: Number,
                required: true,
                default: 0,
                min: 0,
            },

            grandTotal: {
                type: Number,
                required: true,
                min: 0,
            },

            refundAmount: {
                type: Number,
                required: true,
                default: 0,
                min: 0,
            },

            refundStatus: {
                type: String,
                enum: [
                    "pending",
                    "refunded",
                    "not_applicable",
                ],
                default: "not_applicable",
            },

            status: {
                type: String,
                enum: [
                    "draft",
                    "completed",
                    "cancelled",
                ],
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
            },
        },
        {
            timestamps: true,
        }
    );

// =========================================================
// Unique sales return number per tenant
// =========================================================

SalesReturnSchema.index(
    {
        tenantId: 1,
        salesReturnNo: 1,
    },
    {
        unique: true,
    }
);

// =========================================================
// Unique operation ID per tenant
// =========================================================
//
// Same operationId cannot create two SalesReturns
// inside the same tenant.
//
// Partial index allows old/online SalesReturns that
// don't have an operationId.
//

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

SalesReturnSchema.index({
    tenantId: 1,
    saleId: 1,
});

SalesReturnSchema.index({
    tenantId: 1,
    customerId: 1,
});

SalesReturnSchema.index({
    tenantId: 1,
    returnDate: -1,
});

SalesReturnSchema.index({
    tenantId: 1,
    status: 1,
});

export const SalesReturn: Model<ISalesReturn> =
    mongoose.models.SalesReturn ||
    mongoose.model<ISalesReturn>(
        "SalesReturn",
        SalesReturnSchema
    );