import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { AuditLog } from "@/lib/models/AuditLog";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";
import {
    AUDIT_LOG_PUBLIC_FIELDS,
    AUDIT_LOG_READ_PERMISSION,
    publicAuditLog,
} from "@/lib/auditLogs/auditLogApi";
import { errorResponse } from "@/lib/users/userApi";

type RouteContext = {
    params: Promise<{
        id: string;
    }>;
};

export async function GET(
    request: NextRequest,
    context: RouteContext
) {
    try {
        const authContext =
            await getAuthenticatedContext(request);

        if (!authContext) {
            return errorResponse("Authentication required", 401);
        }

        await connectDB();

        const allowed = await hasPermission({
            userId: authContext.userId,
            tenantId: authContext.tenantId,
            roleId: authContext.roleId,
            permission: AUDIT_LOG_READ_PERMISSION,
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const { id } = await context.params;

        // Validate audit log ID
        if (!/^[a-f\d]{24}$/i.test(id)) {
            return errorResponse("Invalid audit log ID", 400);
        }

        const auditLog = await AuditLog.findOne({
            _id: new mongoose.Types.ObjectId(id),

            // Tenant isolation:
            // only allow the authenticated user's tenant
            tenantId: new mongoose.Types.ObjectId(
                authContext.tenantId
            ),
        })
            .select(AUDIT_LOG_PUBLIC_FIELDS)
            .lean();

        if (!auditLog) {
            return errorResponse("Audit log not found", 404);
        }

        return NextResponse.json({
            success: true,
            auditLog: publicAuditLog(auditLog),
        });
    } catch (error) {
        console.error("Audit log fetch error:", error);

        return errorResponse("Failed to fetch audit log", 500);
    }
}
