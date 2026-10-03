import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITenant extends Document {
    name: string;
    businessType?: string;

    status: "active" | "inactive";

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
    },
    {
        timestamps: true,
    }
);

export const Tenant: Model<ITenant> =
    mongoose.models.Tenant ||
    mongoose.model<ITenant>("Tenant", TenantSchema);