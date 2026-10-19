import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { z } from "zod";

import { connectDB } from "@/lib/db/mongodb";
import { Tenant, type ITenant } from "@/lib/models/Tenant";
import {
    getAuthenticatedContext,
    type AuthenticatedContext,
} from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";

export const updateBusinessSettingsSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        businessType: z.string().trim().max(100).optional(),
        pricingMode: z.enum(["tax_inclusive", "tax_exclusive"]).optional(),
    })
    .strict()
    .refine(
        (data) => Object.keys(data).length > 0,
        "Provide at least one setting to update"
    );

export type UpdateBusinessSettingsInput = z.infer<typeof updateBusinessSettingsSchema>;

export type BusinessSettingsRouteDeps = {
    getAuthContext?: (req: NextRequest) => Promise<AuthenticatedContext | null>;
    checkPermission?: (input: {
        userId: string;
        tenantId: string;
        roleId?: string;
        permission: string;
    }) => Promise<boolean>;
    findTenant?: (tenantId: string) => Promise<any>;
    connectToDatabase?: () => Promise<void>;
};

// GET /api/settings/business - Read current business settings
export async function handleGetBusinessSettings(
    request: NextRequest,
    deps: BusinessSettingsRouteDeps = {}
) {
    try {
        const authFn = deps.getAuthContext ?? getAuthenticatedContext;
        const connectFn = deps.connectToDatabase ?? connectDB;

        const auth = await authFn(request);
        if (!auth) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        await connectFn();

        let tenant: any;
        if (deps.findTenant) {
            tenant = await deps.findTenant(auth.tenantId);
        } else {
            tenant = await Tenant.findOne({
                _id: new mongoose.Types.ObjectId(auth.tenantId),
                status: "active",
            }).lean();
        }

        if (!tenant) {
            return NextResponse.json(
                { success: false, message: "Business account not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            settings: {
                id: tenant._id?.toString() ?? auth.tenantId,
                name: tenant.name,
                businessType: tenant.businessType ?? null,
                pricingMode: tenant.pricingMode ?? "tax_inclusive",
            },
        });
    } catch (error) {
        console.error("GET BUSINESS SETTINGS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to load business settings" },
            { status: 500 }
        );
    }
}

// PUT /api/settings/business - Update business settings (Admin or Owner only)
export async function handlePutBusinessSettings(
    request: NextRequest,
    deps: BusinessSettingsRouteDeps = {}
) {
    try {
        const authFn = deps.getAuthContext ?? getAuthenticatedContext;
        const checkPermFn = deps.checkPermission ?? hasPermission;
        const connectFn = deps.connectToDatabase ?? connectDB;

        const auth = await authFn(request);
        if (!auth) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        await connectFn();

        let tenant: any;
        if (deps.findTenant) {
            tenant = await deps.findTenant(auth.tenantId);
        } else {
            tenant = await Tenant.findOne({
                _id: new mongoose.Types.ObjectId(auth.tenantId),
                status: "active",
            });
        }

        if (!tenant) {
            return NextResponse.json(
                { success: false, message: "Business account not found" },
                { status: 404 }
            );
        }

        // Permission verification:
        // Either the caller is the verified tenant owner, OR they hold
        // an administrator privilege (users.update permission).
        const isOwner =
            Boolean(tenant.ownerUserId) &&
            tenant.ownerUserId.toString() === auth.userId;

        let hasAdminPerm = false;
        if (!isOwner) {
            hasAdminPerm = await checkPermFn({
                userId: auth.userId,
                tenantId: auth.tenantId,
                roleId: auth.roleId,
                permission: "users.update",
            });
        }

        if (!isOwner && !hasAdminPerm) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "Permission denied: Only business administrators or owners can change business settings",
                },
                { status: 403 }
            );
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { success: false, message: "Invalid JSON body" },
                { status: 400 }
            );
        }

        const parseResult = updateBusinessSettingsSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                {
                    success: false,
                    message: parseResult.error.issues[0]?.message ?? "Invalid settings input",
                    errors: parseResult.error.issues,
                },
                { status: 400 }
            );
        }

        const updates = parseResult.data;

        if (updates.name !== undefined) {
            tenant.name = updates.name;
        }
        if (updates.businessType !== undefined) {
            tenant.businessType = updates.businessType;
        }
        if (updates.pricingMode !== undefined) {
            tenant.pricingMode = updates.pricingMode;
        }

        if (typeof tenant.save === "function") {
            await tenant.save();
        }

        return NextResponse.json({
            success: true,
            message: "Business settings updated successfully",
            settings: {
                id: tenant._id?.toString() ?? auth.tenantId,
                name: tenant.name,
                businessType: tenant.businessType ?? null,
                pricingMode: tenant.pricingMode ?? "tax_inclusive",
            },
        });
    } catch (error) {
        console.error("PUT BUSINESS SETTINGS ERROR:", error);
        return NextResponse.json(
            { success: false, message: "Failed to update business settings" },
            { status: 500 }
        );
    }
}
