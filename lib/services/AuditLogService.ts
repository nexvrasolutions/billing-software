
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
     * When a MongoDB session is provided, the audit log participates
     * in the same transaction as the related business operation.
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

        // TEMPORARY LOCAL TEST ONLY.
        // Set this environment variable to "true" to simulate audit failure.
        if (
            process.env.TEST_AUDIT_LOG_FAILURE === "true" &&
            process.env.NODE_ENV !== "production"
        ) {
            throw new Error("TEST_ONLY_AUDIT_FAILURE");
        }

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

