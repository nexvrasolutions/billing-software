import mongoose, {
    Schema,
    Document,
    Model,
} from "mongoose";

/* =========================
   Stock Movement
========================= */

export interface IStockMovement extends Document {
    tenantId: mongoose.Types.ObjectId;

    productId: mongoose.Types.ObjectId;

    /**
     * Idempotency key used mainly
     * for offline stock adjustments.
     *
     * Same operationId must not
     * create another stock movement
     * for the same tenant.
     */
    operationId?: string;

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

const StockMovementSchema =
    new Schema<IStockMovement>(
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

            operationId: {
                type: String,
                trim: true,
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

StockMovementSchema.index({
    tenantId: 1,
    productId: 1,
    createdAt: -1,
});

StockMovementSchema.index({
    tenantId: 1,
    type: 1,
    createdAt: -1,
});

StockMovementSchema.index({
    tenantId: 1,
    createdBy: 1,
});

/*
 * Idempotency protection.
 *
 * The same operationId can only be
 * used once within the same tenant.
 *
 * Existing movements without an
 * operationId are still allowed.
 */
StockMovementSchema.index(
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

/* =========================
   Model Handling
========================= */

/*
 * During development Next.js can keep
 * previously compiled Mongoose models
 * in memory during hot reloads.
 *
 * If the existing model does not contain
 * operationId, remove that stale model
 * and compile the current schema.
 */

let StockMovementModel: Model<IStockMovement>;

const existingModel =
    mongoose.models.StockMovement as
    | Model<IStockMovement>
    | undefined;

if (
    existingModel &&
    existingModel.schema.path("operationId")
) {
    StockMovementModel = existingModel;
} else {
    if (existingModel) {
        delete mongoose.models.StockMovement;
    }

    StockMovementModel =
        mongoose.model<IStockMovement>(
            "StockMovement",
            StockMovementSchema
        );
}

export const StockMovement =
    StockMovementModel;