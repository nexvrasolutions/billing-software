
import { NextRequest, NextResponse } from "next/server";
import mongoose, { Types } from "mongoose";
import { z } from "zod";

import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hashPassword, verifyPassword } from "@/app/api/auth/password";
import {
    createUserSession,
    revokeAllUserSessions,
    SESSION_TTL_SECONDS,
} from "@/lib/auth/sessionStore";
import {
    RateLimitUnavailableError,
    checkLoginRateLimit,
    getClientIp,
    recordLoginFailure,
} from "@/lib/auth/loginRateLimit";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    errorResponse,
    passwordSchema,
    readJsonBody,
    validationErrorResponse,
} from "@/lib/users/userApi";

const changePasswordSchema = z
    .strictObject({
        currentPassword: z.string().min(1).max(128),
        newPassword: passwordSchema,
    })
    .refine((data) => data.currentPassword !== data.newPassword, {
        message: "The new password must be different from the current password",
        path: ["newPassword"],
    });

function sessionCookieOptions(maxAge: number) {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax" as const,
        path: "/",
        maxAge,
    };
}

/*
 * POST /api/auth/change-password
 *
 * The signed-in user changes their own password. On success EVERY session
 * of the user is revoked (including copies of the current token), and a
 * fresh session is issued for the current device only.
 *
 * Wrong current-password attempts count against the same rate limits as
 * failed logins, so a stolen session cannot be used to guess the password.
 */
export async function POST(request: NextRequest) {
    try {
        // Restricted users (temporary password) must be able to reach this.
        const context = await getAuthenticatedContext(request, {
            allowPasswordChangeRequired: true,
        });

        if (!context) {
            return errorResponse("Authentication required", 401);
        }

        const json = await readJsonBody(request);

        if (!json.ok) {
            return errorResponse("Request body must be valid JSON", 400);
        }

        const parsed = changePasswordSchema.safeParse(json.body);

        if (!parsed.success) {
            return validationErrorResponse("Invalid password data", parsed.error);
        }

        const { currentPassword, newPassword } = parsed.data;

        await connectDB();

        const tenantId = new Types.ObjectId(context.tenantId);
        const userId = new Types.ObjectId(context.userId);

        const user = await User.findOne({ _id: userId, tenantId, status: "active" })
            .select("_id email passwordHash roleId")
            .lean();

        if (!user) {
            return errorResponse("Authentication required", 401);
        }

        const subject = { ip: getClientIp(request), email: user.email };
        const limit = await checkLoginRateLimit(subject);

        if (limit.limited) {
            return NextResponse.json(
                { success: false, message: "Too many attempts. Please wait and try again." },
                { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
            );
        }

        if (!(await verifyPassword(currentPassword, user.passwordHash))) {
            await recordLoginFailure(subject);
            return errorResponse("Current password is incorrect", 400);
        }

        const passwordHash = await hashPassword(newPassword);
        const dbSession = await mongoose.startSession();

        try {
            await dbSession.withTransaction(async () => {
                // Only update if the password has not changed concurrently.
                const result = await User.updateOne(
                    { _id: userId, tenantId, status: "active", passwordHash: user.passwordHash },
                    // Choosing a new password lifts the temporary-password restriction.
                    { $set: { passwordHash, mustChangePassword: false } },
                    { session: dbSession }
                );

                if (result.modifiedCount !== 1) {
                    throw new Error("PASSWORD_CHANGED_CONCURRENTLY");
                }

                const revoked = await revokeAllUserSessions(
                    tenantId,
                    userId,
                    "password-changed",
                    dbSession
                );

                // Never store passwords or hashes in the audit log.
                await AuditLogService.createAuditLog(
                    {
                        userId,
                        tenantId,
                        deviceId: new Types.ObjectId(context.deviceId),
                    },
                    {
                        action: "user.password_changed",
                        entity: "User",
                        entityId: userId,
                        description: `User changed their own password; ${revoked} session(s) revoked`,
                        newValues: { revokedSessions: revoked },
                    },
                    dbSession
                );
            });
        } finally {
            await dbSession.endSession();
        }

        // All old sessions are revoked; give this device a new one.
        try {
            const { token } = await createUserSession({
                userId: context.userId,
                tenantId: context.tenantId,
                deviceId: context.deviceId,
                roleId: user.roleId?.toString(),
            });

            const response = NextResponse.json({
                success: true,
                message: "Password changed. You have been signed out on all other devices.",
            });
            response.cookies.set("session", token, sessionCookieOptions(SESSION_TTL_SECONDS));
            return response;
        } catch {
            const response = NextResponse.json({
                success: true,
                message: "Password changed. Please sign in again.",
                requireLogin: true,
            });
            response.cookies.set("session", "", { ...sessionCookieOptions(0), expires: new Date(0) });
            return response;
        }
    } catch (error) {
        if (error instanceof RateLimitUnavailableError) {
            return NextResponse.json(
                { success: false, message: "Password change is temporarily unavailable. Please try again shortly." },
                { status: 503, headers: { "Retry-After": "30" } }
            );
        }

        if (error instanceof Error && error.message === "PASSWORD_CHANGED_CONCURRENTLY") {
            return errorResponse("Your password was changed by another request. Please sign in again.", 409);
        }

        console.error(
            "Change password error:",
            error instanceof Error ? error.name : "unknown"
        );
        return errorResponse("Unable to change password", 500);
    }
}
