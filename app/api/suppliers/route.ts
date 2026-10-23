import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Supplier } from "@/lib/models/Supplier";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { SupplierCodeService } from "@/lib/services/SupplierCodeService";
import {
    createSupplierSchema,
    SUPPLIER_WRITE_PERMISSIONS,
    SUPPLIER_READ_PERMISSIONS,
} from "@/lib/validations/supplier";

export async function GET(request: NextRequest) {
    try {
        const auth = await getAuthenticatedContext(request);
        if (!auth) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        if (!auth.roleId) {
            return NextResponse.json(
                { success: false, message: "Permission denied" },
                { status: 403 }
            );
        }

        const granted = await getGrantedPermissions({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permissions: SUPPLIER_READ_PERMISSIONS,
        });

        if (granted.size === 0) {
            return NextResponse.json(
                { success: false, message: "You do not have permission to view suppliers" },
                { status: 403 }
            );
        }

        await connectDB();
        const searchParams = request.nextUrl.searchParams;
        const q = searchParams.get("q")?.trim();
        const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
        const limitParam = searchParams.get("limit");
        const limit = limitParam ? Math.min(200, Math.max(1, parseInt(limitParam, 10))) : 200;
        const skip = (page - 1) * limit;

        const filter: any = {
            tenantId: new mongoose.Types.ObjectId(auth.tenantId),
            isDeleted: { $ne: true },
        };

        if (q) {
            // Escape regex special characters to prevent regex injection or crashes
            const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            filter.$or = [
                { name: { $regex: escapedQ, $options: "i" } },
                { "contact.phone": { $regex: escapedQ, $options: "i" } },
                { "tax.gstin": { $regex: escapedQ, $options: "i" } },
                { supplierCode: { $regex: escapedQ, $options: "i" } },
            ];
        }

        const [suppliers, total] = await Promise.all([
            Supplier.find(filter)
                .sort({ name: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Supplier.countDocuments(filter),
        ]);

        return NextResponse.json({
            success: true,
            suppliers,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        });
    } catch (error) {
        if (isDatabaseConnectionError(error)) {
            console.warn("GET /api/suppliers: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
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

        // Verify role authorization (fail closed if role is missing)
        if (!auth.roleId) {
            return NextResponse.json(
                { success: false, message: "Permission denied" },
                { status: 403 }
            );
        }

        const granted = await getGrantedPermissions({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permissions: SUPPLIER_WRITE_PERMISSIONS,
        });

        if (granted.size === 0) {
            return NextResponse.json(
                { success: false, message: "You do not have permission to create suppliers" },
                { status: 403 }
            );
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

        const parsed = createSupplierSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid supplier data",
                    errors: parsed.error.issues.map((issue) => ({
                        field: issue.path.join("."),
                        message: issue.message,
                    })),
                },
                { status: 400 }
            );
        }

        await connectDB();
        const data = parsed.data;
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);

        let supplierCode: string;
        if (data.supplierCode) {
            supplierCode = data.supplierCode;
            // Verify code uniqueness before attempting create
            const existingCode = await Supplier.findOne({
                tenantId,
                supplierCode,
            }).select("_id").lean();

            if (existingCode) {
                return NextResponse.json(
                    { success: false, message: "A supplier with this code already exists." },
                    { status: 409 }
                );
            }
        } else {
            // Allocate next sequence atomically without countDocuments collisions
            supplierCode = await SupplierCodeService.generateNextSupplierCode(tenantId);
        }

        const supplier = await Supplier.create({
            tenantId,
            supplierCode,
            name: data.name,
            contact: {
                contactPerson: data.contactPerson,
                phone: data.phone,
                altPhone: data.altPhone,
                email: data.email,
                website: data.website,
            },
            address: {
                line1: data.line1 || data.address,
                line2: data.line2,
                city: data.city,
                state: data.state,
                country: data.country || "India",
                pincode: data.pincode,
            },
            tax: {
                gstin: data.gstin,
                pan: data.pan,
                taxRegistrationType: data.gstin ? "registered" : "unregistered",
            },
            paymentTerms: {
                type: data.paymentType,
                creditDays: data.creditDays,
                dueDateCalculation: "invoiceDate",
            },
            creditLimit: data.creditLimit,
            category: data.category,
            notes: data.notes,
            currency: "INR",
            status: data.status,
            createdBy: new mongoose.Types.ObjectId(auth.userId),
        });

        // Audit log event for supplier creation (excludes sensitive banking details)
        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: "CREATE",
                entity: "Supplier",
                entityId: supplier._id,
                description: `Supplier ${supplier.name} (${supplier.supplierCode}) created`,
                newValues: {
                    supplierCode: supplier.supplierCode,
                    name: supplier.name,
                    contactPerson: supplier.contact?.contactPerson,
                    phone: supplier.contact?.phone,
                    email: supplier.contact?.email,
                    gstin: supplier.tax?.gstin,
                    paymentType: supplier.paymentTerms?.type,
                    creditDays: supplier.paymentTerms?.creditDays,
                    status: supplier.status,
                },
            }
        );

        return NextResponse.json(
            {
                success: true,
                message: "Supplier created successfully",
                supplier,
            },
            { status: 201 }
        );
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("POST /api/suppliers: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }

        console.error("CREATE SUPPLIER ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message:
                    error.code === 11000
                        ? "A supplier with this code already exists."
                        : "Failed to create supplier",
            },
            { status: error.code === 11000 ? 409 : 500 }
        );
    }
}
