import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { SalesService } from "@/lib/services/SalesService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

export async function POST(
    request: NextRequest
) {
    try {
        // 1. Get authenticated tenant/device/user context
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

        // 4. Create sale using authenticated tenant
        const sale =
            await SalesService.createSale(
                user,
                body
            );

        return NextResponse.json(
            {
                success: true,
                message:
                    "Sale created successfully",
                sale,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error(
            "SALE API ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Failed to create sale",
            },
            { status: 400 }
        );
    }
}