import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { Device } from "@/lib/models/Device";
import { AuditLogService } from "@/lib/services/AuditLogService";

const TEST_TENANT_ID = "6abe48a86ae4b08a3e335303";
const TEST_USER_ID = "6abe4d3f6ae4b08a3e335463";

export async function GET(
    request: Request,
    context: { params: Promise<{ id: string }> }
) {
    try {
        await connectDB();

        const { id } = await context.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid device ID",
                },
                { status: 400 }
            );
        }

        const tenantId = new mongoose.Types.ObjectId(TEST_TENANT_ID);

        const device = await Device.findOne({
            _id: id,
            tenantId,
        }).lean();

        if (!device) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Device not found",
                },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            device,
        });
    } catch (error) {
        console.error("Device fetch error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to fetch device",
            },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: Request,
    context: { params: Promise<{ id: string }> }
) {
    try {
        await connectDB();

        const { id } = await context.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid device ID",
                },
                { status: 400 }
            );
        }

        const body = await request.json();

        const {
            deviceName,
            deviceType,
            status,
        } = body;

        const tenantId = new mongoose.Types.ObjectId(TEST_TENANT_ID);

        const device = await Device.findOne({
            _id: id,
            tenantId,
        });

        if (!device) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Device not found",
                },
                { status: 404 }
            );
        }

        // Save values BEFORE the update
        const oldValues = {
            deviceName: device.deviceName,
            deviceType: device.deviceType,
            status: device.status,
        };

        // Update device name
        if (deviceName !== undefined) {
            if (
                typeof deviceName !== "string" ||
                deviceName.trim().length === 0
            ) {
                return NextResponse.json(
                    {
                        success: false,
                        message: "Device name must be a non-empty string",
                    },
                    { status: 400 }
                );
            }

            device.deviceName = deviceName.trim();
        }

        // Update device type
        if (deviceType !== undefined) {
            const allowedDeviceTypes = [
                "pos",
                "desktop",
                "laptop",
                "tablet",
                "mobile",
                "other",
            ];

            if (!allowedDeviceTypes.includes(deviceType)) {
                return NextResponse.json(
                    {
                        success: false,
                        message: "Invalid device type",
                    },
                    { status: 400 }
                );
            }

            device.deviceType = deviceType;
        }

        // Update status
        if (status !== undefined) {
            if (status !== "active" && status !== "inactive") {
                return NextResponse.json(
                    {
                        success: false,
                        message: "Invalid device status",
                    },
                    { status: 400 }
                );
            }

            device.status = status;
        }

        // Save updated device
        await device.save();

        // Values AFTER the update
        const newValues = {
            deviceName: device.deviceName,
            deviceType: device.deviceType,
            status: device.status,
        };

        // Determine what kind of action happened
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

        // Create audit log
        const auditLog = await AuditLogService.createAuditLog(
            {
                userId: new mongoose.Types.ObjectId(TEST_USER_ID),
                tenantId,
                deviceId: device._id,
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
            }
        );

        return NextResponse.json({
            success: true,
            message: "Device updated successfully",
            device,
            auditLog,
        });
    } catch (error) {
        console.error("Device update error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to update device",
            },
            { status: 500 }
        );
    }
}