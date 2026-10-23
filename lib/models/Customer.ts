import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICustomer extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    phone?: string;
    email?: string;
    address?: string;

    status: "active" | "inactive";

    operationId?: string;

    createdAt: Date;
    updatedAt: Date;
}

const CustomerSchema = new Schema<ICustomer>(
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

        phone: {
            type: String,
            trim: true,
        },

        email: {
            type: String,
            trim: true,
            lowercase: true,
        },

        address: {
            type: String,
            trim: true,
        },

        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },

        operationId: {
            type: String,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

CustomerSchema.index(
    { tenantId: 1, phone: 1 },
    {
        unique: true,
        sparse: true,
        partialFilterExpression: {
            phone: { $type: "string", $gt: "" },
        },
    }
);

CustomerSchema.index(
    { tenantId: 1, operationId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            operationId: { $type: "string", $gt: "" },
        },
    }
);

export const Customer: Model<ICustomer> =
    mongoose.models.Customer ||
    mongoose.model<ICustomer>("Customer", CustomerSchema);