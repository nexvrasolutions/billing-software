import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { LedgerService } from "@/lib/services/LedgerService";

export async function POST(request: Request) {
    try {
        await connectDB();

        const body = await request.json();

        // TEMPORARY TEST USER
        const user = {
            userId: new mongoose.Types.ObjectId(
                "6abe4d3f6ae4b08a3e335463"
            ),
            tenantId: new mongoose.Types.ObjectId(
                "6abe48a86ae4b08a3e335303"
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