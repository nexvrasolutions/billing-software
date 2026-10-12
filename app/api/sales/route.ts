import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { SalesService } from "@/lib/services/SalesService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    BusinessPermissionError,
    SALE_DATE_RULES,
    getGrantedBusinessPermissions,
} from "@/lib/auth/businessPermissions";

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

        // 1b. Permissions (the user's current role, checked on the server)
        const granted = await getGrantedBusinessPermissions(context, [
            BUSINESS_PERMISSIONS.salesCreate,
            BUSINESS_PERMISSIONS.salesPriceOverride,
            BUSINESS_PERMISSIONS.salesBackdate,
        ]);

        if (!granted.has(BUSINESS_PERMISSIONS.salesCreate)) {
            return NextResponse.json(
                { success: false, message: "Permission denied" },
                { status: 403 }
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
            deviceId: new mongoose.Types.ObjectId(
                context.deviceId
            ),
        };

        // 3. Read request body
        const body = await request.json();

        // 4. Create sale using authenticated tenant. An online sale never
        //    carries an offline operation ID.
        const sale =
            await SalesService.createSale(
                user,
                body,
                undefined,
                {
                    allowPriceOverride: granted.has(BUSINESS_PERMISSIONS.salesPriceOverride),
                    allowBackdate: granted.has(BUSINESS_PERMISSIONS.salesBackdate),
                    referenceTime: new Date(),
                    maxAgeMs: SALE_DATE_RULES.onlineMaxAgeMs,
                }
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
            { status: error instanceof BusinessPermissionError ? 403 : 400 }
        );
    }
}