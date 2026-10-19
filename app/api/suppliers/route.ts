import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Supplier } from "@/lib/models/Supplier";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";

export async function GET(request: NextRequest) {
    try {
        const auth = await getAuthenticatedContext(request);
        if (!auth) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        await connectDB();
        const searchParams = request.nextUrl.searchParams;
        const q = searchParams.get("q")?.trim();

        const filter: any = {
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        };

        if (q) {
            filter.$or = [
                { name: { $regex: q, $options: "i" } },
                { "contact.phone": { $regex: q, $options: "i" } },
                { "tax.gstin": { $regex: q, $options: "i" } },
                { supplierCode: { $regex: q, $options: "i" } },
            ];
        }

        const suppliers = await Supplier.find(filter)
            .sort({ name: 1 })
            .limit(200)
            .lean();

        return NextResponse.json({
            success: true,
            suppliers,
        });
    } catch (error) {
        console.error("GET SUPPLIERS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load suppliers" },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const auth = await getAuthenticatedContext(request);
        if (!auth) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        const body = await request.json();
        if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
            return NextResponse.json(
                { success: false, message: "Supplier name is required" },
                { status: 400 }
            );
        }

        await connectDB();

        // Generate supplierCode if not provided
        const count = await Supplier.countDocuments({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        });
        const supplierCode = body.supplierCode?.trim() || `SUP-${String(count + 1).padStart(4, "0")}`;

        const supplier = await Supplier.create({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            supplierCode,
            name: body.name.trim(),
            contact: {
                contactPerson: body.contactPerson?.trim() || undefined,
                phone: body.phone?.trim() || undefined,
                email: body.email?.trim() || undefined,
            },
            address: {
                line1: body.address?.trim() || undefined,
                state: body.state?.trim() || undefined,
            },
            tax: {
                gstin: body.gstin?.trim() || undefined,
                taxRegistrationType: body.gstin ? "registered" : "unregistered",
            },
            paymentTerms: {
                type: body.paymentType || "cash",
                creditDays: Number(body.creditDays) || 0,
                dueDateCalculation: "invoiceDate",
            },
            creditLimit: Number(body.creditLimit) || 0,
            currency: "INR",
        });

        return NextResponse.json(
            {
                success: true,
                message: "Supplier created successfully",
                supplier,
            },
            { status: 201 }
        );
    } catch (error: any) {
        console.error("CREATE SUPPLIER ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: error.code === 11000 ? "A supplier with this code already exists." : "Failed to create supplier",
            },
            { status: 400 }
        );
    }
}
