import mongoose, { Schema, Document, Model } from "mongoose";

/* =========================
   Stock Movement
========================= */

export interface IStockMovement extends Document {
    tenantId: mongoose.Types.ObjectId;

    productId: mongoose.Types.ObjectId;

    type:
    | "purchase"
    | "sale"
    | "purchase_return"
    | "sales_return"
    | "adjustment";

    quantity: number;

    referenceId?: mongoose.Types.ObjectId;

    previousStock: number;
    newStock: number;

    warehouse: {
        name: string;
        location?: string;
    };

    reason?: string;

    createdBy?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

/* =========================
   Stock Movement Schema
========================= */

const StockMovementSchema = new Schema<IStockMovement>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        productId: {
            type: Schema.Types.ObjectId,
            ref: "Product",
            required: true,
            index: true,
        },

        type: {
            type: String,
            enum: [
                "purchase",
                "sale",
                "purchase_return",
                "sales_return",
                "adjustment",
            ],
            required: true,
            index: true,
        },

        quantity: {
            type: Number,
            required: true,
        },

        referenceId: {
            type: Schema.Types.ObjectId,
        },

        previousStock: {
            type: Number,
            required: true,
            min: 0,
        },

        newStock: {
            type: Number,
            required: true,
            min: 0,
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

        reason: {
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

/*
 * Find all stock movements
 * for a particular product.
 */
StockMovementSchema.index({
    tenantId: 1,
    productId: 1,
    createdAt: -1,
});


/*
 * Find movements by type.
 */
StockMovementSchema.index({
    tenantId: 1,
    type: 1,
    createdAt: -1,
});


/*
 * Find movements created by a user.
 */
StockMovementSchema.index({
    tenantId: 1,
    createdBy: 1,
});


export const StockMovement: Model<IStockMovement> =
    mongoose.models.StockMovement ||
    mongoose.model<IStockMovement>(
        "StockMovement",
        StockMovementSchema
    );