import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { LedgerService } from "@/lib/services/LedgerService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

export async function POST(request: NextRequest) {
    try {
        const authContext =
            await getAuthenticatedContext(request);

        if (!authContext) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Not authenticated or invalid authentication context",
                },
                { status: 401 }
            );
        }

        await connectDB();

        const body = await request.json();

        if (
            !body.entries ||
            !Array.isArray(body.entries) ||
            body.entries.length === 0
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "entries array is required",
                },
                { status: 400 }
            );
        }

        const user = {
            userId: new mongoose.Types.ObjectId(
                authContext.userId
            ),
            tenantId: new mongoose.Types.ObjectId(
                authContext.tenantId
            ),
        };

        const ledgerEntries =
            await LedgerService.createEntries(
                user,
                body.entries
            );

        return NextResponse.json(
            {
                success: true,
                message:
                    "Ledger entries created successfully",
                ledgerEntries,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error(
            "LEDGER API ERROR:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Failed to create ledger entries",
            },
            { status: 400 }
        );
    }
}