import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { AuditLog } from "@/lib/models/AuditLog";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";
import {
    AUDIT_LOG_PUBLIC_FIELDS,
    AUDIT_LOG_READ_PERMISSION,
    listAuditLogsQuerySchema,
    publicAuditLog,
} from "@/lib/auditLogs/auditLogApi";
import {
    errorResponse,
    validationErrorResponse,
} from "@/lib/users/userApi";

/*
 * Audit logs are written ONLY by trusted server-side code through
 * AuditLogService (inside the same transaction as the change they record).
 * There is deliberately no POST handler: clients must never be able to
 * create audit records, choose the actor/device, or fabricate events such
 * as "user.admin_granted". Next.js answers other methods with 405.
 */

// GET /api/audit-logs?page=1&limit=50&action=user.created&entity=User&entityId=...
export async function GET(
    request: NextRequest
) {
    try {
        const context =
            await getAuthenticatedContext(request);

        if (!context) {
            return errorResponse("Authentication required", 401);
        }

        await connectDB();

        const allowed = await hasPermission({
            userId: context.userId,
            tenantId: context.tenantId,
            roleId: context.roleId,
            permission: AUDIT_LOG_READ_PERMISSION,
        });

        if (!allowed) {
            return errorResponse("Permission denied", 403);
        }

        const parsedQuery = listAuditLogsQuerySchema.safeParse(
            Object.fromEntries(request.nextUrl.searchParams)
        );

        if (!parsedQuery.success) {
            return validationErrorResponse(
                "Invalid query parameters",
                parsedQuery.error
            );
        }

        const { page, limit, action, entity, entityId } =
            parsedQuery.data;

        // Tenant isolation: tenantId always comes from the verified session.
        const filter: Record<string, unknown> = {
            tenantId: new mongoose.Types.ObjectId(context.tenantId),
        };

        if (action) filter.action = action;
        if (entity) filter.entity = entity;
        if (entityId) filter.entityId = new mongoose.Types.ObjectId(entityId);

        const [auditLogs, total] = await Promise.all([
            AuditLog.find(filter)
                .select(AUDIT_LOG_PUBLIC_FIELDS)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            AuditLog.countDocuments(filter),
        ]);

        return NextResponse.json({
            success: true,
            auditLogs: auditLogs.map(publicAuditLog),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error(
            "Audit log fetch error:",
            error
        );

        return errorResponse("Failed to fetch audit logs", 500);
    }
}
