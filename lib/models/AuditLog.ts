import mongoose, { Schema, Document, Model } from "mongoose";

export interface IAuditLog extends Document {
    tenantId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    deviceId?: mongoose.Types.ObjectId;

    action: string;

    entity: string;
    entityId?: mongoose.Types.ObjectId;

    description?: string;

    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;

    createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        deviceId: {
            type: Schema.Types.ObjectId,
            ref: "Device",
            index: true,
        },

        action: {
            type: String,
            required: true,
            trim: true,
        },

        entity: {
            type: String,
            required: true,
            trim: true,
        },

        entityId: {
            type: Schema.Types.ObjectId,
            index: true,
        },

        description: {
            type: String,
            trim: true,
        },

        oldValues: {
            type: Schema.Types.Mixed,
        },

        newValues: {
            type: Schema.Types.Mixed,
        },
    },
    {
        timestamps: {
            createdAt: true,
            updatedAt: false,
        },
    }
);

AuditLogSchema.index({
    tenantId: 1,
    createdAt: -1,
});

export const AuditLog: Model<IAuditLog> =
    mongoose.models.AuditLog ||
    mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);