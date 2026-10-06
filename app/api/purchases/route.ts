import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { PurchaseService } from "@/lib/services/PurchaseService";

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

        const purchase =
            await PurchaseService.createPurchase(
                user,
                body
            );

        return NextResponse.json(
            {
                success: true,
                message: "Purchase created successfully",
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