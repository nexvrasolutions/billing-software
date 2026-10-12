
import { Types } from "mongoose";
import { User } from "@/lib/models/User";
import { Role } from "@/lib/models/Role";
import { Permission } from "@/lib/models/Permission";

interface HasPermissionInput {
    userId: string;
    tenantId: string;
    roleId?: string;
    permission: string;
}

export async function hasPermission({
    userId,
    tenantId,
    roleId,
    permission,
}: HasPermissionInput): Promise<boolean> {
    // 1. Reject missing or invalid inputs.
    if (
        !roleId ||
        !Types.ObjectId.isValid(userId) ||
        !Types.ObjectId.isValid(tenantId) ||
        !Types.ObjectId.isValid(roleId) ||
        typeof permission !== "string" ||
        !permission.trim()
    ) {
        return false;
    }

    const normalizedUserId = new Types.ObjectId(userId);
    const normalizedTenantId = new Types.ObjectId(tenantId);
    const normalizedRoleId = new Types.ObjectId(roleId);
    const normalizedPermission = permission.trim();

    // 2. Verify that the user exists, is active,
    // and belongs to the requested tenant.
    const user = await User.findOne({
        _id: normalizedUserId,
        tenantId: normalizedTenantId,
        status: "active",
    })
        .select("roleId")
        .lean();

    if (!user || !user.roleId) {
        return false;
    }

    // 3. Verify that the supplied role is the user's actual role.
    if (
        user.roleId.toString() !== normalizedRoleId.toString()
    ) {
        return false;
    }

    // 4. Verify that the role is active and belongs to this tenant.
    const role = await Role.findOne({
        _id: normalizedRoleId,
        tenantId: normalizedTenantId,
        status: "active",
    })
        .select("permissions")
        .lean();

    if (!role || !role.permissions?.length) {
        return false;
    }

    // 5. Find the requested permission in the global permission catalog.
    const permissionRecord = await Permission.findOne({
        name: normalizedPermission,
    })
        .select("_id")
        .lean();

    if (!permissionRecord) {
        return false;
    }

    // 6. Grant access only if the user's actual role
    // contains the requested permission.
    return role.permissions.some(
        (permissionId) =>
            permissionId.toString() ===
            permissionRecord._id.toString()
    );
}
