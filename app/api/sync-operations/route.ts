import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { connectDB } from "@/lib/db/mongodb";
import { SyncOperation } from "@/lib/models/SyncOperation";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { SyncProcessError } from "@/lib/services/SyncErrors";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid ID");

// Payloads are validated in detail when processed; here only shape and size.
const MAX_PAYLOAD_BYTES = 100_000;

const uploadSchema = z.strictObject({
    // Generated on the device with crypto.randomUUID().
    operationId: z.uuid("operationId must be a UUID"),
    // Processing always creates records, so only CREATE is accepted.
    operationType: z.literal("CREATE"),
    // Only entity types the server can actually process.
    entityType: z.enum(["Sale", "Purchase", "SalesReturn", "PurchaseReturn", "Payment", "StockAdjustment"]),
    entityId: objectIdSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
    // The account that queued the operation on the device. It is only
    // compared with the session: identity is always taken from the session.
    owner: z.strictObject({
        tenantId: objectIdSchema,
        userId: objectIdSchema,
        deviceId: objectIdSchema,
    }),
});

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
                entityId: input.entityId ? new mongoose.Types.ObjectId(input.entityId) : undefined,
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
