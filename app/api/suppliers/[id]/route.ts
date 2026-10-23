import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Supplier } from "@/lib/models/Supplier";
import { Purchase } from "@/lib/models/Purchase";
import { PurchaseReturn } from "@/lib/models/PurchaseReturn";
import { Payment } from "@/lib/models/Payment";
import { LedgerEntry } from "@/lib/models/LedgerEntry";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    updateSupplierSchema,
    supplierLifecycleSchema,
    isValidSupplierTransition,
    SUPPLIER_WRITE_PERMISSIONS,
    SUPPLIER_READ_PERMISSIONS,
    type SupplierLifecycleAction,
} from "@/lib/validations/supplier";

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
        if (isDatabaseConnectionError(error)) {
            console.warn("GET /api/suppliers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }
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
                { success: false, message: "You do not have permission to update suppliers" },
                { status: 403 }
            );
        }

        const { id } = await context.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                { success: false, message: "Invalid supplier ID" },
                { status: 400 }
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

        const parsed = updateSupplierSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid supplier update data",
                    errors: parsed.error.issues.map((issue) => ({
                        field: issue.path.join("."),
                        message: issue.message,
                    })),
                },
                { status: 400 }
            );
        }

        await connectDB();
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
        const supplierObjectId = new mongoose.Types.ObjectId(id);

        const existing = await Supplier.findOne({
            _id: supplierObjectId,
            tenantId,
            isDeleted: { $ne: true },
        }).lean();

        if (!existing) {
            return NextResponse.json(
                { success: false, message: "Supplier not found" },
                { status: 404 }
            );
        }

        const data = parsed.data;

        // If supplierCode is being changed, check for conflict with other suppliers in tenant
        if (data.supplierCode && data.supplierCode !== existing.supplierCode) {
            const duplicate = await Supplier.findOne({
                tenantId,
                supplierCode: data.supplierCode,
                _id: { $ne: supplierObjectId },
            }).select("_id").lean();

            if (duplicate) {
                return NextResponse.json(
                    { success: false, message: "A supplier with this code already exists." },
                    { status: 409 }
                );
            }
        }

        const updateData: Record<string, unknown> = {};

        if (data.name !== undefined) updateData.name = data.name;
        if (data.supplierCode !== undefined) updateData.supplierCode = data.supplierCode;
        if (data.category !== undefined) updateData.category = data.category;
        if (data.notes !== undefined) updateData.notes = data.notes;
        if (data.creditLimit !== undefined) updateData.creditLimit = data.creditLimit;

        // Contact updates
        if (data.contactPerson !== undefined) updateData["contact.contactPerson"] = data.contactPerson;
        if (data.phone !== undefined) updateData["contact.phone"] = data.phone;
        if (data.altPhone !== undefined) updateData["contact.altPhone"] = data.altPhone;
        if (data.email !== undefined) updateData["contact.email"] = data.email;
        if (data.website !== undefined) updateData["contact.website"] = data.website;

        // Address updates
        const line1 = data.line1 || data.address;
        if (line1 !== undefined) updateData["address.line1"] = line1;
        if (data.line2 !== undefined) updateData["address.line2"] = data.line2;
        if (data.city !== undefined) updateData["address.city"] = data.city;
        if (data.state !== undefined) updateData["address.state"] = data.state;
        if (data.country !== undefined) updateData["address.country"] = data.country;
        if (data.pincode !== undefined) updateData["address.pincode"] = data.pincode;

        // Tax updates
        if (data.gstin !== undefined) {
            updateData["tax.gstin"] = data.gstin;
            updateData["tax.taxRegistrationType"] = data.gstin ? "registered" : "unregistered";
        }
        if (data.pan !== undefined) updateData["tax.pan"] = data.pan;

        // Payment terms updates
        if (data.paymentType !== undefined) updateData["paymentTerms.type"] = data.paymentType;
        if (data.creditDays !== undefined) updateData["paymentTerms.creditDays"] = data.creditDays;

        const updated = await Supplier.findOneAndUpdate(
            {
                _id: supplierObjectId,
                tenantId,
                isDeleted: { $ne: true },
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

        // Audit log event for supplier update (excludes sensitive banking details)
        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: "UPDATE",
                entity: "Supplier",
                entityId: updated._id,
                description: `Supplier ${updated.name} (${updated.supplierCode}) updated`,
                oldValues: {
                    name: existing.name,
                    supplierCode: existing.supplierCode,
                    contactPerson: existing.contact?.contactPerson,
                    phone: existing.contact?.phone,
                    email: existing.contact?.email,
                    gstin: existing.tax?.gstin,
                    address: existing.address?.line1,
                    state: existing.address?.state,
                    status: existing.status,
                },
                newValues: {
                    name: updated.name,
                    supplierCode: updated.supplierCode,
                    contactPerson: updated.contact?.contactPerson,
                    phone: updated.contact?.phone,
                    email: updated.contact?.email,
                    gstin: updated.tax?.gstin,
                    address: updated.address?.line1,
                    state: updated.address?.state,
                    status: updated.status,
                },
            }
        );

        return NextResponse.json({
            success: true,
            message: "Supplier updated successfully",
            supplier: updated,
        });
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("PUT /api/suppliers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }

        console.error("UPDATE SUPPLIER ERROR:", error);
        return NextResponse.json(
            {
                success: false,
                message:
                    error.code === 11000
                        ? "A supplier with this code already exists."
                        : "Failed to update supplier",
            },
            { status: error.code === 11000 ? 409 : 500 }
        );
    }
}

