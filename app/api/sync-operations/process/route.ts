import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { connectDB } from "@/lib/db/mongodb";
import { SyncService } from "@/lib/services/SyncService";
import { SyncProcessError, classifySyncError } from "@/lib/services/SyncErrors";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

const processSchema = z.strictObject({
    // Legacy operations may have non-UUID IDs, so any bounded string.
    operationId: z.string().trim().min(1).max(200),
});

function errorJson(error: SyncProcessError) {
    return NextResponse.json(error.toJSON(), {
        status: error.httpStatus,
        headers: error.retryAfterSeconds !== undefined
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : undefined,
    });
}

/*
 * POST /api/sync-operations/process
 *
 * 200 synced (or already synced)
 * 400 invalid request            (retryable: false)
 * 401 not signed in
 * 403 OWNER_MISMATCH             (belongs to another user/device)
 * 403 PERMISSION_DENIED          (role does not allow it now; NEEDS_ATTENTION)
 * 404 NOT_FOUND                  (upload it first)
 * 409 IN_PROGRESS                (retryable, see Retry-After)
 * 422 PERMANENT_FAILURE / NEEDS_ATTENTION (never retried automatically)
 * 503 RETRYABLE_FAILURE          (temporary; retry with backoff)
 */
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

        const parsed = processSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    code: "INVALID_REQUEST",
                    retryable: false,
                    message: "Invalid request",
                    errors: z.flattenError(parsed.error),
                },
                { status: 400 }
            );
        }

        await connectDB();

        // Identity always comes from the authenticated session.
        const result = await SyncService.processOperation(
            {
                tenantId: new mongoose.Types.ObjectId(authContext.tenantId),
                userId: new mongoose.Types.ObjectId(authContext.userId),
                deviceId: new mongoose.Types.ObjectId(authContext.deviceId),
                roleId: authContext.roleId,
            },
            parsed.data.operationId
        );

        return NextResponse.json({
            success: true,
            alreadySynced: result.alreadySynced,
            operationId: result.operation.operationId,
            status: result.operation.status,
            ...(result.result ? { result: result.result } : {}),
            ...(result.result && "invoiceNo" in result.result ? {
                sale: {
                    id: result.result._id,
                    invoiceNo: result.result.invoiceNo,
                    provisionalInvoiceNo: result.result.provisionalInvoiceNo,
                }
            } : {}),
        });
    } catch (error: unknown) {
        if (error instanceof SyncProcessError) {
            return errorJson(error);
        }

        console.error(
            "Process sync operation error:",
            error instanceof Error ? error.name : "unknown"
        );

        const retryable = classifySyncError(error) === "RETRYABLE";
        return errorJson(
            retryable
                ? new SyncProcessError(503, "RETRYABLE_FAILURE", "Temporary problem while syncing; retry later", true)
                : new SyncProcessError(500, "RETRYABLE_FAILURE", "Unexpected error while syncing", true)
        );
    }
}
