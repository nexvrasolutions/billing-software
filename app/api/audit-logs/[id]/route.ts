import { NextResponse } from "next/server";
import mongoose from "mongoose";

import { connectDB } from "@/lib/db/mongodb";
import { AuditLog } from "@/lib/models/AuditLog";

const TEST_TENANT_ID = "6abe48a86ae4b08a3e335303";

type RouteContext = {
    params: Promise<{
        id: string;
    }>;
};

export async function GET(
    request: Request,
    context: RouteContext
) {
    try {
        await connectDB();

        const { id } = await context.params;

        // Validate audit log ID
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Invalid audit log ID",
                },
                { status: 400 }
            );
        }

        const auditLog = await AuditLog.findOne({
            _id: new mongoose.Types.ObjectId(id),

            // Important: tenant isolation
            tenantId: new mongoose.Types.ObjectId(TEST_TENANT_ID),
        }).lean();

        if (!auditLog) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Audit log not found",
                },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            auditLog,
        });
    } catch (error) {
        console.error("Audit log fetch error:", error);

        return NextResponse.json(
            {
                success: false,
                message: "Failed to fetch audit log",
            },
            { status: 500 }
        );
    }
}