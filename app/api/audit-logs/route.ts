import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { AuditLog } from "@/lib/models/AuditLog";

const TEST_TENANT_ID = "6abe48a86ae4b08a3e335303";
const TEST_USER_ID = "6abe4d3f6ae4b08a3e335463";

export async function POST(request: Request) {
    try {
        await connectDB();

        const body = await request.json();

        const {
            action,
            entity,
            entityId,
            description,
            oldValues,
            newValues,
            deviceId,
        } = body;

        if (!action || !entity) {
            return NextResponse.json(
                {
                    success: false,
                    message: "action and entity are required",
                },
                { status: 400 }
            );
        }

        if (
            entityId !== undefined &&
            !mongoose.Types.ObjectId.isValid(entityId)
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid entityId",
                },
                { status: 400 }
            );
        }

        if (
            deviceId !== undefined &&
            !mongoose.Types.ObjectId.isValid(deviceId)
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid deviceId",
                },
                { status: 400 }
            );
        }

        const auditLog = await AuditLog.create({
            tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),

            userId: new mongoose.Types.ObjectId(TEST_USER_ID),

            deviceId: deviceId
                ? new mongoose.Types.ObjectId(deviceId)
                : undefined,

            action: action.trim(),
            entity: entity.trim(),

            entityId: entityId
                ? new mongoose.Types.ObjectId(entityId)
                : undefined,

            description: description?.trim(),

            oldValues,
            newValues,
        });

        return NextResponse.json(
            {
                success: true,
                message: "Audit log created successfully",
                auditLog,
            },
            { status: 201 }
        );
    } catch (error) {
        console.error("Audit log creation error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to create audit log",
            },
            { status: 500 }
        );
    }
}

export async function GET() {
    try {
        await connectDB();

        const auditLogs = await AuditLog.find({
            tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),
        })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        return NextResponse.json({
            success: true,
            count: auditLogs.length,
            auditLogs,
        });
    } catch (error) {
        console.error("Audit log fetch error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to fetch audit logs",
            },
            { status: 500 }
        );
    }
}