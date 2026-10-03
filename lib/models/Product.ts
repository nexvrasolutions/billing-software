import mongoose, { Schema, Document, Model } from "mongoose";

export interface IProduct extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    SKU: string;
    barcode?: string;

    categoryId: mongoose.Types.ObjectId;
    unitId: mongoose.Types.ObjectId;

    purchasePrice: number;
    sellingPrice: number;

    stockQuantity: number;

    status: "active" | "inactive";

    createdAt: Date;
    updatedAt: Date;
}

const ProductSchema = new Schema<IProduct>(
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

        SKU: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
        },

        barcode: {
            type: String,
            trim: true,
        },

        categoryId: {
            type: Schema.Types.ObjectId,
            ref: "Category",
            required: true,
            index: true,
        },

        unitId: {
            type: Schema.Types.ObjectId,
            ref: "Unit",
            required: true,
            index: true,
        },

        purchasePrice: {
            type: Number,
            required: true,
            min: 0,
        },

        sellingPrice: {
            type: Number,
            required: true,
            min: 0,
        },

        stockQuantity: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
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

ProductSchema.index(
    { tenantId: 1, SKU: 1 },
    { unique: true }
);

ProductSchema.index(
    { tenantId: 1, barcode: 1 },
    {
        unique: true,
        sparse: true,
    }
);

export const Product: Model<IProduct> =
    mongoose.models.Product ||
    mongoose.model<IProduct>("Product", ProductSchema);