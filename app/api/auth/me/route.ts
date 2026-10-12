import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { Tenant } from "@/lib/models/Tenant";
import { Device } from "@/lib/models/Device";
import { getSession } from "@/lib/auth/getSession";

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

        // 6. Return authenticated context
        return NextResponse.json({
            success: true,
            authenticated: true,
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
            },
            tenant: {
                id: tenant._id.toString(),
                name: tenant.name,
                businessType:
                    tenant.businessType ??
                    null,
            },
            device: {
                id: device._id.toString(),
                deviceId: device.deviceId,
                deviceName: device.deviceName,
                deviceType: device.deviceType,
            },
        });
    } catch (error) {
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