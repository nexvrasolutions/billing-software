
import { createHash, randomBytes } from "crypto";
import mongoose, { Types } from "mongoose";

import { Session } from "@/lib/models/Session";
import {
    createSessionToken,
    type SessionPayload,
} from "@/app/api/auth/session";

/**
 * Lifetime of a login session: 24 hours from login, fixed (no idle timeout).
 * This ONE constant sets the cookie Max-Age (login and change-password), the
 * signed token's expiry and the database expiresAt of NEW sessions. Sessions
 * created before this value was shortened keep the expiresAt they were stored
 * with (up to 7 days) until they expire or are revoked; nothing is migrated.
 * The 72-hour offline authorization is separate and is not affected.
 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export function hashSessionId(sid: string): string {
    return createHash("sha256").update(sid).digest("hex");
}

interface SessionOwner {
    userId: string;
    tenantId: string;
    /** Device document _id. */
    deviceId: string;
    roleId?: string;
}

/**
 * Create a server-side session and the signed token for the cookie.
 * The raw session ID exists only inside the signed token; the database
 * stores its hash.
 */
export async function createUserSession(
    owner: SessionOwner
): Promise<{ token: string; expiresAt: Date }> {
    const sid = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

    await Session.create({
        tenantId: new Types.ObjectId(owner.tenantId),
        userId: new Types.ObjectId(owner.userId),
        deviceId: new Types.ObjectId(owner.deviceId),
        tokenHash: hashSessionId(sid),
        expiresAt,
    });

    const token = await createSessionToken(
        {
            sid,
            userId: owner.userId,
            tenantId: owner.tenantId,
            deviceId: owner.deviceId,
            roleId: owner.roleId,
        },
        expiresAt
    );

    return { token, expiresAt };
}

/**
 * True only if a matching session exists, belongs to the same user,
 * tenant and device as the signed token, is not revoked and not expired.
 */
export async function isSessionActive(
    payload: SessionPayload
): Promise<boolean> {
    if (
        !Types.ObjectId.isValid(payload.userId) ||
        !Types.ObjectId.isValid(payload.tenantId) ||
        !Types.ObjectId.isValid(payload.deviceId)
    ) {
        return false;
    }

    const session = await Session.exists({
        tokenHash: hashSessionId(payload.sid),
        userId: new Types.ObjectId(payload.userId),
        tenantId: new Types.ObjectId(payload.tenantId),
        deviceId: new Types.ObjectId(payload.deviceId),
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
    });

    return Boolean(session);
}

/** Revoke the single session identified by a (verified) token payload. */
export async function revokeSession(
    payload: SessionPayload,
    reason: string
): Promise<boolean> {
    const result = await Session.updateOne(
        {
            tokenHash: hashSessionId(payload.sid),
            revokedAt: { $exists: false },
        },
        { $set: { revokedAt: new Date(), revokedReason: reason } }
    );

    return result.modifiedCount === 1;
}

/**
 * Revoke every active session of one user (logout everywhere,
 * deactivation). Pass the transaction session to make it atomic with the
 * change that requires it.
 */
export async function revokeAllUserSessions(
    tenantId: Types.ObjectId,
    userId: Types.ObjectId,
    reason: string,
    dbSession?: mongoose.ClientSession
): Promise<number> {
    const result = await Session.updateMany(
        {
            tenantId,
            userId,
            revokedAt: { $exists: false },
            // Already-expired sessions are unusable anyway and are removed
            // by the TTL index; only count live ones.
            expiresAt: { $gt: new Date() },
        },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
        { session: dbSession }
    );

    return result.modifiedCount;
}
