
import { NextResponse } from "next/server";
import mongoose, { Types } from "mongoose";
import { z } from "zod";

import { AuditLogService } from "@/lib/services/AuditLogService";

const objectIdSchema = z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid ID");

const nameSchema = z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters");

const emailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
        z
            .email("Enter a valid email address")
            .max(254, "Email must be at most 254 characters")
    );

export const passwordSchema = z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(128, "Password must be at most 128 characters");

// Strict schemas reject unknown fields such as tenantId, passwordHash,
// ownerUserId or audit metadata instead of silently ignoring them.
export const createUserSchema = z.strictObject({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    roleId: objectIdSchema,
});

export const updateUserSchema = z
    .strictObject({
        name: nameSchema.optional(),
        email: emailSchema.optional(),
        roleId: objectIdSchema.nullable().optional(),
        status: z.enum(["active", "inactive"]).optional(),
    })
    .refine(
        (data) =>
            data.name !== undefined ||
            data.email !== undefined ||
            data.roleId !== undefined ||
            data.status !== undefined,
        { message: "At least one field must be provided" }
    );

// Admin-initiated password reset. The admin chooses the temporary password;
// the server never generates or returns passwords.
export const resetPasswordSchema = z.strictObject({
    newPassword: passwordSchema,
});

export const listUsersQuerySchema = z.strictObject({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["active", "inactive"]).optional(),
});

/**
 * Thrown inside user-management transactions. Throwing aborts the
 * transaction, so no partial user/audit data is committed.
 */
export class UserManagementError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly code: string,
        public readonly deniedAttempt?: {
            entityId?: Types.ObjectId;
            details: Record<string, unknown>;
        }
    ) {
        super(message);
        this.name = "UserManagementError";
    }
}

export function errorResponse(message: string, status: number) {
    return NextResponse.json({ success: false, message }, { status });
}

export function validationErrorResponse(
    message: string,
    error: z.ZodError
) {
    return NextResponse.json(
        {
            success: false,
            message,
            errors: z.flattenError(error),
        },
        { status: 400 }
    );
}

export async function readJsonBody(
    request: Request
): Promise<{ ok: true; body: unknown } | { ok: false }> {
    try {
        return { ok: true, body: await request.json() };
    } catch {
        return { ok: false };
    }
}

interface UserRecord {
    _id: unknown;
    name: string;
    email: string;
    roleId?: unknown;
    status: string;
    createdAt?: Date;
    updatedAt?: Date;
}

/**
 * The only shape in which users leave the API.
 * Explicitly lists safe fields so passwordHash can never leak.
 */
export function publicUser(
    user: UserRecord,
    extra: {
        roleName?: string | null;
        ownerUserId?: string | null;
        canEdit?: boolean;
    } = {}
) {
    const id = String(user._id);

    return {
        id,
        name: user.name,
        email: user.email,
        roleId: user.roleId ? String(user.roleId) : null,
        roleName: extra.roleName ?? null,
        status: user.status,
        isOwner: extra.ownerUserId != null && extra.ownerUserId === id,
        ...(extra.canEdit !== undefined ? { canEdit: extra.canEdit } : {}),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}

export function isDuplicateKeyError(error: unknown): boolean {
    return (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000
    );
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Record a blocked privilege-escalation attempt.
 * Written after the transaction aborted, so it is best-effort:
 * a failure here must not change the 403 the caller receives.
 */
export async function auditDeniedAttempt(
    auth: { userId: string; tenantId: string; deviceId: string },
    error: UserManagementError
): Promise<void> {
    if (!error.deniedAttempt) {
        return;
    }

    try {
        await AuditLogService.createAuditLog(
            {
                userId: new Types.ObjectId(auth.userId),
                tenantId: new Types.ObjectId(auth.tenantId),
                deviceId: new Types.ObjectId(auth.deviceId),
            },
            {
                action: "user.privilege_escalation_denied",
                entity: "User",
                entityId: error.deniedAttempt.entityId,
                description: error.message,
                newValues: error.deniedAttempt.details,
            }
        );
    } catch {
        console.error(
            "Failed to record denied privilege escalation attempt"
        );
    }
}
