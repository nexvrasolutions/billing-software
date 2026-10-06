import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITax extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    code: string;
    type: "GST" | "IGST" | "CGST" | "SGST" | "CESS" | "OTHER";
    rate: number;

    description?: string;
    status: "active" | "inactive";

    createdBy: mongoose.Types.ObjectId;

    createdAt: Date;
    updatedAt: Date;
}

const TaxSchema = new Schema<ITax>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        name: {
            type: String,
            required: true,
            trim: true,
        },

        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },

        type: {
            type: String,
            enum: ["GST", "IGST", "CGST", "SGST", "CESS", "OTHER"],
            required: true,
        },

        rate: {
            type: Number,
            required: true,
            min: 0,
            max: 100,
        },

        description: {
            type: String,
            trim: true,
        },

        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
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

/*
 * A tax code must be unique within a tenant.
 *
 * Example:
 *
 * Tenant A → GST5
 * Tenant B → GST5
 *
 * Both are allowed because they belong to different tenants.
 */
TaxSchema.index(
    { tenantId: 1, code: 1 },
    { unique: true }
);

export const Tax: Model<ITax> =
    mongoose.models.Tax ||
    mongoose.model<ITax>("Tax", TaxSchema);