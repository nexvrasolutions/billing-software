import { NextRequest } from "next/server";
import { verifySessionToken } from "../../app/api/auth/session";
import { connectDB } from "@/lib/db/mongodb";
import { isSessionActive } from "./sessionStore";

/**
 * Central session check used by every protected route.
 *
 * 1. The cookie must hold a validly signed, unexpired token.
 * 2. The server-side session it names must exist and be neither revoked
 *    nor expired. This is what makes logout effective even if the token
 *    was copied elsewhere.
 */
export async function getSession(
    request: NextRequest
) {
    const sessionToken =
        request.cookies.get("session")?.value;

    if (!sessionToken) {
        return null;
    }

    const session =
        await verifySessionToken(sessionToken);

    if (!session) {
        return null;
    }

    await connectDB();

    if (!(await isSessionActive(session))) {
        return null;
    }

    return session;
}
