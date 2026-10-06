import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { StockService } from "@/lib/services/StockService";

const TEST_TENANT_ID = "6abe48a86ae4b08a3e335303";
const TEST_USER_ID = "6abe4d3f6ae4b08a3e335463";

export async function POST(request: Request) {
    try {
        await connectDB();

        const body = await request.json();

        // Validate product ID
        if (
            !body.productId ||
            !mongoose.isValidObjectId(body.productId)
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Valid productId is required",
                },
                { status: 400 }
            );
        }

        // Validate quantity
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

        // Validate warehouse
        if (!body.warehouse?.name?.trim()) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Warehouse name is required",
                },
                { status: 400 }
            );
        }

        // Validate reason
        if (!body.reason?.trim()) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Reason is required for stock adjustment",
                },
                { status: 400 }
            );
        }

        const user = {
            userId: new mongoose.Types.ObjectId(TEST_USER_ID),
            tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),
        };

        const result = await StockService.changeStock(
            user,
            {
                productId: body.productId,
                quantity: body.quantity,
                type: "adjustment",
                warehouse: {
                    name: body.warehouse.name,
                    location: body.warehouse.location,
                },
                reason: body.reason,
            }
        );

        return NextResponse.json(
            {
                success: true,
                message: "Stock adjustment completed successfully",
                result,
            },
            { status: 200 }
        );
    } catch (error) {
        console.error("Stock adjustment error:", error);

        return NextResponse.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Stock adjustment failed",
            },
            { status: 500 }
        );
    }
}