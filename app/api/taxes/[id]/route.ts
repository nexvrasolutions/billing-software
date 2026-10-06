import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Tax } from "@/lib/models/Tax";

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
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

        const { id } = await params;

        // Validate tax ID
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid tax ID",
                },
                { status: 400 }
            );
        }

        // Find tax belonging to this tenant
        const tax = await Tax.findOne({
            _id: id,
            tenantId: user.tenantId,
        });

        if (!tax) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Tax not found",
                },
                { status: 404 }
            );
        }

        // Already inactive
        if (tax.status === "inactive") {
            return NextResponse.json(
                {
                    success: false,
                    message: "Tax is already inactive",
                },
                { status: 400 }
            );
        }

        // Soft delete
        tax.status = "inactive";

        await tax.save();

        return NextResponse.json(
            {
                success: true,
                message: "Tax deactivated successfully",
                tax,
            },
            { status: 200 }
        );
    } catch (error) {
        console.error("Delete tax error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to deactivate tax",
            },
            { status: 500 }
        );
    }
}