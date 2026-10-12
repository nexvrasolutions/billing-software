import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { PurchaseReturnService } from "@/lib/services/PurchaseReturnService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    requireBusinessPermission,
} from "@/lib/auth/businessPermissions";

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
            BUSINESS_PERMISSIONS.purchaseReturnsCreate
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

        // 3. Read request body
        const body = await request.json();

        // 4. Create purchase return using authenticated tenant
        const purchaseReturn =
            await PurchaseReturnService.createPurchaseReturn(
                user,
                body
            );

        return NextResponse.json(
            {
                success: true,
                message:
                    "Purchase return created successfully",
                purchaseReturn,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error(
            "PURCHASE RETURN API ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Failed to create purchase return",
            },
            { status: 400 }
        );
    }
}