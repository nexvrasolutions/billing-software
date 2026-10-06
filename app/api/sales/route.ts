import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { SalesService } from "@/lib/services/SalesService";

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