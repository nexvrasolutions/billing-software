import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICounter extends Document {
    tenantId: mongoose.Types.ObjectId;
    key: string;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
}

const CounterSchema = new Schema<ICounter>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
            index: true,
        },
        key: {
            type: String,
            required: true,
            trim: true,
        },
        seq: {
            type: Number,
            required: true,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

CounterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export const Counter: Model<ICounter> =
    mongoose.models.Counter ||
    mongoose.model<ICounter>("Counter", CounterSchema);
