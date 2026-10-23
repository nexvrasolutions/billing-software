import { NextRequest, NextResponse } from "next/server";
import { connectDB, isDatabaseConnectionError } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { Tenant } from "@/lib/models/Tenant";
import { Device } from "@/lib/models/Device";
import { getSession } from "@/lib/auth/getSession";
import { getGrantedPermissions } from "@/lib/auth/hasPermission";
import { Permission } from "@/lib/models/Permission";

export async function GET(request: NextRequest) {
    try {
        // 1. Get authenticated session
        const session =
            await getSession(request);

        if (!session) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Not authenticated",
                },
                { status: 401 }
            );
        }

        await connectDB();

        // 2. Find active user
        const user = await User.findOne({
            _id: session.userId,
            tenantId: session.tenantId,
            status: "active",
        }).lean();

        if (!user) {
            return NextResponse.json(
                {
                    success: false,
                    message: "User not found or inactive",
                },
                { status: 401 }
            );
        }

        // 3. Find active tenant
        const tenant = await Tenant.findOne({
            _id: session.tenantId,
            status: "active",
        }).lean();

        if (!tenant) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Business account is inactive",
                },
                { status: 403 }
            );
        }

        // 4. Find active device
        const device = await Device.findOne({
            _id: session.deviceId,
            tenantId: session.tenantId,
            userId: session.userId,
            status: "active",
        }).lean();

        if (!device) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Device is no longer active",
                },
                { status: 403 }
            );
        }

        // 5. Update device activity
        await Device.updateOne(
            { _id: device._id },
            {
                $set: {
                    lastSeenAt: new Date(),
                },
            }
        );

        // 6. The user's CURRENT permission names (from the database role).
        //    For display and offline convenience checks in the browser only:
        //    every server route checks permissions itself. None while a
        //    temporary password must be changed.
        let permissions: string[] = [];

        if (user.mustChangePassword !== true && user.roleId) {
            const catalogue = await Permission.find({}).select("name").lean();
            const granted = await getGrantedPermissions({
                userId: user._id.toString(),
                tenantId: user.tenantId.toString(),
                roleId: user.roleId.toString(),
                permissions: catalogue.map((p) => p.name),
            });
            permissions = [...granted].sort();
        }

        // 7. Return authenticated context
        return NextResponse.json({
            success: true,
            authenticated: true,
            // The server's clock. The browser bases the 72-hour offline
            // window on it and refuses to renew it when the device clock
            // differs by more than five minutes.
            serverTime: new Date().toISOString(),
            permissions,
            user: {
                id: user._id.toString(),
                name: user.name,
                email: user.email,
                tenantId:
                    user.tenantId.toString(),
                roleId:
                    user.roleId?.toString() ??
                    null,
                mustChangePassword:
                    user.mustChangePassword === true,
                isOwner: Boolean(tenant.ownerUserId && tenant.ownerUserId.toString() === user._id.toString()),
            },
            tenant: {
                id: tenant._id.toString(),
                name: tenant.name,
                businessType:
                    tenant.businessType ??
                    null,
                pricingMode:
                    tenant.pricingMode ??
                    "tax_inclusive",
            },
            device: {
                id: device._id.toString(),
                deviceId: device.deviceId,
                deviceName: device.deviceName,
                deviceType: device.deviceType,
            },
        });
    } catch (error) {
        if (isDatabaseConnectionError(error)) {
            console.warn("Auth check: Database unavailable (Atlas offline); client using offline session.");
            return NextResponse.json(
                {
                    success: false,
                    message: "Database connection unavailable",
                    offline: true,
                },
                { status: 503 }
            );
        }

        console.error(
            "Auth me error:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                message:
                    "An unexpected error occurred",
            },
            { status: 500 }
        );
    }
}