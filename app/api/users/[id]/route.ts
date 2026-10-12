
import { NextRequest, NextResponse } from "next/server";
import mongoose, { Types } from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { Role } from "@/lib/models/Role";
import { getAdministratorRoleIds } from "@/lib/auth/isAdministratorRole";
import {
    getAuthenticatedContext,
    type AuthenticatedContext,
} from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";
import {
    canAssignRole,
    canManageUserWithRole,
    ensureTenantAdminGuard,
    isPrivilegedRole,
    loadUserManagementPolicy,
    lockTenantAdminGuard,
} from "@/lib/auth/userManagementPolicy";
import { revokeAllUserSessions } from "@/lib/auth/sessionStore";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    UserManagementError,
    auditDeniedAttempt,
    errorResponse,
    isDuplicateKeyError,
    publicUser,
    readJsonBody,
    updateUserSchema,
    validationErrorResponse,
} from "@/lib/users/userApi";

type RouteContext = {
    params: Promise<{ id: string }>;
};

const DUPLICATE_EMAIL_MESSAGE =
    "A user with this email already exists in this business";

// GET /api/users/[id]
export async function GET(
    request: NextRequest,
    context: RouteContext
) {
    try {
        await connectDB();

        const auth = await getAuthenticatedContext(request);

        if (!auth) {
            return errorResponse("Authentication required", 401);
        }

        const allowed = await hasPermission({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permission: "users.read",
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const { id } = await context.params;

        if (!Types.ObjectId.isValid(id) || !/^[a-f\d]{24}$/i.test(id)) {
            return errorResponse("Invalid user ID", 400);
        }

        const tenantId = new Types.ObjectId(auth.tenantId);

        // Tenant-scoped: another tenant's user is simply "not found".
        const user = await User.findOne({
            _id: new Types.ObjectId(id),
            tenantId,
        })
            .select("_id name email roleId status createdAt updatedAt")
            .lean();

        if (!user) {
            return errorResponse("User not found", 404);
        }

        const [role, policy] = await Promise.all([
            user.roleId
                ? Role.findOne({ _id: user.roleId, tenantId })
                    .select("_id name")
                    .lean()
                : Promise.resolve(null),
            loadUserManagementPolicy(auth),
        ]);

        return NextResponse.json({
            success: true,
            user: publicUser(user, {
                roleName: role?.name ?? null,
                ownerUserId: policy.ownerUserId,
            }),
        });
    } catch (error) {
        console.error("GET /api/users/[id] error:", error);
        return errorResponse("Unable to retrieve user", 500);
    }
}

// PATCH /api/users/[id]
export async function PATCH(
    request: NextRequest,
    context: RouteContext
) {
    let auth: AuthenticatedContext | null = null;

    try {
        await connectDB();

        auth = await getAuthenticatedContext(request);

        if (!auth) {
            return errorResponse("Authentication required", 401);
        }

        const caller = auth;
        const permissionInput = {
            userId: caller.userId,
            tenantId: caller.tenantId,
            roleId: caller.roleId,
        };

        const allowed = await hasPermission({
            ...permissionInput,
            permission: "users.update",
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const { id } = await context.params;

        if (!Types.ObjectId.isValid(id) || !/^[a-f\d]{24}$/i.test(id)) {
            return errorResponse("Invalid user ID", 400);
        }

        const json = await readJsonBody(request);

        if (!json.ok) {
            return errorResponse("Request body must be valid JSON", 400);
        }

        const parsed = updateUserSchema.safeParse(json.body);

        if (!parsed.success) {
            return validationErrorResponse("Invalid input", parsed.error);
        }

        const input = parsed.data;

        // Activating or deactivating an account is the "delete" operation
        // of this module (users are never hard-deleted).
        if (input.status !== undefined) {
            const canChangeStatus = await hasPermission({
                ...permissionInput,
                permission: "users.delete",
            });

            if (!canChangeStatus) {
                return errorResponse(
                    "Permission denied: activating or deactivating users requires the users.delete permission",
                    403
                );
            }
        }

        const tenantId = new Types.ObjectId(caller.tenantId);
        const targetId = new Types.ObjectId(id);

        await ensureTenantAdminGuard(tenantId);

        const mongoSession = await mongoose.startSession();
        let responseUser: ReturnType<typeof publicUser> | null = null;

        try {
            await mongoSession.withTransaction(async () => {
                responseUser = null;

                // Serialize privilege changes for this tenant.
                await lockTenantAdminGuard(tenantId, mongoSession);

                // Read the target inside the transaction, tenant-scoped.
                const user = await User.findOne({
                    _id: targetId,
                    tenantId,
                }).session(mongoSession);

                if (!user) {
                    throw new UserManagementError(
                        404,
                        "User not found",
                        "TARGET_USER_NOT_FOUND"
                    );
                }

                const policy = await loadUserManagementPolicy(
                    caller,
                    mongoSession
                );

                const isSelf = user._id.toString() === caller.userId;
                const isOwnerTarget =
                    policy.ownerUserId === user._id.toString();
                const currentRoleId = user.roleId?.toString() ?? null;

                const roleChanging =
                    input.roleId !== undefined &&
                    (input.roleId?.toLowerCase() ?? null) !== currentRoleId;
                const statusChanging =
                    input.status !== undefined &&
                    input.status !== user.status;
                const emailChanging =
                    input.email !== undefined && input.email !== user.email;

                if (isSelf && statusChanging && input.status === "inactive") {
                    throw new UserManagementError(
                        400,
                        "You cannot deactivate your own account",
                        "CANNOT_DEACTIVATE_SELF"
                    );
                }

                if (isSelf && (roleChanging || statusChanging)) {
                    throw new UserManagementError(
                        403,
                        "You cannot change your own role or status",
                        "PRIVILEGE_ESCALATION_DENIED",
                        {
                            entityId: user._id,
                            details: {
                                operation: "update-self",
                                attemptedRoleId: input.roleId,
                                attemptedStatus: input.status,
                            },
                        }
                    );
                }

                // Owner protection is separate from administrator protection:
                // nobody can demote or deactivate the business owner here.
                if (isOwnerTarget && (roleChanging || statusChanging)) {
                    throw new UserManagementError(
                        409,
                        "The business owner's role and status are protected and cannot be changed",
                        "OWNER_PROTECTED"
                    );
                }

                const [currentRole, nextRole] = await Promise.all([
                    user.roleId
                        ? Role.findOne({ _id: user.roleId, tenantId })
                            .select("_id name permissions")
                            .session(mongoSession)
                            .lean()
                        : Promise.resolve(null),
                    roleChanging && input.roleId
                        ? Role.findOne({
                            _id: new Types.ObjectId(input.roleId),
                            tenantId,
                            status: "active",
                        })
                            .select("_id name permissions")
                            .session(mongoSession)
                            .lean()
                        : Promise.resolve(null),
                ]);

                // Non-owners cannot modify administrators or users who hold
                // more permissions than they do.
                if (!isSelf && !canManageUserWithRole(policy, currentRole)) {
                    throw new UserManagementError(
                        403,
                        "Only the business owner can change users who hold an administrator-level role",
                        "PRIVILEGE_ESCALATION_DENIED",
                        {
                            entityId: user._id,
                            details: {
                                operation: "update",
                                targetRoleId: currentRoleId,
                                attemptedRoleId: input.roleId,
                                attemptedStatus: input.status,
                            },
                        }
                    );
                }

                if (roleChanging && input.roleId) {
                    // Role must belong to the caller's tenant and be active.
                    if (!nextRole) {
                        throw new UserManagementError(
                            400,
                            "The selected role is invalid or inactive for this business",
                            "INVALID_ROLE"
                        );
                    }

                    if (!canAssignRole(policy, nextRole)) {
                        throw new UserManagementError(
                            403,
                            isPrivilegedRole(policy, nextRole)
                                ? "Only the business owner can grant an administrator-level role"
                                : "You cannot assign a role with permissions you do not have",
                            "PRIVILEGE_ESCALATION_DENIED",
                            {
                                entityId: user._id,
                                details: {
                                    operation: "update",
                                    attemptedRoleId: String(nextRole._id),
                                    attemptedRoleName: nextRole.name,
                                },
                            }
                        );
                    }
                }

                if (emailChanging) {
                    const duplicate = await User.exists({
                        tenantId,
                        email: input.email,
                        _id: { $ne: user._id },
                    }).session(mongoSession);

                    if (duplicate) {
                        throw new UserManagementError(
                            409,
                            DUPLICATE_EMAIL_MESSAGE,
                            "DUPLICATE_EMAIL"
                        );
                    }
                }

                const nextStatus = input.status ?? user.status;
                const nextRoleId: Types.ObjectId | undefined = roleChanging
                    ? nextRole?._id
                    : user.roleId;

                // Last-active-administrator (lockout) protection.
                if (roleChanging || statusChanging) {
                    const administratorRoleIds = await getAdministratorRoleIds(
                        tenantId,
                        mongoSession
                    );

                    const isAdministratorRole = (
                        roleId: Types.ObjectId | undefined | null
                    ) =>
                        roleId != null &&
                        administratorRoleIds.some((adminRoleId) =>
                            adminRoleId.equals(roleId)
                        );

                    const targetWouldStopBeingAdministrator =
                        user.status === "active" &&
                        isAdministratorRole(user.roleId) &&
                        (nextStatus !== "active" ||
                            !isAdministratorRole(nextRoleId));

                    if (targetWouldStopBeingAdministrator) {
                        const remainingAdministrators =
                            await User.countDocuments({
                                tenantId,
                                status: "active",
                                roleId: { $in: administratorRoleIds },
                                _id: { $ne: user._id },
                            }).session(mongoSession);

                        if (remainingAdministrators === 0) {
                            throw new UserManagementError(
                                409,
                                "You cannot deactivate or change the role of the last active administrator.",
                                "LAST_ACTIVE_ADMINISTRATOR"
                            );
                        }
                    }
                }

                const oldValues = {
                    name: user.name,
                    email: user.email,
                    roleId: currentRoleId,
                    roleName: currentRole?.name ?? null,
                    status: user.status,
                };

                if (input.name !== undefined) {
                    user.name = input.name;
                }

                if (emailChanging && input.email) {
                    user.email = input.email;
                }

                if (roleChanging) {
                    user.roleId = nextRoleId;
                }

                if (statusChanging && input.status) {
                    user.status = input.status;
                }

                await user.save({ session: mongoSession });

                // Deactivation ends every session of that user, in the same
                // transaction. Reactivating them later does not revive old
                // (possibly copied) tokens: they must log in again.
                if (statusChanging && user.status === "inactive") {
                    await revokeAllUserSessions(
                        tenantId,
                        user._id,
                        "user-deactivated",
                        mongoSession
                    );
                }

                const newValues = {
                    name: user.name,
                    email: user.email,
                    roleId: user.roleId?.toString() ?? null,
                    roleName: roleChanging
                        ? nextRole?.name ?? null
                        : currentRole?.name ?? null,
                    status: user.status,
                };

                const actor = {
                    userId: new Types.ObjectId(caller.userId),
                    tenantId,
                    deviceId: new Types.ObjectId(caller.deviceId),
                };

                const audit = (
                    action: string,
                    description: string,
                    values?: {
                        oldValues?: Record<string, unknown>;
                        newValues?: Record<string, unknown>;
                    }
                ) =>
                    AuditLogService.createAuditLog(
                        actor,
                        {
                            action,
                            entity: "User",
                            entityId: user._id,
                            description,
                            ...values,
                        },
                        mongoSession
                    );

                // Audit entries are written in the same transaction, so a
                // failed audit write rolls back the user change too.
                await audit("user.updated", `Updated user ${user.email}`, {
                    oldValues,
                    newValues,
                });

                if (roleChanging) {
                    await audit(
                        "user.role_changed",
                        `Changed role of ${user.email} from ${oldValues.roleName ?? "none"} to ${newValues.roleName ?? "none"}`,
                        {
                            oldValues: {
                                roleId: oldValues.roleId,
                                roleName: oldValues.roleName,
                            },
                            newValues: {
                                roleId: newValues.roleId,
                                roleName: newValues.roleName,
                            },
                        }
                    );
                }

                if (statusChanging) {
                    await audit(
                        user.status === "active"
                            ? "user.activated"
                            : "user.deactivated",
                        `${user.status === "active" ? "Activated" : "Deactivated"} user ${user.email}`,
                        {
                            oldValues: { status: oldValues.status },
                            newValues: { status: user.status },
                        }
                    );
                }

                const wasAdministrator =
                    oldValues.status === "active" &&
                    isPrivilegedRole(policy, currentRole);
                const isAdministratorNow =
                    user.status === "active" &&
                    isPrivilegedRole(
                        policy,
                        roleChanging ? nextRole : currentRole
                    );

                if (wasAdministrator !== isAdministratorNow) {
                    await audit(
                        isAdministratorNow
                            ? "user.admin_granted"
                            : "user.admin_revoked",
                        `${isAdministratorNow ? "Granted" : "Revoked"} administrator-level access for ${user.email}`,
                        {
                            oldValues: { roleId: oldValues.roleId, status: oldValues.status },
                            newValues: { roleId: newValues.roleId, status: newValues.status },
                        }
                    );
                }

                responseUser = publicUser(user, {
                    roleName: newValues.roleName,
                    ownerUserId: policy.ownerUserId,
                });
            });
        } finally {
            await mongoSession.endSession();
        }

        if (!responseUser) {
            return errorResponse("Unable to update user", 500);
        }

        return NextResponse.json({
            success: true,
            message: "User updated successfully",
            user: responseUser,
        });
    } catch (error) {
        if (error instanceof UserManagementError) {
            if (auth) {
                await auditDeniedAttempt(auth, error);
            }

            return errorResponse(error.message, error.status);
        }

        if (isDuplicateKeyError(error)) {
            return errorResponse(DUPLICATE_EMAIL_MESSAGE, 409);
        }

        console.error("PATCH /api/users/[id] error:", error);
        return errorResponse("Unable to update user", 500);
    }
}
