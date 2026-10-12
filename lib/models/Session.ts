import mongoose, { Schema, Document, Model } from "mongoose";

/*
 * Server-side login session.
 *
 * The signed session cookie (JWT) carries a random session ID ("sid").
 * Only the SHA-256 hash of that ID is stored here, so a database leak does
 * not reveal usable session identifiers. Every authenticated request must
 * find an active (not revoked, not expired) session with that hash.
 */
export interface ISession extends Document {
    tenantId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    // Device document _id (not the client-side device string).
    deviceId: mongoose.Types.ObjectId;

    tokenHash: string;

    expiresAt: Date;
    revokedAt?: Date;
    revokedReason?: string;

    createdAt: Date;
    updatedAt: Date;
}

const SessionSchema = new Schema<ISession>(
    {
        tenantId: {
            type: Schema.Types.ObjectId,
            ref: "Tenant",
            required: true,
        },

        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        deviceId: {
            type: Schema.Types.ObjectId,
            ref: "Device",
            required: true,
        },

        tokenHash: {
            type: String,
            required: true,
        },

        expiresAt: {
            type: Date,
            required: true,
        },

        revokedAt: {
            type: Date,
        },

        revokedReason: {
            type: String,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

// Lookup on every authenticated request.
SessionSchema.index({ tokenHash: 1 }, { unique: true });

// "Revoke all sessions of this user" (deactivation, logout everywhere).
SessionSchema.index({ tenantId: 1, userId: 1, revokedAt: 1 });

// MongoDB deletes sessions automatically once they expire (TTL cleanup).
// Expiry is ALSO checked in every query, because the TTL monitor only
// runs about once a minute.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session: Model<ISession> =
    mongoose.models.Session ||
    mongoose.model<ISession>("Session", SessionSchema);
