import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITenant extends Document {
    name: string;
    businessType?: string;

    status: "active" | "inactive";

    // The verified business owner. Only the owner may grant
    // administrator-level roles. Set only by a server-side script
    // (scripts/designate-tenant-owner.ts), never by an API request.
    ownerUserId?: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

const TenantSchema = new Schema<ITenant>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },

        businessType: {
            type: String,
            trim: true,
        },

        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },

        ownerUserId: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
    },
    {
        timestamps: true,
    }
);

export const Tenant: Model<ITenant> =
    mongoose.models.Tenant ||
    mongoose.model<ITenant>("Tenant", TenantSchema);