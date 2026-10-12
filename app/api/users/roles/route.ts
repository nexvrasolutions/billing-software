
import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Role } from "@/lib/models/Role";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";
import {
    canAssignRole,
    isPrivilegedRole,
    loadUserManagementPolicy,
} from "@/lib/auth/userManagementPolicy";
import { errorResponse } from "@/lib/users/userApi";

// GET /api/users/roles
// Active roles of the caller's tenant, with whether the caller may assign
// each one. "assignable" is a UI hint; POST/PATCH re-check it on the server.
export async function GET(request: NextRequest) {
    try {
        const context = await getAuthenticatedContext(request);

        if (!context) {
            return errorResponse("Authentication required", 401);
        }

        await connectDB();

        const allowed = await hasPermission({
            userId: context.userId,
            tenantId: context.tenantId,
            roleId: context.roleId,
            permission: "users.read",
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const [roles, policy] = await Promise.all([
            Role.find({
                tenantId: new Types.ObjectId(context.tenantId),
                status: "active",
            })
                .select("_id name description permissions")
                .sort({ name: 1 })
                .lean(),
            loadUserManagementPolicy(context),
        ]);

        return NextResponse.json({
            success: true,
            roles: roles.map((role) => ({
                id: role._id.toString(),
                name: role.name,
                description: role.description ?? null,
                isAdministrator: isPrivilegedRole(policy, role),
                assignable: canAssignRole(policy, role),
            })),
        });
    } catch (error) {
        console.error("GET /api/users/roles error:", error);
        return errorResponse("Unable to retrieve roles", 500);
    }
}
