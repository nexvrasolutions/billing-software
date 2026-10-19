import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Purchase } from "@/lib/models/Purchase";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

type RouteContext = {
    params: Promise<{ id: string }>;
};

export async function GET(
    request: NextRequest,
    context: RouteContext
) {
    try {
        const auth = await getAuthenticatedContext(request);
        if (!auth) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        const { id } = await context.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                { success: false, message: "Invalid purchase ID" },
                { status: 400 }
            );
        }

        await connectDB();
        const purchase = await Purchase.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        }).lean();

        if (!purchase) {
            return NextResponse.json(
                { success: false, message: "Purchase not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            purchase,
        });
    } catch (error) {
        console.error("GET PURCHASE ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load purchase" },
            { status: 500 }
        );
    }
}
