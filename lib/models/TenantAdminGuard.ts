
import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITenantAdminGuard extends Document {
    tenantId: mongoose.Types.ObjectId;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
}

const TenantAdminGuardSchema = new Schema<ITenantAdminGuard>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
        },
        revision: {
            type: Number,
            default: 0,
            required: true,
        },
    },
    { timestamps: true }
);

TenantAdminGuardSchema.index(
    { tenantId: 1 },
    { unique: true }
);

export const TenantAdminGuard: Model<ITenantAdminGuard> =
    mongoose.models.TenantAdminGuard ||
    mongoose.model<ITenantAdminGuard>(
        "TenantAdminGuard",
        TenantAdminGuardSchema
    );
