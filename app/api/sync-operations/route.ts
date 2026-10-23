import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { connectDB } from "@/lib/db/mongodb";
import { SyncOperation } from "@/lib/models/SyncOperation";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { SyncProcessError } from "@/lib/services/SyncErrors";
import {
    getGrantedBusinessPermissions,
    getSyncEntityPermission,
} from "@/lib/auth/businessPermissions";

import { uploadSchema, normalizeSupplierUpdatePayload } from "@/lib/validations/syncOperations";
import { isPurchaseWritePaused, createMaintenancePausedResponse } from "@/lib/config/writePause";

// Payloads are validated in detail when processed; here only shape and size.
const MAX_PAYLOAD_BYTES = 100_000;

function errorJson(error: SyncProcessError) {
    return NextResponse.json(error.toJSON(), { status: error.httpStatus });
}

// POST /api/sync-operations — upload one queued operation.
export async function POST(request: NextRequest) {
    try {
        const authContext = await getAuthenticatedContext(request);

        if (!authContext) {
            return NextResponse.json(
                { success: false, code: "UNAUTHENTICATED", retryable: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return errorJson(new SyncProcessError(400, "INVALID_REQUEST", "Request body must be valid JSON", false));
        }

        // Narrow compatibility fix: normalize harmless status: "active" on legacy Supplier UPDATE
        if (
            body &&
            typeof body === "object" &&
            (body as any).entityType === "Supplier" &&
            (body as any).operationType === "UPDATE" &&
            (body as any).payload &&
            typeof (body as any).payload === "object"
        ) {
            body = {
                ...(body as any),
                payload: normalizeSupplierUpdatePayload((body as any).payload),
            };
        }

        const parsed = uploadSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    code: "INVALID_REQUEST",
                    retryable: false,
                    message: "Invalid sync operation",
                    errors: z.flattenError(parsed.error),
                },
                { status: 400 }
            );
        }

        const input = parsed.data;

        if (JSON.stringify(input.payload).length > MAX_PAYLOAD_BYTES) {
            return errorJson(new SyncProcessError(400, "INVALID_REQUEST", "Payload is too large", false));
        }

        // Never upload one account's queued work under another session.
        if (
            input.owner.tenantId.toLowerCase() !== authContext.tenantId ||
            input.owner.userId.toLowerCase() !== authContext.userId ||
            input.owner.deviceId.toLowerCase() !== authContext.deviceId
        ) {
            return errorJson(
                new SyncProcessError(
                    403,
                    "OWNER_MISMATCH",
                    "This operation was queued by another account or device and was not uploaded",
                    false
                )
            );
        }

        await connectDB();

        // Operation types without an explicit permission mapping are never
        // accepted (deny by default), whatever the user's role.
        const requiredPermission = getSyncEntityPermission(input.entityType);

        if (!requiredPermission) {
            return errorJson(
                new SyncProcessError(
                    403,
                    "PERMISSION_DENIED",
                    "This type of operation cannot be synchronized",
                    false
                )
            );
        }

        // The user must be allowed to perform this kind of operation. It is
        // checked again (with the role at that time) when it is processed.
        const granted = await getGrantedBusinessPermissions(authContext, [requiredPermission]);

        if (!granted.has(requiredPermission)) {
            return errorJson(
                new SyncProcessError(
                    403,
                    "PERMISSION_DENIED",
                    "You do not have permission to record this operation",
                    false
                )
            );
        }

        // Maintenance check: reject Purchase sync uploads when write-pause is active
        if (input.entityType === "Purchase" && isPurchaseWritePaused()) {
            return createMaintenancePausedResponse(
                "Purchase sync upload is temporarily paused for database maintenance. Please retry shortly."
            );
        }

        // Identity always comes from the authenticated session.
        const tenantId = new mongoose.Types.ObjectId(authContext.tenantId);
        const userId = new mongoose.Types.ObjectId(authContext.userId);
        const deviceId = new mongoose.Types.ObjectId(authContext.deviceId);

        try {
            const syncOperation = await SyncOperation.create({
                tenantId,
                userId,
                deviceId,
                operationId: input.operationId,
                operationType: input.operationType,
                entityType: input.entityType,
                entityId: input.entityId
                    ? new mongoose.Types.ObjectId(input.entityId)
                    : (input.operationType === "UPDATE" && "customerId" in input.payload && typeof input.payload.customerId === "string"
                        ? new mongoose.Types.ObjectId(input.payload.customerId)
                        : undefined),
                payload: input.payload,
                status: "PENDING",
                attempts: 0,
            });

            return NextResponse.json(
                {
                    success: true,
                    alreadyExists: false,
                    operationId: syncOperation.operationId,
                    status: syncOperation.status,
                },
                { status: 201 }
            );
        } catch (error) {
            if (!(error instanceof mongoose.mongo.MongoServerError && error.code === 11000)) {
                throw error;
            }

            // Re-upload after a lost response is normal: accept it only if
            // the existing operation belongs to this same user and device.
            const existing = await SyncOperation.findOne({ tenantId, operationId: input.operationId })
                .select("deviceId userId status")
                .lean();

            if (
                existing &&
                existing.deviceId.equals(deviceId) &&
                (!existing.userId || existing.userId.equals(userId))
            ) {
                return NextResponse.json({
                    success: true,
                    alreadyExists: true,
                    operationId: input.operationId,
                    status: existing.status,
                });
            }

            return errorJson(
                new SyncProcessError(
                    409,
                    "OPERATION_ID_CONFLICT",
                    "This operation ID is already used by another device or user",
                    false
                )
            );
        }
    } catch (error: unknown) {
        console.error(
            "Create sync operation error:",
            error instanceof Error ? error.name : "unknown"
        );

        return errorJson(
            new SyncProcessError(503, "RETRYABLE_FAILURE", "Temporary problem while uploading; retry later", true)
        );
    }
}