export async function PATCH(
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
                { success: false, message: "You do not have permission to modify supplier lifecycle" },
                { status: 403 }
            );
        }

        const { id } = await context.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                { success: false, message: "Invalid supplier ID" },
                { status: 400 }
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

        const parsed = supplierLifecycleSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid lifecycle action data",
                    errors: parsed.error.issues.map((issue) => ({
                        field: issue.path.join("."),
                        message: issue.message,
                    })),
                },
                { status: 400 }
            );
        }

        await connectDB();
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
        const supplierObjectId = new mongoose.Types.ObjectId(id);

        const supplier = await Supplier.findOne({
            _id: supplierObjectId,
            tenantId,
        });

        if (!supplier) {
            return NextResponse.json(
                { success: false, message: "Supplier not found" },
                { status: 404 }
            );
        }

        if (supplier.isDeleted) {
            return NextResponse.json(
                { success: false, message: "Cannot perform lifecycle actions on an archived supplier" },
                { status: 400 }
            );
        }

        const transition = isValidSupplierTransition(supplier.status, parsed.data.action);
        if (!transition.valid || !transition.newStatus) {
            return NextResponse.json(
                { success: false, message: transition.error || "Invalid lifecycle transition" },
                { status: 400 }
            );
        }

        const previousStatus = supplier.status;
        const newStatus = transition.newStatus;
        supplier.status = newStatus;
        await supplier.save();

        const auditActionMap: Record<SupplierLifecycleAction, string> = {
            deactivate: "DEACTIVATE",
            reactivate: "REACTIVATE",
            block: "BLOCK",
            unblock: "UNBLOCK",
        };
        const actionName = auditActionMap[parsed.data.action];
        const reason = parsed.data.reason;

        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: actionName,
                entity: "Supplier",
                entityId: supplier._id,
                description: `Supplier ${supplier.name} (${supplier.supplierCode}) ${parsed.data.action}d${reason ? `: ${reason}` : ""}`,
                oldValues: {
                    status: previousStatus,
                },
                newValues: {
                    status: newStatus,
                    ...(reason ? { reason } : {}),
                },
            }
        );

        return NextResponse.json({
            success: true,
            message: `Supplier ${parsed.data.action}d successfully`,
            supplier: supplier.toObject(),
        });
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("PATCH /api/suppliers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }

        console.error("LIFECYCLE SUPPLIER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to update supplier lifecycle" },
            { status: 500 }
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
                { success: false, message: "You do not have permission to delete or archive suppliers" },
                { status: 403 }
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
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
        const supplierObjectId = new mongoose.Types.ObjectId(id);

        const supplier = await Supplier.findOne({
            _id: supplierObjectId,
            tenantId,
        });

        if (!supplier) {
            return NextResponse.json(
                { success: false, message: "Supplier not found" },
                { status: 404 }
            );
        }

        // Safe repeated deletion: if already archived, return predictable success
        if (supplier.isDeleted) {
            return NextResponse.json({
                success: true,
                message: "Supplier is already deleted.",
                deleted: true,
            });
        }

        // Check tenant-scoped references in transactional collections
        const [referencedInPurchase, referencedInReturn, referencedInPayment, referencedInLedger] =
            await Promise.all([
                Purchase.findOne({ tenantId, supplierId: supplierObjectId }).select("_id").lean(),
                PurchaseReturn.findOne({ tenantId, supplierId: supplierObjectId }).select("_id").lean(),
                Payment.findOne({ tenantId, supplierId: supplierObjectId }).select("_id").lean(),
                LedgerEntry.findOne({ tenantId, supplierId: supplierObjectId }).select("_id").lean(),
            ]);

        const hasReferences = Boolean(
            referencedInPurchase || referencedInReturn || referencedInPayment || referencedInLedger
        );

        if (hasReferences) {
            // Cannot hard-delete or archive if transactions reference this supplier.
            // Convert to safe deactivation to preserve all historical foreign keys.
            if (supplier.status === "inactive") {
                return NextResponse.json({
                    success: true,
                    message: "Supplier is referenced in transaction history and is already inactive.",
                    deactivated: true,
                    hasReferences: true,
                    supplier: supplier.toObject(),
                });
            }

            const oldStatus = supplier.status;
            supplier.status = "inactive";
            await supplier.save();

            await AuditLogService.createAuditLog(
                {
                    userId: new mongoose.Types.ObjectId(auth.userId),
                    tenantId,
                    deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
                },
                {
                    action: "DEACTIVATE",
                    entity: "Supplier",
                    entityId: supplier._id,
                    description: `Supplier ${supplier.name} (${supplier.supplierCode}) deactivated due to existing transaction history`,
                    oldValues: { status: oldStatus },
                    newValues: { status: "inactive" },
                }
            );

            return NextResponse.json({
                success: true,
                message: "Supplier has existing transaction history and has been deactivated instead of deleted.",
                deactivated: true,
                hasReferences: true,
                supplier: supplier.toObject(),
            });
        }

        // Safe soft-deletion when no transactional references exist
        supplier.isDeleted = true;
        await supplier.save();

        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: "DELETE",
                entity: "Supplier",
                entityId: supplier._id,
                description: `Supplier ${supplier.name} (${supplier.supplierCode}) soft-deleted (no historical references)`,
                oldValues: { isDeleted: false, status: supplier.status },
                newValues: { isDeleted: true, status: supplier.status },
            }
        );

        return NextResponse.json({
            success: true,
            message: "Supplier deleted successfully.",
            deleted: true,
        });
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("DELETE /api/suppliers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }

        console.error("DELETE SUPPLIER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to delete supplier" },
            { status: 500 }
        );
    }
}
