import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";


import { connectDB } from "@/lib/db/mongodb";
import { SyncOperation } from "@/lib/models/SyncOperation";

export async function POST(request: NextRequest) {
    try {
        await connectDB();

        const body = await request.json();

        const {
            tenantId,
            deviceId,
            operationId,
            operationType,
            entityType,
            entityId,
            payload,
        } = body;

        if (!tenantId) {
            return NextResponse.json(
                {
                    success: false,
                    message: "tenantId is required",
                },
                { status: 400 }
            );
        }

        if (!deviceId) {
            return NextResponse.json(
                {
                    success: false,
                    message: "deviceId is required",
                },
                { status: 400 }
            );
        }

        if (!operationId) {
            return NextResponse.json(
                {
                    success: false,
                    message: "operationId is required",
                },
                { status: 400 }
            );
        }

        if (!operationType) {
            return NextResponse.json(
                {
                    success: false,
                    message: "operationType is required",
                },
                { status: 400 }
            );
        }

        if (!entityType) {
            return NextResponse.json(
                {
                    success: false,
                    message: "entityType is required",
                },
                { status: 400 }
            );
        }

        if (!payload) {
            return NextResponse.json(
                {
                    success: false,
                    message: "payload is required",
                },
                { status: 400 }
            );
        }

        if (!mongoose.Types.ObjectId.isValid(tenantId)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid tenantId",
                },
                { status: 400 }
            );
        }

        if (!mongoose.Types.ObjectId.isValid(deviceId)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid deviceId",
                },
                { status: 400 }
            );
        }

        if (
            entityId &&
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

        const syncOperation = await SyncOperation.create({
            tenantId: new mongoose.Types.ObjectId(tenantId),
            deviceId: new mongoose.Types.ObjectId(deviceId),
            operationId,
            operationType,
            entityType,
            entityId: entityId
                ? new mongoose.Types.ObjectId(entityId)
                : undefined,
            payload,
            status: "PENDING",
            attempts: 0,
        });

        return NextResponse.json(
            {
                success: true,
                message: "Sync operation created successfully",
                syncOperation,
            },
            { status: 201 }
        );
    } catch (error: unknown) {
        console.error("Create sync operation error:", error);

        if (
            error instanceof mongoose.Error.ValidationError
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message: error.message,
                },
                { status: 400 }
            );
        }

        if (
            error instanceof mongoose.mongo.MongoServerError &&
            error.code === 11000
        ) {
            return NextResponse.json(
                {
                    success: false,
                    message:
                        "operationId already exists for this tenant",
                },
                { status: 409 }
            );
        }

        return NextResponse.json(
            {
                success: false,
                message: "Failed to create sync operation",
            },
            { status: 500 }
        );
    }
}