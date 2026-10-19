import { NextRequest } from "next/server";
import {
    handleGetBusinessSettings,
    handlePutBusinessSettings,
} from "@/lib/settings/businessSettings";

// GET /api/settings/business - Read current business settings
export async function GET(request: NextRequest) {
    return handleGetBusinessSettings(request);
}

// PUT /api/settings/business - Update business settings (Admin or Owner only)
export async function PUT(request: NextRequest) {
    return handlePutBusinessSettings(request);
}
