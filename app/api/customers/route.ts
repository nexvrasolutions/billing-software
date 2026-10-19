import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Customer } from "@/lib/models/Customer";
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
        const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
        const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
        const skip = (page - 1) * limit;

        const filter: any = {
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        };

        if (q) {
            // Escape special regex characters
            const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            filter.$or = [
                { name: { $regex: escapedQ, $options: "i" } },
                { phone: { $regex: escapedQ, $options: "i" } },
                { email: { $regex: escapedQ, $options: "i" } },
            ];
        }

        const [customers, total] = await Promise.all([
            Customer.find(filter)
                .sort({ name: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Customer.countDocuments(filter),
        ]);

        return NextResponse.json({
            success: true,
            customers,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        if (isDatabaseConnectionError(error)) {
            console.warn("GET /api/customers: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
        console.error("GET CUSTOMERS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load customers" },
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
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
            return NextResponse.json(
                { success: false, message: "Name is required" },
                { status: 400 }
            );
        }

        if (name.length > 200) {
            return NextResponse.json(
                { success: false, message: "Customer name cannot exceed 200 characters" },
                { status: 400 }
            );
        }

        const phone = typeof body.phone === "string" && body.phone.trim().length > 0
            ? body.phone.trim()
            : undefined;
        const email = typeof body.email === "string" && body.email.trim().length > 0
            ? body.email.trim().toLowerCase()
            : undefined;
        const address = typeof body.address === "string" && body.address.trim().length > 0
            ? body.address.trim()
            : undefined;
        const status = body.status === "inactive" ? "inactive" : "active";

        await connectDB();
        const customer = await Customer.create({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            name,
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
            ...(address ? { address } : {}),
            status,
        });

        return NextResponse.json(
            {
                success: true,
                message: "Customer created successfully",
                customer,
            },
            { status: 201 }
        );
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("POST /api/customers: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
        console.error("CREATE CUSTOMER ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: error.code === 11000 ? "A customer with this phone number already exists." : "Failed to create customer",
            },
            { status: 400 }
        );
    }
}
