import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { SyncService } from "@/lib/services/SyncService";

export async function POST(request: NextRequest) {
    try {
        await connectDB();

        const body = await request.json();

        const {
            tenantId,
            operationId,
        } = body;

        // --------------------------------------------------
        // 1. Validate tenant ID
        // --------------------------------------------------

        if (!tenantId) {
            return NextResponse.json(
                {
                    success: false,
                    message: "tenantId is required",
                },
                { status: 400 }
            );
        }

        if (
            !mongoose.Types.ObjectId.isValid(
                tenantId
            )
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid tenantId",
                },
                { status: 400 }
            );
        }

        // --------------------------------------------------
        // 2. Validate operation ID
        // --------------------------------------------------

        if (!operationId?.trim()) {
            return NextResponse.json(
                {
                    success: false,
                    message: "operationId is required",
                },
                { status: 400 }
            );
        }

        // --------------------------------------------------
        // 3. Process operation
        // --------------------------------------------------

        const result =
            await SyncService.processOperation(
                {
                    tenantId:
                        new mongoose.Types.ObjectId(
                            tenantId
                        ),
                },
                operationId.trim()
            );

        // --------------------------------------------------
        // 4. Return success
        // --------------------------------------------------

        return NextResponse.json(
            result,
            { status: 200 }
        );
    } catch (error: unknown) {
        console.error(
            "Process sync operation error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Failed to process sync operation",
            },
            { status: 500 }
        );
    }
}