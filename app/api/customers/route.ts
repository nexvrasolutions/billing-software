import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Customer } from "@/lib/models/Customer";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";
import { createCustomerSchema, CUSTOMER_WRITE_PERMISSIONS } from "@/lib/validations/customer";
import { AuditLogService } from "@/lib/services/AuditLogService";

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

        // Verify role authorization when roleId is present
        if (auth.roleId) {
            const granted = await getGrantedPermissions({
                userId: auth.userId,
                tenantId: auth.tenantId,
                roleId: auth.roleId,
                permissions: CUSTOMER_WRITE_PERMISSIONS,
            });

            if (granted.size === 0) {
                return NextResponse.json(
                    { success: false, message: "You do not have permission to create customers" },
                    { status: 403 }
                );
            }
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { success: false, message: "Invalid JSON request body" },
                { status: 400 }
            );
        }

        const parsed = createCustomerSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: parsed.error.issues[0]?.message || "Invalid customer data",
                    errors: parsed.error.issues.map((issue) => ({
                        field: issue.path.join("."),
                        message: issue.message,
                    })),
                },
                { status: 400 }
            );
        }

        const { name, phone, email, address, status, operationId } = parsed.data;

        await connectDB();
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);

        // Pre-check for duplicate phone in this tenant
        if (phone) {
            const duplicate = await Customer.findOne({
                tenantId,
                phone,
            }).select("_id").lean();

            if (duplicate) {
                return NextResponse.json(
                    { success: false, message: "A customer with this phone number already exists." },
                    { status: 409 }
                );
            }
        }

        const customer = await Customer.create({
            tenantId,
            name,
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
            ...(address ? { address } : {}),
            status,
            ...(operationId ? { operationId } : {}),
        });

        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: "CREATE",
                entity: "Customer",
                entityId: customer._id,
                description: `Customer ${customer.name} created`,
                newValues: {
                    name: customer.name,
                    phone: customer.phone,
                    email: customer.email,
                    address: customer.address,
                    status: customer.status,
                    ...(operationId ? { operationId } : {}),
                },
            }
        );

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
            { status: error.code === 11000 ? 409 : 400 }
        );
    }
}
