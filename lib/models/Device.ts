import mongoose, { Schema, Document, Model } from "mongoose";

export interface IDevice extends Document {
    tenantId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;

    deviceName: string;

    deviceType:
    | "pos"
    | "desktop"
    | "laptop"
    | "tablet"
    | "mobile"
    | "other";

    deviceId: string;

    status: "active" | "inactive";

    lastSeenAt?: Date;

    createdAt: Date;
    updatedAt: Date;
}

const DeviceSchema = new Schema<IDevice>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },

        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        deviceName: {
            type: String,
            required: true,
            trim: true,
        },

        deviceType: {
            type: String,
            enum: [
                "pos",
                "desktop",
                "laptop",
                "tablet",
                "mobile",
                "other",
            ],
            required: true,
        },

        deviceId: {
            type: String,
            required: true,
            trim: true,
        },

        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },

        lastSeenAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
    }
);

// A deviceId must be unique inside a tenant.
DeviceSchema.index(
    { tenantId: 1, deviceId: 1 },
    { unique: true }
);

export const Device: Model<IDevice> =
    mongoose.models.Device ||
    mongoose.model<IDevice>("Device", DeviceSchema);