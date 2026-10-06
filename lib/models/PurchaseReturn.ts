import mongoose, {
    Schema,
    Document,
    Model,
} from "mongoose";

export interface IPurchaseReturn extends Document {
    tenantId: mongoose.Types.ObjectId;

    // Idempotency / Offline Sync
    operationId?: string;

    purchaseReturnNo: string;

    purchaseId: mongoose.Types.ObjectId;

    supplierId: mongoose.Types.ObjectId;

    supplierSnapshot: {
        name: string;
        supplierCode: string;
        phone?: string;
        gstin?: string;
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

const PurchaseReturnSchema =
    new Schema<IPurchaseReturn>(
        {
            // Tenant
            tenantId: {
                type: Schema.Types.ObjectId,
                ref: "Tenant",
                required: true,
                index: true,
            },

            // Idempotency / Offline Sync Operation ID
            operationId: {
                type: String,
                trim: true,
            },

            // Purchase Return Number
            purchaseReturnNo: {
                type: String,
                required: true,
                trim: true,
            },

            // Original Purchase
            purchaseId: {
                type: Schema.Types.ObjectId,
                ref: "Purchase",
                required: true,
                index: true,
            },

            // Supplier
            supplierId: {
                type: Schema.Types.ObjectId,
                ref: "Supplier",
                required: true,
                index: true,
            },

            // Supplier snapshot
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
                },

                phone: {
                    type: String,
                    trim: true,
                },

                gstin: {
                    type: String,
                    trim: true,
                },
            },

            // Return date
            returnDate: {
                type: Date,
                required: true,
                default: Date.now,
            },

            // Warehouse
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

            // Returned items
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

            // Totals
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

            // Refund
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

            // Return status
            status: {
                type: String,
                enum: [
                    "draft",
                    "completed",
                    "cancelled",
                ],
                default: "completed",
            },

            // Additional information
            reason: {
                type: String,
                trim: true,
            },

            notes: {
                type: String,
                trim: true,
            },

            // User who created the return
            createdBy: {
                type: Schema.Types.ObjectId,
                ref: "User",
            },
        },
        {
            timestamps: true,
        }
    );


// Unique purchase return number per tenant
PurchaseReturnSchema.index(
    {
        tenantId: 1,
        purchaseReturnNo: 1,
    },
    {
        unique: true,
    }
);


// Unique sync operation per tenant
// This prevents the same offline operation
// from creating multiple PurchaseReturn documents.
PurchaseReturnSchema.index(
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


// Find returns for a purchase
PurchaseReturnSchema.index({
    tenantId: 1,
    purchaseId: 1,
});


// Find returns for a supplier
PurchaseReturnSchema.index({
    tenantId: 1,
    supplierId: 1,
});


// Sort returns by date
PurchaseReturnSchema.index({
    tenantId: 1,
    returnDate: -1,
});


// Filter by status
PurchaseReturnSchema.index({
    tenantId: 1,
    status: 1,
});


export const PurchaseReturn: Model<IPurchaseReturn> =
    mongoose.models.PurchaseReturn ||
    mongoose.model<IPurchaseReturn>(
        "PurchaseReturn",
        PurchaseReturnSchema
    );