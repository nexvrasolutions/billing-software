
import { NextRequest, NextResponse } from "next/server";
import mongoose, { Types } from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { Role } from "@/lib/models/Role";
import {
    getAuthenticatedContext,
    type AuthenticatedContext,
} from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";
import {
    canManageUserWithRole,
    ensureTenantAdminGuard,
    loadUserManagementPolicy,
    lockTenantAdminGuard,
} from "@/lib/auth/userManagementPolicy";
import { revokeAllUserSessions } from "@/lib/auth/sessionStore";
import { hashPassword } from "@/app/api/auth/password";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    UserManagementError,
    auditDeniedAttempt,
    errorResponse,
    readJsonBody,
    resetPasswordSchema,
    validationErrorResponse,
} from "@/lib/users/userApi";

type RouteContext = {
    params: Promise<{ id: string }>;
};

/*
 * POST /api/users/[id]/password
 *
 * An authorized administrator sets a new (temporary) password for another
 * user of the same business. Same rules as editing that user:
 *   - requires users.update
 *   - tenant-scoped (other businesses' users are "not found")
 *   - only the owner may reset administrators' passwords
 *   - the owner's password can only be changed by the owner (change-password)
 *   - users change their own password via /api/auth/change-password
 * Every session of the target user is revoked. The password is never
 * returned or logged.
 */
export async function POST(request: NextRequest, context: RouteContext) {
    let auth: AuthenticatedContext | null = null;

    try {
        await connectDB();

        auth = await getAuthenticatedContext(request);

        if (!auth) {
            return errorResponse("Authentication required", 401);
        }

        const caller = auth;

        const allowed = await hasPermission({
            userId: caller.userId,
            tenantId: caller.tenantId,
            roleId: caller.roleId,
            permission: "users.update",
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const { id } = await context.params;

        if (!/^[a-f\d]{24}$/i.test(id)) {
            return errorResponse("Invalid user ID", 400);
        }

        if (id.toLowerCase() === caller.userId) {
            return errorResponse(
                "Use 'Change password' to change your own password",
                400
            );
        }

        const json = await readJsonBody(request);

        if (!json.ok) {
            return errorResponse("Request body must be valid JSON", 400);
        }

        const parsed = resetPasswordSchema.safeParse(json.body);

        if (!parsed.success) {
            return validationErrorResponse("Invalid password data", parsed.error);
        }

        const tenantId = new Types.ObjectId(caller.tenantId);
        const targetId = new Types.ObjectId(id);
        const passwordHash = await hashPassword(parsed.data.newPassword);

        await ensureTenantAdminGuard(tenantId);

        const dbSession = await mongoose.startSession();
        let revokedSessions = 0;

        try {
            await dbSession.withTransaction(async () => {
                // Serialize with other privilege-sensitive user changes.
                await lockTenantAdminGuard(tenantId, dbSession);

                const user = await User.findOne({ _id: targetId, tenantId })
                    .select("_id email roleId")
                    .session(dbSession)
                    .lean();

                if (!user) {
                    throw new UserManagementError(404, "User not found", "TARGET_USER_NOT_FOUND");
                }

                const policy = await loadUserManagementPolicy(caller, dbSession);

                if (policy.ownerUserId === user._id.toString()) {
                    throw new UserManagementError(
                        409,
                        "The business owner's password can only be changed by the owner",
                        "OWNER_PROTECTED"
                    );
                }

                const currentRole = user.roleId
                    ? await Role.findOne({ _id: user.roleId, tenantId })
                        .select("_id permissions")
                        .session(dbSession)
                        .lean()
                    : null;

                if (!canManageUserWithRole(policy, currentRole)) {
                    throw new UserManagementError(
                        403,
                        "Only the business owner can reset the password of a user with an administrator-level role",
                        "PRIVILEGE_ESCALATION_DENIED",
                        {
                            entityId: user._id,
                            details: { operation: "password-reset", targetRoleId: user.roleId?.toString() ?? null },
                        }
                    );
                }

                await User.updateOne(
                    { _id: user._id, tenantId },
                    // The user must choose their own password at next login.
                    { $set: { passwordHash, mustChangePassword: true } },
                    { session: dbSession }
                );

                revokedSessions = await revokeAllUserSessions(
                    tenantId,
                    user._id,
                    "password-reset-by-admin",
                    dbSession
                );

                await AuditLogService.createAuditLog(
                    {
                        userId: new Types.ObjectId(caller.userId),
                        tenantId,
                        deviceId: new Types.ObjectId(caller.deviceId),
                    },
                    {
                        action: "user.password_reset",
                        entity: "User",
                        entityId: user._id,
                        description: `Reset password of ${user.email}; ${revokedSessions} session(s) revoked`,
                        newValues: { revokedSessions },
                    },
                    dbSession
                );
            });
        } finally {
            await dbSession.endSession();
        }

        return NextResponse.json({
            success: true,
            message: "Password reset. The user has been signed out everywhere and must use the new password.",
            revokedSessions,
        });
    } catch (error) {
        if (error instanceof UserManagementError) {
            if (auth) {
                await auditDeniedAttempt(auth, error);
            }

            return errorResponse(error.message, error.status);
        }

        console.error(
            "POST /api/users/[id]/password error:",
            error instanceof Error ? error.name : "unknown"
        );
        return errorResponse("Unable to reset password", 500);
    }
}
