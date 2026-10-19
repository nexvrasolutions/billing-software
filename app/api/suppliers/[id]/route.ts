import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Supplier } from "@/lib/models/Supplier";
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
                { success: false, message: "Invalid supplier ID" },
                { status: 400 }
            );
        }

        await connectDB();
        const supplier = await Supplier.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        }).lean();

        if (!supplier) {
            return NextResponse.json(
                { success: false, message: "Supplier not found" },
                { status: 404 }
            );
        }

        const purchases = await Purchase.find({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            supplierId: new mongoose.Types.ObjectId(id),
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        return NextResponse.json({
            success: true,
            supplier,
            purchases,
        });
    } catch (error) {
        console.error("GET SUPPLIER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load supplier" },
            { status: 500 }
        );
    }
}

export async function PUT(
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
                { success: false, message: "Invalid supplier ID" },
                { status: 400 }
            );
        }

        const body = await request.json();
        await connectDB();

        const updateData: any = {};
        if (body.name) updateData.name = body.name.trim();
        if (body.phone !== undefined) updateData["contact.phone"] = body.phone?.trim() || undefined;
        if (body.email !== undefined) updateData["contact.email"] = body.email?.trim() || undefined;
        if (body.contactPerson !== undefined) updateData["contact.contactPerson"] = body.contactPerson?.trim() || undefined;
        if (body.gstin !== undefined) {
            updateData["tax.gstin"] = body.gstin?.trim() || undefined;
            updateData["tax.taxRegistrationType"] = body.gstin ? "registered" : "unregistered";
        }
        if (body.address !== undefined) updateData["address.line1"] = body.address?.trim() || undefined;
        if (body.state !== undefined) updateData["address.state"] = body.state?.trim() || undefined;

        const updated = await Supplier.findOneAndUpdate(
            {
                _id: new mongoose.Types.ObjectId(id),
                tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            },
            { $set: updateData },
            { new: true }
        ).lean();

        if (!updated) {
            return NextResponse.json(
                { success: false, message: "Supplier not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            message: "Supplier updated successfully",
            supplier: updated,
        });
    } catch (error) {
        console.error("UPDATE SUPPLIER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to update supplier" },
            { status: 500 }
        );
    }
}
