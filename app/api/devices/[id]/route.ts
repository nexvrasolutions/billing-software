
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

import { Device } from "@/lib/models/Device";
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

type RouteContext = {
    params: Promise<{ id: string }>;
};

function errorResponse(message: string, status: number) {
    return NextResponse.json(
        { success: false, message },
        { status }
    );
}

class DeviceNotFoundError extends Error { }

function isObjectBody(
    body: unknown
): body is Record<string, unknown> {
    return (
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body)
    );
}

// GET /api/devices/[id]
export async function GET(
    request: NextRequest,
    routeContext: RouteContext
) {
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

        const { id } = await routeContext.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse("Invalid device ID", 400);
        }

        const device = await Device.findOne({
            _id: id,
            tenantId: context.tenantId,
        }).lean();

        if (!device) {
            return errorResponse("Device not found", 404);
        }

        return NextResponse.json({
            success: true,
            device,
        });
    } catch (error) {
        console.error("Device fetch error:", error);
        return errorResponse("Failed to fetch device", 500);
    }
}

// PUT /api/devices/[id]
export async function PUT(
    request: NextRequest,
    routeContext: RouteContext
) {
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
            permission: "devices.update",
        });

        if (!permitted) {
            return errorResponse("Permission denied", 403);
        }

        const { id } = await routeContext.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse("Invalid device ID", 400);
        }

        let body: unknown;

        try {
            body = await request.json();
        } catch {
            return errorResponse("Invalid JSON body", 400);
        }

        if (!isObjectBody(body)) {
            return errorResponse(
                "Request body must be an object",
                400
            );
        }

        const allowedFields = [
            "deviceName",
            "deviceType",
            "status",
        ];

        if (
            Object.keys(body).some(
                (key) => !allowedFields.includes(key)
            )
        ) {
            return errorResponse(
                "Request contains unsupported fields",
                400
            );
        }

        if (Object.keys(body).length === 0) {
            return errorResponse(
                "Provide at least one field to update",
                400
            );
        }

        const { deviceName, deviceType, status } = body;

        if (
            deviceName !== undefined &&
            (
                typeof deviceName !== "string" ||
                !deviceName.trim() ||
                deviceName.trim().length > 100
            )
        ) {
            return errorResponse(
                "deviceName must contain 1–100 characters",
                400
            );
        }

        if (
            deviceType !== undefined &&
            (
                typeof deviceType !== "string" ||
                !ALLOWED_DEVICE_TYPES.includes(
                    deviceType as (typeof ALLOWED_DEVICE_TYPES)[number]
                )
            )
        ) {
            return errorResponse("Invalid deviceType", 400);
        }

        if (
            status !== undefined &&
            status !== "active" &&
            status !== "inactive"
        ) {
            return errorResponse("Invalid device status", 400);
        }

        session = await mongoose.startSession();

        let result:
            | {
                device: unknown;
                auditLog: unknown;
            }
            | undefined;

        await session.withTransaction(async () => {
            // Always scope the lookup to the authenticated tenant.
            const device = await Device.findOne({
                _id: id,
                tenantId: context.tenantId,
            }).session(session!);

            if (!device) {
                throw new DeviceNotFoundError();
            }

            const oldValues = {
                deviceName: device.deviceName,
                deviceType: device.deviceType,
                status: device.status,
            };

            if (deviceName !== undefined) {
                device.deviceName = deviceName.trim();
            }

            if (deviceType !== undefined) {
                device.deviceType = deviceType as
                    (typeof ALLOWED_DEVICE_TYPES)[number];
            }

            if (status !== undefined) {
                device.status = status;
            }

            await device.save({ session });

            const newValues = {
                deviceName: device.deviceName,
                deviceType: device.deviceType,
                status: device.status,
            };

            let action = "UPDATE";

            if (
                oldValues.status === "active" &&
                newValues.status === "inactive"
            ) {
                action = "DEACTIVATE";
            } else if (
                oldValues.status === "inactive" &&
                newValues.status === "active"
            ) {
                action = "ACTIVATE";
            }

            const auditLog =
                await AuditLogService.createAuditLog(
                    {
                        userId: new mongoose.Types.ObjectId(
                            context.userId
                        ),
                        tenantId: new mongoose.Types.ObjectId(
                            context.tenantId
                        ),
                    },
                    {
                        action,
                        entity: "Device",
                        entityId: device._id,
                        description:
                            action === "DEACTIVATE"
                                ? `Device ${device.deviceName} deactivated`
                                : action === "ACTIVATE"
                                    ? `Device ${device.deviceName} activated`
                                    : `Device ${device.deviceName} updated`,
                        oldValues,
                        newValues,
                    },
                    session
                );

            result = {
                device: device.toObject(),
                auditLog: auditLog.toObject(),
            };
        });

        if (!result) {
            throw new Error("Device update transaction returned no result");
        }

        return NextResponse.json({
            success: true,
            message: "Device updated successfully",
            ...result,
        });
    } catch (error) {
        if (error instanceof DeviceNotFoundError) {
            return errorResponse("Device not found", 404);
        }

        console.error("Device update error:", error);

        if (error instanceof mongoose.Error.ValidationError) {
            return errorResponse(error.message, 400);
        }

        return errorResponse("Failed to update device", 500);
    } finally {
        await session?.endSession();
    }
}
