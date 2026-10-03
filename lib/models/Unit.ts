import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUnit extends Document {
    tenantId: mongoose.Types.ObjectId;

    name: string;
    shortName?: string;

    status: "active" | "inactive";

    createdAt: Date;
    updatedAt: Date;
}

const UnitSchema = new Schema<IUnit>(
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

        shortName: {
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

UnitSchema.index(
    { tenantId: 1, name: 1 },
    { unique: true }
);

export const Unit: Model<IUnit> =
    mongoose.models.Unit ||
    mongoose.model<IUnit>("Unit", UnitSchema);