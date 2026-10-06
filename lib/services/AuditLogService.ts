import mongoose from "mongoose";
import { AuditLog } from "@/lib/models/AuditLog";

export interface AuditLogUserContext {
    userId: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    deviceId?: mongoose.Types.ObjectId;
}

export interface CreateAuditLogInput {
    action: string;
    entity: string;
    entityId?: mongoose.Types.ObjectId;

    description?: string;

    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
}

export class AuditLogService {
    /**
     * Create an audit log.
     *
     * This method can optionally receive a MongoDB session.
     * When a session is provided, the audit log becomes part
     * of the same transaction as the business operation.
     */
    static async createAuditLog(
        user: AuditLogUserContext,
        input: CreateAuditLogInput,
        session?: mongoose.ClientSession
    ) {
        if (!user.userId) {
            throw new Error("User ID is required");
        }

        if (!user.tenantId) {
            throw new Error("Tenant ID is required");
        }

        if (!input.action?.trim()) {
            throw new Error("Audit action is required");
        }

        if (!input.entity?.trim()) {
            throw new Error("Audit entity is required");
        }

        const auditLogData = {
            tenantId: user.tenantId,
            userId: user.userId,
            deviceId: user.deviceId,

            action: input.action.trim(),
            entity: input.entity.trim(),

            entityId: input.entityId,

            description: input.description?.trim(),

            oldValues: input.oldValues,
            newValues: input.newValues,
        };

        const [auditLog] = await AuditLog.create(
            [auditLogData],
            {
                session,
                ordered: true,
            }
        );

        return auditLog;
    }
}