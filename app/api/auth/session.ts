import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface SessionPayload extends JWTPayload {
    // Random server-side session ID. Its SHA-256 hash is stored in the
    // Session collection; the session is valid only while that record is
    // active (see lib/auth/sessionStore.ts).
    sid: string;
    userId: string;
    tenantId: string;
    deviceId: string;
    roleId?: string;
}

const SESSION_SECRET =
    process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
    throw new Error(
        "SESSION_SECRET is not defined"
    );
}

const secretKey =
    new TextEncoder().encode(SESSION_SECRET);

export async function createSessionToken(
    payload: SessionPayload,
    expiresAt: Date
): Promise<string> {
    return new SignJWT(payload)
        .setProtectedHeader({
            alg: "HS256",
        })
        .setIssuedAt()
        .setExpirationTime(
            Math.floor(expiresAt.getTime() / 1000)
        )
        .sign(secretKey);
}

export async function verifySessionToken(
    token: string
): Promise<SessionPayload | null> {
    try {
        const { payload } =
            await jwtVerify(
                token,
                secretKey,
                { algorithms: ["HS256"] }
            );

        // Tokens issued before server-side sessions existed have no
        // "sid" and are rejected: those users must log in again once.
        if (
            typeof payload.sid !== "string" ||
            typeof payload.userId !== "string" ||
            typeof payload.tenantId !== "string" ||
            typeof payload.deviceId !== "string"
        ) {
            return null;
        }

        return {
            sid: payload.sid,
            userId: payload.userId,
            tenantId: payload.tenantId,
            deviceId: payload.deviceId,
            roleId:
                typeof payload.roleId === "string"
                    ? payload.roleId
                    : undefined,
        };
    } catch {
        return null;
    }
}
