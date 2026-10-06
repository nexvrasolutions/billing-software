import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Tax } from "@/lib/models/Tax"; export async function GET() {
    try {
        await connectDB();

        // Temporary test user and tenant
        // We will replace these with real authentication later.
        const user = {
            userId: new mongoose.Types.ObjectId(
                "6abe4d3f6ae4b08a3e335463"
            ),
            tenantId: new mongoose.Types.ObjectId(
                "6abe48a86ae4b08a3e335303"
            ),
        };

        // Get taxes belonging only to this tenant
        const taxes = await Tax.find({
            tenantId: user.tenantId,
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
        console.error("Get taxes error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to fetch taxes",
            },
            { status: 500 }
        );
    }
}