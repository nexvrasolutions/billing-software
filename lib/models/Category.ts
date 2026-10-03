import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICategory extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    description?: string;

    status: "active" | "inactive";

    createdAt: Date;
    updatedAt: Date;
}

const CategorySchema = new Schema<ICategory>(
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

        description: {
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

CategorySchema.index(
    { tenantId: 1, name: 1 },
    { unique: true }
);

export const Category: Model<ICategory> =
    mongoose.models.Category ||
    mongoose.model<ICategory>("Category", CategorySchema);