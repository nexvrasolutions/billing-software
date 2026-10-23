import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Purchase } from "@/lib/models/Purchase";
import { Payment } from "@/lib/models/Payment";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import {
    BUSINESS_PERMISSIONS,
    requireAnyBusinessPermission,
} from "@/lib/auth/businessPermissions";

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

        const denied = await requireAnyBusinessPermission(auth, [
            BUSINESS_PERMISSIONS.purchasesRead,
            BUSINESS_PERMISSIONS.purchasesCreate,
        ]);
        if (denied) {
            return denied;
        }

        const { id } = await context.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                { success: false, message: "Invalid purchase ID" },
                { status: 400 }
            );
        }

        await connectDB();
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
        const purchaseId = new mongoose.Types.ObjectId(id);

        const purchase = await Purchase.findOne({
            _id: purchaseId,
            tenantId,
        }).lean();

        if (!purchase) {
            return NextResponse.json(
                { success: false, message: "Purchase not found" },
                { status: 404 }
            );
        }

        const payments = await Payment.find({
            tenantId,
            purchaseId,
        })
            .sort({ paymentDate: -1, createdAt: -1 })
            .lean();

        return NextResponse.json({
            success: true,
            purchase,
            payments,
        });
    } catch (error) {
        console.error("GET PURCHASE ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load purchase" },
            { status: 500 }
        );
    }
}
