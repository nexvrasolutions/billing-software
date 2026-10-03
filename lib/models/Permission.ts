import mongoose, { Schema, Document, Model } from "mongoose";

export interface IPermission extends Document {
    name: string;
    description?: string;

    createdAt: Date;
    updatedAt: Date;
}

const PermissionSchema = new Schema<IPermission>(
    {
        name: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },

        description: {
            type: String,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

export const Permission: Model<IPermission> =
    mongoose.models.Permission ||
    mongoose.model<IPermission>("Permission", PermissionSchema);