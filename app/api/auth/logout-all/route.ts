
import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";

import { getAuthenticatedContext } from "@/lib/auth/getAuthenticatedContext";
import { revokeAllUserSessions } from "@/lib/auth/sessionStore";

// POST /api/auth/logout-all
// Revokes every session of the CALLER (all devices). Requires a valid
// session; it can never target another user.
export async function POST(request: NextRequest) {
    try {
        const context = await getAuthenticatedContext(request, {
            allowPasswordChangeRequired: true,
        });

        if (!context) {
            return NextResponse.json(
                { success: false, message: "Authentication required" },
                { status: 401 }
            );
        }

        const revoked = await revokeAllUserSessions(
            new Types.ObjectId(context.tenantId),
            new Types.ObjectId(context.userId),
            "logout-all"
        );

        const response = NextResponse.json({
            success: true,
            message: "Logged out of all sessions",
            revokedSessions: revoked,
        });

        response.cookies.set("session", "", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/",
            expires: new Date(0),
        });

        return response;
    } catch (error) {
        console.error(
            "Logout-all error:",
            error instanceof Error ? error.name : "unknown"
        );

        return NextResponse.json(
            { success: false, message: "Unable to log out of all sessions" },
            { status: 500 }
        );
    }
}
