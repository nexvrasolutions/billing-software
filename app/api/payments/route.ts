import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { PaymentService } from "@/lib/services/PaymentService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    requireBusinessPermission,
} from "@/lib/auth/businessPermissions";
import { publicErrorMessage } from "@/lib/api/publicError";

export async function POST(request: NextRequest) {
    try {
        const context = await getAuthenticatedContext(request);

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
            BUSINESS_PERMISSIONS.paymentsCreate
        );

        if (denied) {
            return denied;
        }

        const user = {
            userId: new mongoose.Types.ObjectId(
                context.userId
            ),

            tenantId: new mongoose.Types.ObjectId(
                context.tenantId
            ),
        };

        const body = await request.json();

        const result =
            await PaymentService.createPayment(
                user,
                body,
                body.operationId
            );

        return NextResponse.json(
            {
                success: true,

                message:
                    result?.alreadyProcessed
                        ? "Payment was already processed"
                        : "Payment processed successfully",

                result,
            },
            {
                status: 200,
            }
        );
    } catch (error) {
        console.error(
            "PAYMENT API ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,

                message:
                    publicErrorMessage(error, "Failed to process payment"),
            },
            {
                status: 400,
            }
        );
    }
}