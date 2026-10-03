import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRole extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    description?: string;

    permissions: mongoose.Types.ObjectId[];

    status: "active" | "inactive";

    createdAt: Date;
    updatedAt: Date;
}

const RoleSchema = new Schema<IRole>(
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

        permissions: [
            {
                type: Schema.Types.ObjectId,
                ref: "Permission",
            },
        ],

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

RoleSchema.index(
    { tenantId: 1, name: 1 },
    { unique: true }
);

export const Role: Model<IRole> =
    mongoose.models.Role ||
    mongoose.model<IRole>("Role", RoleSchema);