import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { PurchaseService } from "@/lib/services/PurchaseService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    requireBusinessPermission,
    requireAnyBusinessPermission,
} from "@/lib/auth/businessPermissions";
import { publicErrorMessage } from "@/lib/api/publicError";

import { connectDB } from "@/lib/db/mongodb";
import { Purchase } from "@/lib/models/Purchase";
import { createPurchaseSchema } from "@/lib/validations/purchase";

export async function GET(request: NextRequest) {
    try {
        const context = await getAuthenticatedContext(request);
        if (!context) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        const denied = await requireAnyBusinessPermission(context, [
            BUSINESS_PERMISSIONS.purchasesRead,
            BUSINESS_PERMISSIONS.purchasesCreate,
        ]);
        if (denied) {
            return denied;
        }

        await connectDB();
        const purchases = await Purchase.find({
            tenantId: new mongoose.Types.ObjectId(context.tenantId),
        })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        return NextResponse.json({
            success: true,
            purchases,
        });
    } catch (error) {
        console.error("GET PURCHASES ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load purchases" },
            { status: 500 }
        );
    }
}

export async function POST(
    request: NextRequest
) {
    try {
        // 1. Get authenticated user/tenant/device context
        const context =
            await getAuthenticatedContext(request);

        if (!context) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Not authenticated or invalid authentication context",
                },
                { status: 401 }
            );
        }

        // 1b. Permission (the user's current role, checked on the server)
        const denied = await requireBusinessPermission(
            context,
            BUSINESS_PERMISSIONS.purchasesCreate
        );

        if (denied) {
            return denied;
        }

        // 2. Convert trusted session IDs to MongoDB ObjectIds
        const user = {
            userId: new mongoose.Types.ObjectId(
                context.userId
            ),
            tenantId: new mongoose.Types.ObjectId(
                context.tenantId
            ),
        };

        // 3. Read request body safely
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { success: false, message: "Invalid JSON request body" },
                { status: 400 }
            );
        }

        // 4. Validate request body against schema
        const parsed = createPurchaseSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid purchase data",
                    errors: parsed.error.issues.map((issue) => ({
                        field: issue.path.join("."),
                        message: issue.message,
                    })),
                },
                { status: 400 }
            );
        }

        // 5. Idempotency pre-check for sequential retries
        const normalizedOperationId = parsed.data.operationId?.trim() || undefined;

        if (normalizedOperationId) {
            await connectDB();
            const existingPurchase = await Purchase.findOne({
                tenantId: user.tenantId,
                operationId: normalizedOperationId,
            }).lean();

            if (existingPurchase) {
                return NextResponse.json(
                    {
                        success: true,
                        message: "Purchase was already processed",
                        purchase: existingPurchase,
                        alreadyProcessed: true,
                    },
                    { status: 200 }
                );
            }
        }

        // 6. Create purchase using authenticated tenant and forwarded operationId
        const purchase =
            await PurchaseService.createPurchase(
                user,
                parsed.data,
                normalizedOperationId
            );

        const alreadyProcessed = Boolean((purchase as { alreadyProcessed?: boolean } | null | undefined)?.alreadyProcessed);

        return NextResponse.json(
            {
                success: true,
                message: alreadyProcessed
                    ? "Purchase was already processed"
                    : "Purchase created successfully",
                purchase,
                ...(alreadyProcessed ? { alreadyProcessed: true } : {}),
            },
            { status: alreadyProcessed ? 200 : 201 }
        );
    } catch (error) {
        console.error(
            "PURCHASE API ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    publicErrorMessage(error, "Failed to create purchase"),
            },
            { status: 400 }
        );
    }
}