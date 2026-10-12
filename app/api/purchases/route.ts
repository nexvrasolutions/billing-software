import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { PurchaseService } from "@/lib/services/PurchaseService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

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

        // 2. Convert trusted session IDs to MongoDB ObjectIds
        const user = {
            userId: new mongoose.Types.ObjectId(
                context.userId
            ),
            tenantId: new mongoose.Types.ObjectId(
                context.tenantId
            ),
        };

        // 3. Read request body
        const body = await request.json();

        // 4. Create purchase using authenticated tenant
        const purchase =
            await PurchaseService.createPurchase(
                user,
                body
            );

        return NextResponse.json(
            {
                success: true,
                message:
                    "Purchase created successfully",
                purchase,
            },
            { status: 201 }
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
                    error instanceof Error
                        ? error.message
                        : "Failed to create purchase",
            },
            { status: 400 }
        );
    }
}