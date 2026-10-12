
import { z } from "zod";

/**
 * Permission required to read audit logs.
 * It must exist in the Permission catalog AND be assigned to the caller's
 * active role; hasPermission() fails closed if either is missing.
 * Create/grant it with scripts/setup-audit-log-permission.ts.
 */
export const AUDIT_LOG_READ_PERMISSION = "auditLogs.read";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid ID");

// Strict: unknown query parameters (e.g. tenantId) are rejected.
export const listAuditLogsQuerySchema = z.strictObject({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().trim().min(1).max(100).optional(),
    entity: z.string().trim().min(1).max(100).optional(),
    entityId: objectIdSchema.optional(),
});

interface AuditLogRecord {
    _id: unknown;
    userId: unknown;
    deviceId?: unknown;
    action: string;
    entity: string;
    entityId?: unknown;
    description?: string;
    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    createdAt?: Date;
}

/** Fields selected from the database for audit-log viewers. */
export const AUDIT_LOG_PUBLIC_FIELDS =
    "_id userId deviceId action entity entityId description oldValues newValues createdAt";

/** The only shape in which audit logs leave the API. */
export function publicAuditLog(log: AuditLogRecord) {
    return {
        id: String(log._id),
        action: log.action,
        entity: log.entity,
        entityId: log.entityId ? String(log.entityId) : null,
        description: log.description ?? null,
        actorUserId: String(log.userId),
        deviceId: log.deviceId ? String(log.deviceId) : null,
        oldValues: log.oldValues ?? null,
        newValues: log.newValues ?? null,
        createdAt: log.createdAt,
    };
}
