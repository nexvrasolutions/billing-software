import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Customer } from "@/lib/models/Customer";
import { Sale } from "@/lib/models/Sale";
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
                { success: false, message: "Invalid customer ID" },
                { status: 400 }
            );
        }

        await connectDB();
        const customer = await Customer.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        }).lean();

        if (!customer) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        // Get customer bills/sales
        const bills = await Sale.find({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            customerId: new mongoose.Types.ObjectId(id),
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        return NextResponse.json({
            success: true,
            customer,
            bills,
        });
    } catch (error) {
        if (isDatabaseConnectionError(error)) {
            console.warn("GET /api/customers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
        console.error("GET CUSTOMER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load customer" },
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
                { success: false, message: "Invalid customer ID" },
                { status: 400 }
            );
        }

        const body = await request.json();
        const updates: any = {};

        if (typeof body.name === "string" && body.name.trim()) {
            if (body.name.trim().length > 200) {
                return NextResponse.json(
                    { success: false, message: "Customer name cannot exceed 200 characters" },
                    { status: 400 }
                );
            }
            updates.name = body.name.trim();
        }

        if (body.phone !== undefined) {
            const trimmedPhone = typeof body.phone === "string" ? body.phone.trim() : "";
            updates.phone = trimmedPhone.length > 0 ? trimmedPhone : undefined;
        }

        if (body.email !== undefined) {
            const trimmedEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
            updates.email = trimmedEmail.length > 0 ? trimmedEmail : undefined;
        }

        if (body.address !== undefined) {
            const trimmedAddress = typeof body.address === "string" ? body.address.trim() : "";
            updates.address = trimmedAddress.length > 0 ? trimmedAddress : undefined;
        }

        if (body.status === "active" || body.status === "inactive") {
            updates.status = body.status;
        }

        await connectDB();

        const updated = await Customer.findOneAndUpdate(
            {
                _id: new mongoose.Types.ObjectId(id),
                tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            },
            updates,
            { new: true }
        ).lean();

        if (!updated) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            message: "Customer updated successfully",
            customer: updated,
        });
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("PUT /api/customers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
        console.error("UPDATE CUSTOMER ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message: error.code === 11000 ? "A customer with this phone number already exists." : "Failed to update customer",
            },
            { status: error.code === 11000 ? 400 : 500 }
        );
    }
}

export async function DELETE(
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
                { success: false, message: "Invalid customer ID" },
                { status: 400 }
            );
        }

        await connectDB();
        const customer = await Customer.findOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        });

        if (!customer) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        // Check if customer is referenced by existing sales/invoices
        const referencedInSales = await Sale.findOne({
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            customerId: new mongoose.Types.ObjectId(id),
        }).select("_id").lean();

        if (referencedInSales) {
            // Soft-deactivate to preserve historical integrity
            customer.status = "inactive";
            await customer.save();

            return NextResponse.json({
                success: true,
                message: "Customer is referenced in sales history and has been deactivated instead of deleted.",
                deactivated: true,
                customer,
            });
        }

        // Safe hard delete if no historical transactions reference this customer
        await Customer.deleteOne({
            _id: new mongoose.Types.ObjectId(id),
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
        });

        return NextResponse.json({
            success: true,
            message: "Customer deleted successfully",
        });
    } catch (error) {
        if (isDatabaseConnectionError(error)) {
            console.warn("DELETE /api/customers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
        console.error("DELETE CUSTOMER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to delete customer" },
            { status: 500 }
        );
    }
}
