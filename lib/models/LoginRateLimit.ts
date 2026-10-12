import mongoose, { Schema, Document, Model } from "mongoose";

/*
 * Counter for failed login attempts, shared by every app instance.
 * "key" is an HMAC of the IP and/or normalized email, so raw IPs and
 * email addresses are never stored here.
 */
export interface ILoginRateLimit extends Document {
    key: string;
    failures: number;
    windowStart: Date;
    lockedUntil?: Date;
    lockoutLevel: number;
    lastLockedAt?: Date;
    expiresAt: Date;
}

const LoginRateLimitSchema = new Schema<ILoginRateLimit>(
    {
        key: {
            type: String,
            required: true,
        },

        failures: {
            type: Number,
            default: 0,
            required: true,
        },

        windowStart: {
            type: Date,
            required: true,
        },

        lockedUntil: {
            type: Date,
        },

        // Number of consecutive lockouts, used for progressive lockouts.
        lockoutLevel: {
            type: Number,
            default: 0,
            required: true,
        },

        lastLockedAt: {
            type: Date,
        },

        expiresAt: {
            type: Date,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

LoginRateLimitSchema.index({ key: 1 }, { unique: true });

// Automatic cleanup of idle counters.
LoginRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginRateLimit: Model<ILoginRateLimit> =
    mongoose.models.LoginRateLimit ||
    mongoose.model<ILoginRateLimit>("LoginRateLimit", LoginRateLimitSchema);
