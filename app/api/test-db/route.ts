import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { SalesService } from "@/lib/services/SalesService";
import { connectDB } from "@/lib/db/mongodb";

export async function POST(request: Request) {
    try {
        await connectDB();

        const body = await request.json();

        const user = {
            userId: new mongoose.Types.ObjectId(
                "6abe4d3f6ae4b08a3e335463"
            ),
            tenantId: new mongoose.Types.ObjectId(
                "6abe48a86ae4b08a3e335303"
            ),
        };

        const sale = await SalesService.createSale(
            user,
            body
        );

        return NextResponse.json(
            {
                success: true,
                message: "Sale created successfully",
                sale,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error("SALE API ERROR:", error);

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