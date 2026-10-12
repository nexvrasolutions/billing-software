
import mongoose, { Types } from "mongoose";

import { Permission } from "@/lib/models/Permission";
import { Role } from "@/lib/models/Role";
import { Tenant } from "@/lib/models/Tenant";
import { TenantAdminGuard } from "@/lib/models/TenantAdminGuard";

/*
 * Privilege policy for User Management.
 *
 * A role is "administrator-level" (privileged) when it grants ANY
 * user-management write permission. A user holding such a role can
 * change other accounts, so assigning it is the same as granting
 * administrator access, whatever the role is called.
 *
 * Rules:
 * 1. Only the tenant owner (Tenant.ownerUserId) may assign
 *    administrator-level roles, or change users who hold one.
 * 2. Everyone else may only assign non-administrator roles whose
 *    permissions are a subset of their own role's permissions, and only
 *    to users whose current role also satisfies that rule.
 * 3. The owner's own role and status cannot be changed through the API.
 *
 * The owner is designated only by a server-side script, never by a
 * client request. A tenant without a designated owner therefore cannot
 * grant administrator access through the API at all (fail closed).
 */
export const PRIVILEGED_PERMISSIONS = [
    "users.create",
    "users.update",
    "users.delete",
] as const;

export interface RoleForPolicy {
    _id: Types.ObjectId;
    permissions?: Types.ObjectId[];
}

export interface UserManagementPolicy {
    isOwner: boolean;
    ownerUserId: string | null;
    callerPermissionIds: Set<string>;
    privilegedPermissionIds: Set<string>;
}

interface PolicyCaller {
    userId: string;
    tenantId: string;
    roleId?: string;
}

/**
 * Load the caller's privileges from the database.
 * Every value comes from the verified session context and the database,
 * never from the request body.
 */
export async function loadUserManagementPolicy(
    caller: PolicyCaller,
    session?: mongoose.ClientSession
): Promise<UserManagementPolicy> {
    const tenantId = new Types.ObjectId(caller.tenantId);

    const tenantQuery = Tenant.findOne({
        _id: tenantId,
        status: "active",
    }).select("ownerUserId");

    const permissionQuery = Permission.find({
        name: { $in: [...PRIVILEGED_PERMISSIONS] },
    }).select("_id");

    const roleQuery =
        caller.roleId && Types.ObjectId.isValid(caller.roleId)
            ? Role.findOne({
                _id: new Types.ObjectId(caller.roleId),
                tenantId,
                status: "active",
            }).select("permissions")
            : null;

    if (session) {
        tenantQuery.session(session);
        permissionQuery.session(session);
        roleQuery?.session(session);
    }

    const [tenant, privilegedPermissions, callerRole] = await Promise.all([
        tenantQuery.lean(),
        permissionQuery.lean(),
        roleQuery ? roleQuery.lean() : Promise.resolve(null),
    ]);

    const ownerUserId = tenant?.ownerUserId?.toString() ?? null;

    return {
        isOwner: ownerUserId !== null && ownerUserId === caller.userId,
        ownerUserId,
        callerPermissionIds: new Set(
            (callerRole?.permissions ?? []).map((id) => id.toString())
        ),
        privilegedPermissionIds: new Set(
            privilegedPermissions.map((permission) => permission._id.toString())
        ),
    };
}

export function isPrivilegedRole(
    policy: UserManagementPolicy,
    role: RoleForPolicy | null | undefined
): boolean {
    if (!role) {
        return false;
    }

    return (role.permissions ?? []).some((id) =>
        policy.privilegedPermissionIds.has(id.toString())
    );
}

function isWithinCallerPermissions(
    policy: UserManagementPolicy,
    role: RoleForPolicy
): boolean {
    return (role.permissions ?? []).every((id) =>
        policy.callerPermissionIds.has(id.toString())
    );
}

/** Can the caller give this role to a user? */
export function canAssignRole(
    policy: UserManagementPolicy,
    role: RoleForPolicy
): boolean {
    if (policy.isOwner) {
        return true;
    }

    return (
        !isPrivilegedRole(policy, role) &&
        isWithinCallerPermissions(policy, role)
    );
}

/** Can the caller modify a user who currently holds this role? */
export function canManageUserWithRole(
    policy: UserManagementPolicy,
    currentRole: RoleForPolicy | null | undefined
): boolean {
    if (policy.isOwner || !currentRole) {
        return true;
    }

    return (
        !isPrivilegedRole(policy, currentRole) &&
        isWithinCallerPermissions(policy, currentRole)
    );
}

/**
 * Make sure the per-tenant guard document exists before any transaction
 * uses it. Creating it inside concurrent transactions could otherwise
 * fail with a duplicate-key error instead of a retryable write conflict.
 */
export async function ensureTenantAdminGuard(
    tenantId: Types.ObjectId
): Promise<void> {
    try {
        await TenantAdminGuard.updateOne(
            { tenantId },
            { $setOnInsert: { revision: 0 } },
            { upsert: true }
        );
    } catch (error) {
        // Another request created it at the same moment.
        if (
            !(error instanceof mongoose.mongo.MongoServerError) ||
            error.code !== 11000
        ) {
            throw error;
        }
    }
}

/**
 * Serialize privilege changes for one tenant.
 * Two transactions that both write the guard document conflict, so
 * MongoDB retries one of them after the other commits. The retry then
 * sees the committed state (for example, how many administrators remain).
 */
export async function lockTenantAdminGuard(
    tenantId: Types.ObjectId,
    session: mongoose.ClientSession
): Promise<void> {
    await TenantAdminGuard.updateOne(
        { tenantId },
        { $inc: { revision: 1 } },
        { session }
    );
}
