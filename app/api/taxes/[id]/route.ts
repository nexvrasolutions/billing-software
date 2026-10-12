import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { Tax } from "@/lib/models/Tax";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const context =
            await getAuthenticatedContext(request);

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

        // Find tax belonging only to the authenticated tenant
        const tax = await Tax.findOne({
            _id: id,
            tenantId: context.tenantId,
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
        console.error(
            "Delete tax error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message: "Failed to deactivate tax",
            },
            { status: 500 }
        );
    }
}