import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { StockService } from "@/lib/services/StockService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    requireBusinessPermission,
} from "@/lib/auth/businessPermissions";
import { publicErrorMessage } from "@/lib/api/publicError";

export async function POST(
    request: NextRequest
) {
    try {
        // --------------------------------------------------
        // 1. Get authenticated user/tenant context
        // --------------------------------------------------

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

        // Permission (the user's current role, checked on the server)
        const denied = await requireBusinessPermission(
            context,
            BUSINESS_PERMISSIONS.stockAdjust
        );

        if (denied) {
            return denied;
        }

        const body =
            await request.json();

        // --------------------------------------------------
        // 2. Validate operationId
        // --------------------------------------------------

        if (
            !body.operationId ||
            typeof body.operationId !== "string" ||
            !body.operationId.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "operationId is required",
                },
                { status: 400 }
            );
        }

        const operationId =
            body.operationId.trim();

        // --------------------------------------------------
        // 3. Validate product ID
        // --------------------------------------------------

        if (
            !body.productId ||
            !mongoose.isValidObjectId(
                body.productId
            )
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Valid productId is required",
                },
                { status: 400 }
            );
        }

        // --------------------------------------------------
        // 4. Validate quantity
        // --------------------------------------------------

        if (
            typeof body.quantity !== "number" ||
            !Number.isFinite(body.quantity) ||
            body.quantity === 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Quantity must be a valid non-zero number",
                },
                { status: 400 }
            );
        }

        // --------------------------------------------------
        // 5. Validate warehouse
        // --------------------------------------------------

        if (
            !body.warehouse?.name?.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Warehouse name is required",
                },
                { status: 400 }
            );
        }

        // --------------------------------------------------
        // 6. Validate reason
        // --------------------------------------------------

        if (
            !body.reason?.trim()
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Reason is required for stock adjustment",
                },
                { status: 400 }
            );
        }

        // --------------------------------------------------
        // 7. Use authenticated user context
        // --------------------------------------------------

        const user = {
            userId:
                new mongoose.Types.ObjectId(
                    context.userId
                ),

            tenantId:
                new mongoose.Types.ObjectId(
                    context.tenantId
                ),
        };

        // --------------------------------------------------
        // 8. Process stock adjustment
        // --------------------------------------------------

        const result =
            await StockService.changeStock(
                user,
                {
                    productId:
                        body.productId,

                    quantity:
                        body.quantity,

                    type:
                        "adjustment",

                    warehouse: {
                        name:
                            body.warehouse.name,

                        location:
                            body.warehouse.location,
                    },

                    reason:
                        body.reason,
                },

                undefined,

                operationId
            );

        // --------------------------------------------------
        // 9. Response
        // --------------------------------------------------

        return NextResponse.json(
            {
                success: true,

                message:
                    result.alreadyProcessed
                        ? "Stock adjustment was already processed"
                        : "Stock adjustment completed successfully",

                result,
            },
            { status: 200 }
        );
    } catch (error) {
        console.error(
            "Stock adjustment error:",
            error
        );

        return NextResponse.json(
            {
                success: false,

                message:
                    publicErrorMessage(error, "Stock adjustment failed"),
            },
            { status: 500 }
        );
    }
}