
import { NextRequest, NextResponse } from "next/server";

import { connectDB } from "@/lib/db/mongodb";
import { verifySessionToken } from "@/app/api/auth/session";
import { revokeSession } from "@/lib/auth/sessionStore";

function clearSessionCookie(response: NextResponse) {
    response.cookies.set("session", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        expires: new Date(0),
    });

    return response;
}

/*
 * Logout revokes the server-side session FIRST, so the token stops working
 * everywhere (including copies), then clears the browser cookie.
 * Only the session named by the caller's own validly signed token can be
 * revoked here.
 */
export async function POST(request: NextRequest) {
    const token = request.cookies.get("session")?.value;
    const payload = token ? await verifySessionToken(token) : null;

    if (payload) {
        try {
            await connectDB();
            await revokeSession(payload, "logout");
        } catch (error) {
            console.error(
                "Logout revocation error:",
                error instanceof Error ? error.name : "unknown"
            );

            // The cookie is still cleared locally, but report honestly that
            // the server-side session may still be valid.
            return clearSessionCookie(
                NextResponse.json(
                    {
                        success: false,
                        message:
                            "Logged out on this device, but the session could not be revoked on the server. Please try again.",
                    },
                    { status: 503 }
                )
            );
        }
    }

    return clearSessionCookie(
        NextResponse.json({
            success: true,
            message: "Logged out successfully",
        })
    );
}
