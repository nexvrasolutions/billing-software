import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUser extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    email: string;
    passwordHash: string;

    roleId?: mongoose.Types.ObjectId;

    status: "active" | "inactive";

    // Set when an administrator resets the password. Until the user picks
    // a new password, only the password-change endpoints accept the session.
    // Missing/false means unrestricted. Never settable through user APIs.
    mustChangePassword?: boolean;

    createdAt: Date;
    updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
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

        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
        },

        passwordHash: {
            type: String,
            required: true,
        },

        roleId: {
            type: Schema.Types.ObjectId,
            ref: "Role",
        },

        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },

        mustChangePassword: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

// Same email can exist in different businesses,
// but should be unique within the same business.
UserSchema.index(
    { tenantId: 1, email: 1 },
    { unique: true }
);

export const User: Model<IUser> =
    mongoose.models.User ||
    mongoose.model<IUser>("User", UserSchema);