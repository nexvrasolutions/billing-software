import { NextRequest, NextResponse } from "next/server";

import { Tax } from "@/lib/models/Tax";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    requireBusinessPermission,
} from "@/lib/auth/businessPermissions";

export async function GET(
    request: NextRequest
) {
    try {
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

        const denied = await requireBusinessPermission(
            context,
            BUSINESS_PERMISSIONS.taxesRead
        );

        if (denied) {
            return denied;
        }

        // Get taxes belonging only to the authenticated tenant
        const taxes = await Tax.find({
            tenantId: context.tenantId,
        })
            .sort({ createdAt: -1 })
            .lean();

        return NextResponse.json(
            {
                success: true,
                message: "Taxes fetched successfully",
                taxes,
            },
            { status: 200 }
        );
    } catch (error) {
        console.error(
            "Get taxes error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Failed to fetch taxes",
            },
            { status: 500 }
        );
    }
}