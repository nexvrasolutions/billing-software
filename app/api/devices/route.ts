
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { Device } from "@/lib/models/Device";
import { User } from "@/lib/models/User";
import { AuditLogService } from "@/lib/services/AuditLogService";
import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { hasPermission } from "@/lib/auth/hasPermission";

const ALLOWED_DEVICE_TYPES = [
    "pos",
    "desktop",
    "laptop",
    "tablet",
    "mobile",
    "other",
] as const;

function errorResponse(
    message: string,
    status: number
) {
    return NextResponse.json(
        { success: false, message },
        { status }
    );
}

// GET /api/devices
export async function GET(request: NextRequest) {
    try {
        const context =
            await getAuthenticatedContext(request);

        if (!context) {
            return errorResponse("Not authenticated", 401);
        }

        const permitted = await hasPermission({
            userId: context.userId,
            tenantId: context.tenantId,
            roleId: context.roleId,
            permission: "devices.read",
        });

        if (!permitted) {
            return errorResponse("Permission denied", 403);
        }

        const devices = await Device.find({
            tenantId: context.tenantId,
        })
            .sort({ createdAt: -1 })
            .lean();

        return NextResponse.json({
            success: true,
            count: devices.length,
            devices,
        });
    } catch (error) {
        console.error("Device list error:", error);
        return errorResponse("Failed to fetch devices", 500);
    }
}

// POST /api/devices
export async function POST(request: NextRequest) {
    let session: mongoose.ClientSession | undefined;

    try {
        const context =
            await getAuthenticatedContext(request);

        if (!context) {
            return errorResponse("Not authenticated", 401);
        }

        const permitted = await hasPermission({
            userId: context.userId,
            tenantId: context.tenantId,
            roleId: context.roleId,
            permission: "devices.create",
        });

        if (!permitted) {
            return errorResponse("Permission denied", 403);
        }

        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return errorResponse("Invalid JSON body", 400);
        }

        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body)
        ) {
            return errorResponse("Request body must be an object", 400);
        }

        const payload = body as Record<string, unknown>;
        const allowedFields = [
            "deviceName",
            "deviceType",
            "deviceId",
            "userId",
        ];

        if (
            Object.keys(payload).some(
                (key) => !allowedFields.includes(key)
            )
        ) {
            return errorResponse(
                "Request contains unsupported fields",
                400
            );
        }

        const { deviceName, deviceType, deviceId, userId } =
            payload;

        if (
            typeof deviceName !== "string" ||
            !deviceName.trim() ||
            deviceName.trim().length > 100
        ) {
            return errorResponse(
                "deviceName must contain 1–100 characters",
                400
            );
        }

        if (
            typeof deviceId !== "string" ||
            !deviceId.trim() ||
            deviceId.trim().length > 150
        ) {
            return errorResponse(
                "deviceId must contain 1–150 characters",
                400
            );
        }

        if (
            typeof deviceType !== "string" ||
            !ALLOWED_DEVICE_TYPES.includes(
                deviceType as (typeof ALLOWED_DEVICE_TYPES)[number]
            )
        ) {
            return errorResponse("Invalid deviceType", 400);
        }

        const tenantObjectId =
            new mongoose.Types.ObjectId(context.tenantId);

        const assignedUserId =
            userId === undefined
                ? context.userId
                : userId;

        if (
            typeof assignedUserId !== "string" ||
            !mongoose.Types.ObjectId.isValid(assignedUserId)
        ) {
            return errorResponse("Invalid userId", 400);
        }

        // Critical tenant-isolation check:
        // the assigned user must be active and belong to this tenant.
        const assignedUser = await User.findOne({
            _id: assignedUserId,
            tenantId: tenantObjectId,
            status: "active",
        })
            .select("_id")
            .lean();

        if (!assignedUser) {
            return errorResponse(
                "Assigned user not found or inactive in this tenant",
                400
            );
        }

        session = await mongoose.startSession();

        let result:
            | {
                device: unknown;
                auditLog: unknown;
            }
            | undefined;

        await session.withTransaction(async () => {
            const device = new Device({
                tenantId: tenantObjectId,
                userId: assignedUser._id,
                deviceName: deviceName.trim(),
                deviceType,
                deviceId: deviceId.trim(),
                status: "active",
            });

            await device.save({ session });

            const auditLog =
                await AuditLogService.createAuditLog(
                    {
                        userId: new mongoose.Types.ObjectId(
                            context.userId
                        ),
                        tenantId: tenantObjectId,
                    },
                    {
                        action: "CREATE",
                        entity: "Device",
                        entityId: device._id,
                        description:
                            `Device ${device.deviceName} created`,
                        newValues: {
                            deviceName: device.deviceName,
                            deviceType: device.deviceType,
                            deviceId: device.deviceId,
                            userId: device.userId.toString(),
                            status: device.status,
                        },
                    },
                    session
                );

            result = {
                device: device.toObject(),
                auditLog: auditLog.toObject(),
            };
        });

        if (!result) {
            throw new Error("Device creation transaction returned no result");
        }

        return NextResponse.json(
            {
                success: true,
                message: "Device created successfully",
                ...result,
            },
            { status: 201 }
        );
    } catch (error: unknown) {
        console.error("Device creation error:", error);

        if (
            error instanceof mongoose.Error.ValidationError
        ) {
            return errorResponse(error.message, 400);
        }

        if (
            error instanceof mongoose.mongo.MongoServerError &&
            error.code === 11000
        ) {
            return errorResponse(
                "A device with this deviceId already exists in this tenant",
                409
            );
        }

        return errorResponse("Failed to create device", 500);
    } finally {
        await session?.endSession();
    }
}
