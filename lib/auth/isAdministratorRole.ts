
import mongoose from "mongoose";

import { Permission } from "@/lib/models/Permission";
import { Role } from "@/lib/models/Role";

const ADMIN_PERMISSIONS = [
    "users.create",
    "users.update",
    "users.delete",
] as const;

/**
 * Roles with full user-management access (create + update + delete).
 *
 * Used ONLY for last-active-administrator (lockout) protection.
 * It must not be used to decide who may grant administrator access;
 * that decision belongs to lib/auth/userManagementPolicy.ts.
 */
export async function getAdministratorRoleIds(
    tenantId: mongoose.Types.ObjectId,
    session?: mongoose.ClientSession
): Promise<mongoose.Types.ObjectId[]> {
    const permissionQuery = Permission.find({
        name: { $in: [...ADMIN_PERMISSIONS] },
    }).select("_id name");

    if (session) {
        permissionQuery.session(session);
    }

    const permissions = await permissionQuery.lean();

    // Fail safely if any required permission is missing.
    const permissionIds = ADMIN_PERMISSIONS.map((name) => {
        const permission = permissions.find(
            (item) => item.name === name
        );

        if (!permission) {
            throw new Error(
                `Required permission is missing: ${name}`
            );
        }

        return permission._id;
    });

    const roleQuery = Role.find({
        tenantId,
        status: "active",
        permissions: { $all: permissionIds },
    }).select("_id");

    if (session) {
        roleQuery.session(session);
    }

    const roles = await roleQuery.lean();

    return roles.map(
        (role) => role._id as mongoose.Types.ObjectId
    );
}
