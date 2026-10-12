import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISyncOperation extends Document {
    tenantId: mongoose.Types.ObjectId;
    deviceId: mongoose.Types.ObjectId;

    operationId: string;

    operationType:
    | "CREATE"
    | "UPDATE"
    | "DELETE";

    entityType:
    | "Sale"
    | "Purchase"
    | "SalesReturn"
    | "PurchaseReturn"
    | "Payment"
    | "StockAdjustment"
    | "Customer"
    | "Supplier"
    | "Product";

    entityId?: mongoose.Types.ObjectId;

    payload: Record<string, unknown>;

    // User whose session uploaded the operation. Missing on legacy records.
    userId?: mongoose.Types.ObjectId;

    status:
    | "PENDING"
    | "PROCESSING"
    | "SYNCED"
    | "FAILED"
    | "NEEDS_ATTENTION"
    | "CANCELLED";

    attempts: number;

    // Processing lease: only the holder of leaseToken may finish the
    // operation; an expired lease can be reclaimed after a crash.
    leaseToken?: string;
    leaseExpiresAt?: Date;

    // Why the last attempt failed: RETRYABLE (temporary), PERMANENT
    // (business/data error) or RETRIES_EXHAUSTED.
    failureKind?: "RETRYABLE" | "PERMANENT" | "RETRIES_EXHAUSTED";

    lastAttemptAt?: Date;

    syncedAt?: Date;

    errorMessage?: string;

    createdAt: Date;
    updatedAt: Date;
}

const SyncOperationSchema = new Schema<ISyncOperation>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        deviceId: {
            type: Schema.Types.ObjectId,
            ref: "Device",
            required: true,
            index: true,
        },

        operationId: {
            type: String,
            required: true,
            trim: true,
        },

        operationType: {
            type: String,
            enum: [
                "CREATE",
                "UPDATE",
                "DELETE",
            ],
            required: true,
        },

        entityType: {
            type: String,
            enum: [
                "Sale",
                "Purchase",
                "SalesReturn",
                "PurchaseReturn",
                "Payment",
                "StockAdjustment",
                "Customer",
                "Supplier",
                "Product",
            ],
            required: true,
        },

        entityId: {
            type: Schema.Types.ObjectId,
        },

        payload: {
            type: Schema.Types.Mixed,
            required: true,
        },

        status: {
            type: String,
            enum: [
                "PENDING",
                "PROCESSING",
                "SYNCED",
                "FAILED",
                "NEEDS_ATTENTION",
                "CANCELLED",
            ],
            default: "PENDING",
            required: true,
        },

        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },

        attempts: {
            type: Number,
            default: 0,
            min: 0,
        },

        leaseToken: {
            type: String,
        },

        leaseExpiresAt: {
            type: Date,
        },

        failureKind: {
            type: String,
            enum: ["RETRYABLE", "PERMANENT", "RETRIES_EXHAUSTED"],
        },

        lastAttemptAt: {
            type: Date,
        },

        syncedAt: {
            type: Date,
        },

        errorMessage: {
            type: String,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

// operationId must be unique inside a tenant.
SyncOperationSchema.index(
    { tenantId: 1, operationId: 1 },
    { unique: true }
);

// Helps find pending/failed operations for a device.
SyncOperationSchema.index({
    tenantId: 1,
    deviceId: 1,
    status: 1,
});

// Helps retrieve synchronization history.
SyncOperationSchema.index({
    tenantId: 1,
    createdAt: -1,
});

export const SyncOperation: Model<ISyncOperation> =
    mongoose.models.SyncOperation ||
    mongoose.model<ISyncOperation>(
        "SyncOperation",
        SyncOperationSchema
    );