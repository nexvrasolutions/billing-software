import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { Tenant } from "@/lib/models/Tenant";
import { Device } from "@/lib/models/Device";
import { hashPassword, verifyPassword } from "@/app/api/auth/password";
import {
    createUserSession,
    SESSION_TTL_SECONDS,
} from "@/lib/auth/sessionStore";
import {
    RateLimitUnavailableError,
    checkLoginRateLimit,
    clearAccountLoginFailures,
    getClientIp,
    recordLoginFailure,
    type LoginAttemptSubject,
} from "@/lib/auth/loginRateLimit";

// Upper bound on accounts sharing one email across businesses,
// so a login request cannot trigger unbounded password hashing.
const MAX_LOGIN_CANDIDATES = 10;

// Matches the limits used when users are created (12-128 characters).
// The lower bound is 1 so older accounts with shorter passwords still work;
// the upper bound caps hashing work per request.
const loginSchema = z.object({
    email: z.string().trim().toLowerCase().min(1).max(254),
    password: z.string().min(1).max(128),
    deviceId: z.string().trim().min(1).max(200),
});

const INVALID_CREDENTIALS = "Invalid email or password";

function jsonError(message: string, status: number, headers?: HeadersInit) {
    return NextResponse.json(
        { success: false, message },
        { status, headers }
    );
}

// Verified against when no account matches, so "unknown email" takes about
// as long as "wrong password" and timing does not reveal which emails exist.
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash() {
    dummyHashPromise ??= hashPassword("timing-equalization-placeholder");
    return dummyHashPromise;
}

export async function POST(request: NextRequest) {
    let body: unknown;

    try {
        body = await request.json();
    } catch {
        return jsonError("Request body must be valid JSON", 400);
    }

    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
        return jsonError(
            "Email, password and deviceId are required (password at most 128 characters)",
            400
        );
    }

    const { email, password, deviceId } = parsed.data;

    const subject: LoginAttemptSubject = {
        ip: getClientIp(request),
        email,
    };

    const tooManyAttempts = (retryAfterSeconds: number) =>
        jsonError(
            "Too many login attempts. Please wait and try again.",
            429,
            { "Retry-After": String(retryAfterSeconds) }
        );

    // Record a failure, then answer with the given response. If the store
    // is down the login is refused rather than allowed without limits.
    const fail = async (response: NextResponse) => {
        await recordLoginFailure(subject);
        return response;
    };

    try {
        await connectDB();

        // 0. Rate limit BEFORE any password hashing.
        const limit = await checkLoginRateLimit(subject);

        if (limit.limited) {
            return tooManyAttempts(limit.retryAfterSeconds);
        }

        // 1. Find active users with this email.
        // Emails are unique per business, not globally, so the same
        // email may exist in several businesses.
        const candidates = await User.find({
            email,
            status: "active",
        })
            .limit(MAX_LOGIN_CANDIDATES)
            .lean();

        // 2. Keep only the accounts whose password matches.
        const passwordMatches: typeof candidates = [];

        if (!candidates.length) {
            await verifyPassword(password, await getDummyHash());
        }

        for (const candidate of candidates) {
            if (
                await verifyPassword(
                    password,
                    candidate.passwordHash
                )
            ) {
                passwordMatches.push(candidate);
            }
        }

        if (!passwordMatches.length) {
            return await fail(jsonError(INVALID_CREDENTIALS, 401));
        }

        // 3. The registered device identifies the business:
        // it must belong to one of the matching accounts.
        const devices = await Device.find({
            userId: {
                $in: passwordMatches.map((item) => item._id),
            },
            deviceId,
            status: "active",
        }).lean();

        if (devices.length > 1) {
            return await fail(
                jsonError(
                    "This device is registered to more than one business account. Contact support.",
                    409
                )
            );
        }

        const device = devices[0];

        const user = device
            ? passwordMatches.find((item) =>
                item._id.equals(device.userId) &&
                item.tenantId.equals(device.tenantId)
            )
            : undefined;

        // 4. Verify tenant
        const tenant = await Tenant.findOne({
            _id: (user ?? passwordMatches[0]).tenantId,
            status: "active",
        }).lean();

        if (!tenant) {
            return await fail(jsonError("Business account is inactive", 403));
        }

        // 5. Verify device belongs to this user
        if (!device || !user) {
            return await fail(
                jsonError("Device is not registered for this user", 403)
            );
        }

        // 6. Successful login: clear this account's failure counters.
        await clearAccountLoginFailures(subject);

        // 7. Create the server-side session and its signed token.
        const { token: sessionToken } =
            await createUserSession({
                userId: user._id.toString(),
                tenantId:
                    user.tenantId.toString(),
                deviceId: device._id.toString(),
                roleId:
                    user.roleId?.toString(),
            });

        // 8. Set secure HttpOnly cookie
        const response =
            NextResponse.json({
                success: true,
                message: "Login successful",
                user: {
                    id: user._id.toString(),
                    name: user.name,
                    email: user.email,
                    tenantId:
                        user.tenantId.toString(),
                    roleId:
                        user.roleId?.toString() ??
                        null,
                    deviceId:
                        device.deviceId,
                    mustChangePassword:
                        user.mustChangePassword === true,
                },
                tenant: {
                    id: tenant._id.toString(),
                    name: tenant.name,
                    businessType:
                        tenant.businessType ??
                        null,
                },
                device: {
                    id: device._id.toString(),
                    deviceId:
                        device.deviceId,
                    deviceName:
                        device.deviceName,
                    deviceType:
                        device.deviceType,
                },
            });

        response.cookies.set(
            "session",
            sessionToken,
            {
                httpOnly: true,
                secure:
                    process.env.NODE_ENV ===
                    "production",
                sameSite: "lax",
                path: "/",
                maxAge: SESSION_TTL_SECONDS,
            }
        );

        // Update device last seen
        await Device.updateOne(
            { _id: device._id },
            {
                $set: {
                    lastSeenAt: new Date(),
                },
            }
        );

        return response;
    } catch (error) {
        if (error instanceof RateLimitUnavailableError) {
            // Fail closed: never allow logins without rate limiting.
            return jsonError(
                "Login is temporarily unavailable. Please try again shortly.",
                503,
                { "Retry-After": "30" }
            );
        }

        // Log only the error type and code (e.g. ECONNREFUSED): request
        // data such as the password is never logged.
        console.error(
            "Login error:",
            error instanceof Error ? error.name : "unknown",
            (error as { code?: unknown })?.code ?? ""
        );

        return jsonError(
            "An unexpected error occurred during login",
            500
        );
    }
}
