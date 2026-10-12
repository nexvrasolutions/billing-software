
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
    canAssignRole,
    canManageUserWithRole,
    ensureTenantAdminGuard,
    isPrivilegedRole,
    loadUserManagementPolicy,
    lockTenantAdminGuard,
} from "@/lib/auth/userManagementPolicy";
import { hashPassword } from "@/app/api/auth/password";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    UserManagementError,
    auditDeniedAttempt,
    createUserSchema,
    errorResponse,
    escapeRegex,
    isDuplicateKeyError,
    listUsersQuerySchema,
    publicUser,
    readJsonBody,
    validationErrorResponse,
} from "@/lib/users/userApi";

const DUPLICATE_EMAIL_MESSAGE =
    "A user with this email already exists in this business";

// GET /api/users?page=1&limit=20&search=jo&status=active
export async function GET(request: NextRequest) {
    try {
        const context = await getAuthenticatedContext(request);

        if (!context) {
            return errorResponse("Authentication required", 401);
        }

        await connectDB();

        const permissionInput = {
            userId: context.userId,
            tenantId: context.tenantId,
            roleId: context.roleId,
        };

        const allowed = await hasPermission({
            ...permissionInput,
            permission: "users.read",
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const parsedQuery = listUsersQuerySchema.safeParse(
            Object.fromEntries(request.nextUrl.searchParams)
        );

        if (!parsedQuery.success) {
            return validationErrorResponse(
                "Invalid query parameters",
                parsedQuery.error
            );
        }

        const { page, limit, search, status } = parsedQuery.data;
        const tenantId = new Types.ObjectId(context.tenantId);

        // tenantId always comes from the verified session.
        const filter: Record<string, unknown> = { tenantId };

        if (status) {
            filter.status = status;
        }

        if (search) {
            const pattern = new RegExp(escapeRegex(search), "i");
            filter.$or = [{ name: pattern }, { email: pattern }];
        }

        const [users, total, roles, policy, canCreate, canUpdate, canChangeStatus] =
            await Promise.all([
                User.find(filter)
                    .select("_id name email roleId status createdAt updatedAt")
                    .sort({ createdAt: -1 })
                    .skip((page - 1) * limit)
                    .limit(limit)
                    .lean(),
                User.countDocuments(filter),
                Role.find({ tenantId }).select("_id name permissions").lean(),
                loadUserManagementPolicy(context),
                hasPermission({ ...permissionInput, permission: "users.create" }),
                hasPermission({ ...permissionInput, permission: "users.update" }),
                hasPermission({ ...permissionInput, permission: "users.delete" }),
            ]);

        const rolesById = new Map(
            roles.map((role) => [role._id.toString(), role])
        );

        return NextResponse.json({
            success: true,
            users: users.map((user) => {
                const role = user.roleId
                    ? rolesById.get(user.roleId.toString())
                    : undefined;

                return publicUser(user, {
                    roleName: role?.name ?? null,
                    ownerUserId: policy.ownerUserId,
                    canEdit:
                        canUpdate &&
                        (user._id.toString() === context.userId ||
                            canManageUserWithRole(policy, role)),
                });
            }),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
            // UI hints only. Every action is re-checked on the server.
            capabilities: {
                currentUserId: context.userId,
                isOwner: policy.isOwner,
                canCreate,
                canUpdate,
                canChangeStatus,
                ownerDesignated: policy.ownerUserId !== null,
            },
        });
    } catch (error) {
        console.error("GET /api/users error:", error);
        return errorResponse("Unable to retrieve users", 500);
    }
}

// POST /api/users
export async function POST(request: NextRequest) {
    let auth: AuthenticatedContext | null = null;

    try {
        auth = await getAuthenticatedContext(request);

        if (!auth) {
            return errorResponse("Authentication required", 401);
        }

        const context = auth;

        await connectDB();

        const allowed = await hasPermission({
            userId: context.userId,
            tenantId: context.tenantId,
            roleId: context.roleId,
            permission: "users.create",
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const json = await readJsonBody(request);

        if (!json.ok) {
            return errorResponse("Invalid JSON request body", 400);
        }

        const parsed = createUserSchema.safeParse(json.body);

        if (!parsed.success) {
            return validationErrorResponse("Invalid user data", parsed.error);
        }

        const { name, email, password, roleId } = parsed.data;
        const tenantId = new Types.ObjectId(context.tenantId);

        // Fast duplicate check before the (slow) password hash.
        // The unique index and the in-transaction check remain authoritative.
        const existingUser = await User.exists({ tenantId, email });

        if (existingUser) {
            return errorResponse(DUPLICATE_EMAIL_MESSAGE, 409);
        }

        const passwordHash = await hashPassword(password);

        await ensureTenantAdminGuard(tenantId);

        const dbSession = await mongoose.startSession();
        let createdUser: ReturnType<typeof publicUser> | null = null;

        try {
            await dbSession.withTransaction(async () => {
                createdUser = null;

                await lockTenantAdminGuard(tenantId, dbSession);

                // Role must belong to the caller's tenant and be active.
                const role = await Role.findOne({
                    _id: new Types.ObjectId(roleId),
                    tenantId,
                    status: "active",
                })
                    .select("_id name permissions")
                    .session(dbSession)
                    .lean();

                if (!role) {
                    throw new UserManagementError(
                        400,
                        "The selected role is invalid or inactive for this business",
                        "INVALID_ROLE"
                    );
                }

                const policy = await loadUserManagementPolicy(
                    context,
                    dbSession
                );
                const grantsAdministrator = isPrivilegedRole(policy, role);

                if (!canAssignRole(policy, role)) {
                    throw new UserManagementError(
                        403,
                        grantsAdministrator
                            ? "Only the business owner can create users with an administrator-level role"
                            : "You cannot assign a role with permissions you do not have",
                        "PRIVILEGE_ESCALATION_DENIED",
                        {
                            details: {
                                operation: "create",
                                email,
                                attemptedRoleId: String(role._id),
                                attemptedRoleName: role.name,
                            },
                        }
                    );
                }

                const duplicate = await User.exists({ tenantId, email }).session(
                    dbSession
                );

                if (duplicate) {
                    throw new UserManagementError(
                        409,
                        DUPLICATE_EMAIL_MESSAGE,
                        "DUPLICATE_EMAIL"
                    );
                }

                const [user] = await User.create(
                    [
                        {
                            tenantId,
                            name,
                            email,
                            passwordHash,
                            roleId: role._id,
                            status: "active",
                        },
                    ],
                    { session: dbSession }
                );

                const actor = {
                    userId: new Types.ObjectId(context.userId),
                    tenantId,
                    deviceId: new Types.ObjectId(context.deviceId),
                };

                // Never include the password or its hash in audit data.
                await AuditLogService.createAuditLog(
                    actor,
                    {
                        action: "user.created",
                        entity: "User",
                        entityId: user._id,
                        description: `Created user ${email}`,
                        newValues: {
                            name,
                            email,
                            roleId: String(role._id),
                            roleName: role.name,
                            status: "active",
                        },
                    },
                    dbSession
                );

                if (grantsAdministrator) {
                    await AuditLogService.createAuditLog(
                        actor,
                        {
                            action: "user.admin_granted",
                            entity: "User",
                            entityId: user._id,
                            description: `Granted administrator-level role ${role.name} to ${email}`,
                            newValues: {
                                roleId: String(role._id),
                                roleName: role.name,
                            },
                        },
                        dbSession
                    );
                }

                createdUser = publicUser(user, {
                    roleName: role.name,
                    ownerUserId: policy.ownerUserId,
                });
            });
        } finally {
            await dbSession.endSession();
        }

        if (!createdUser) {
            throw new Error("User creation transaction did not complete");
        }

        return NextResponse.json(
            {
                success: true,
                message: "User created successfully",
                user: createdUser,
            },
            { status: 201 }
        );
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

        console.error("POST /api/users error:", error);
        return errorResponse("Unable to create user", 500);
    }
}
