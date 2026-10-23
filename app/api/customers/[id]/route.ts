import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { Customer } from "@/lib/models/Customer";
import { Sale } from "@/lib/models/Sale";
import { SalesReturn } from "@/lib/models/SalesReturn";
import { Payment } from "@/lib/models/Payment";
import { LedgerEntry } from "@/lib/models/LedgerEntry";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";
import { AuditLogService } from "@/lib/services/AuditLogService";
import {
    customerLifecycleSchema,
    isValidCustomerTransition,
    updateCustomerSchema,
    CUSTOMER_WRITE_PERMISSIONS,
    CUSTOMER_READ_PERMISSIONS,
    type CustomerLifecycleAction,
} from "@/lib/validations/customer";

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
                { success: false, message: "Missing assigned role" },
                { status: 403 }
            );
        }

        const granted = await getGrantedPermissions({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permissions: CUSTOMER_READ_PERMISSIONS,
        });

        if (granted.size === 0) {
            return NextResponse.json(
                { success: false, message: "You do not have permission to view customer details" },
                { status: 403 }
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

        if (!auth.roleId) {
            return NextResponse.json(
                { success: false, message: "Missing assigned role" },
                { status: 403 }
            );
        }

        const granted = await getGrantedPermissions({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permissions: CUSTOMER_WRITE_PERMISSIONS,
        });

        if (granted.size === 0) {
            return NextResponse.json(
                { success: false, message: "You do not have permission to update customers" },
                { status: 403 }
            );
        }

        const { id } = await context.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                { success: false, message: "Invalid customer ID" },
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

        const parsed = updateCustomerSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: parsed.error.issues[0]?.message || "Invalid customer update data",
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
        const customerObjectId = new mongoose.Types.ObjectId(id);

        const existing = await Customer.findOne({
            _id: customerObjectId,
            tenantId,
        });

        if (!existing) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        const data = parsed.data;

        // If phone is being changed to a new non-null string, check for collision in tenant
        if (typeof data.phone === "string" && data.phone !== existing.phone) {
            const duplicate = await Customer.findOne({
                tenantId,
                phone: data.phone,
                _id: { $ne: customerObjectId },
            }).select("_id").lean();

            if (duplicate) {
                return NextResponse.json(
                    { success: false, message: "A customer with this phone number already exists." },
                    { status: 409 }
                );
            }
        }

        const $set: Record<string, unknown> = {};
        const $unset: Record<string, 1> = {};

        if (data.name !== undefined) {
            $set.name = data.name;
        }

        if (data.phone !== undefined) {
            if (data.phone === null) {
                $unset.phone = 1;
            } else {
                $set.phone = data.phone;
            }
        }

        if (data.email !== undefined) {
            if (data.email === null) {
                $unset.email = 1;
            } else {
                $set.email = data.email;
            }
        }

        if (data.address !== undefined) {
            if (data.address === null) {
                $unset.address = 1;
            } else {
                $set.address = data.address;
            }
        }

        const mongoUpdate: any = {};
        if (Object.keys($set).length > 0) mongoUpdate.$set = $set;
        if (Object.keys($unset).length > 0) mongoUpdate.$unset = $unset;

        // Note: status is strictly prevented from being updated via PUT.
        // Customer lifecycle transitions must use PATCH /api/customers/[id].
        const updated = await Customer.findOneAndUpdate(
            {
                _id: customerObjectId,
                tenantId,
            },
            mongoUpdate,
            { new: true }
        ).lean();

        if (!updated) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        const oldValues: Record<string, unknown> = {};
        const newValues: Record<string, unknown> = {};

        if (data.name !== undefined) {
            oldValues.name = existing.name;
            newValues.name = data.name;
        }
        if (data.phone !== undefined) {
            oldValues.phone = existing.phone;
            newValues.phone = data.phone;
        }
        if (data.email !== undefined) {
            oldValues.email = existing.email;
            newValues.email = data.email;
        }
        if (data.address !== undefined) {
            oldValues.address = existing.address;
            newValues.address = data.address;
        }

        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: "UPDATE",
                entity: "Customer",
                entityId: customerObjectId,
                description: `Customer ${updated.name} updated`,
                oldValues,
                newValues,
            }
        );

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

        if (!auth.roleId) {
            return NextResponse.json(
                { success: false, message: "Missing assigned role" },
                { status: 403 }
            );
        }

        const granted = await getGrantedPermissions({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permissions: CUSTOMER_WRITE_PERMISSIONS,
        });

        if (granted.size === 0) {
            return NextResponse.json(
                { success: false, message: "You do not have permission to modify customer lifecycle" },
                { status: 403 }
            );
        }

        const { id } = await context.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                { success: false, message: "Invalid customer ID" },
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

        const parsed = customerLifecycleSchema.safeParse(body);
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
        const customerObjectId = new mongoose.Types.ObjectId(id);

        const customer = await Customer.findOne({
            _id: customerObjectId,
            tenantId,
        });

        if (!customer) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        const transition = isValidCustomerTransition(customer.status, parsed.data.action);
        if (!transition.valid || !transition.newStatus) {
            return NextResponse.json(
                { success: false, message: transition.error || "Invalid lifecycle transition" },
                { status: 400 }
            );
        }

        const previousStatus = customer.status;
        const newStatus = transition.newStatus;
        customer.status = newStatus;
        await customer.save();

        const auditActionMap: Record<CustomerLifecycleAction, string> = {
            deactivate: "DEACTIVATE",
            reactivate: "REACTIVATE",
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
                entity: "Customer",
                entityId: customer._id,
                description: `Customer ${customer.name} ${parsed.data.action}d${reason ? `: ${reason}` : ""}`,
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
            message: `Customer ${parsed.data.action}d successfully`,
            customer: customer.toObject(),
        });
    } catch (error: any) {
        if (isDatabaseConnectionError(error)) {
            console.warn("PATCH /api/customers/[id]: Database connection unavailable (Atlas offline)");
            return NextResponse.json(
                { success: false, message: "Database connection unavailable", offline: true },
                { status: 503 }
            );
        }

        console.error("LIFECYCLE CUSTOMER ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to update customer lifecycle" },
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

        if (!auth.roleId) {
            return NextResponse.json(
                { success: false, message: "Missing assigned role" },
                { status: 403 }
            );
        }

        const granted = await getGrantedPermissions({
            userId: auth.userId,
            tenantId: auth.tenantId,
            roleId: auth.roleId,
            permissions: CUSTOMER_WRITE_PERMISSIONS,
        });

        if (granted.size === 0) {
            return NextResponse.json(
                { success: false, message: "You do not have permission to delete customers" },
                { status: 403 }
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
        const tenantId = new mongoose.Types.ObjectId(auth.tenantId);
        const customerObjectId = new mongoose.Types.ObjectId(id);

        const customer = await Customer.findOne({
            _id: customerObjectId,
            tenantId,
        });

        if (!customer) {
            return NextResponse.json(
                { success: false, message: "Customer not found" },
                { status: 404 }
            );
        }

        // Check tenant-scoped references in all transactional collections
        const [referencedInSale, referencedInReturn, referencedInPayment, referencedInLedger] =
            await Promise.all([
                Sale.findOne({ tenantId, customerId: customerObjectId }).select("_id").lean(),
                SalesReturn.findOne({ tenantId, customerId: customerObjectId }).select("_id").lean(),
                Payment.findOne({ tenantId, customerId: customerObjectId }).select("_id").lean(),
                LedgerEntry.findOne({ tenantId, customerId: customerObjectId }).select("_id").lean(),
            ]);

        const hasReferences = Boolean(
            referencedInSale || referencedInReturn || referencedInPayment || referencedInLedger
        );

        if (hasReferences) {
            // Cannot hard-delete if transactions reference this customer.
            // Convert to safe deactivation to preserve all historical foreign keys.
            if (customer.status === "inactive") {
                return NextResponse.json({
                    success: true,
                    message: "Customer is referenced in transaction history and is already inactive.",
                    deactivated: true,
                    hasReferences: true,
                    customer: customer.toObject(),
                });
            }

            const oldStatus = customer.status;
            customer.status = "inactive";
            await customer.save();

            await AuditLogService.createAuditLog(
                {
                    userId: new mongoose.Types.ObjectId(auth.userId),
                    tenantId,
                    deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
                },
                {
                    action: "DEACTIVATE",
                    entity: "Customer",
                    entityId: customer._id,
                    description: `Customer ${customer.name} deactivated due to existing transaction history`,
                    oldValues: { status: oldStatus },
                    newValues: { status: "inactive" },
                }
            );

            return NextResponse.json({
                success: true,
                message: "Customer has existing transaction history and has been deactivated instead of deleted.",
                deactivated: true,
                hasReferences: true,
                customer: customer.toObject(),
            });
        }

        // Safe hard delete if no historical transactions reference this customer
        await Customer.deleteOne({
            _id: customerObjectId,
            tenantId,
        });

        await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(auth.userId),
                tenantId,
                deviceId: auth.deviceId ? new mongoose.Types.ObjectId(auth.deviceId) : undefined,
            },
            {
                action: "DELETE",
                entity: "Customer",
                entityId: customerObjectId,
                description: `Customer ${customer.name} deleted (no historical references)`,
                oldValues: { status: customer.status },
            }
        );

        return NextResponse.json({
            success: true,
            message: "Customer deleted successfully.",
            deleted: true,
        });
    } catch (error: any) {
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
