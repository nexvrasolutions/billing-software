import { NextResponse, type NextRequest } from "next/server";

import {
    SESSION_COOKIE_NAME,
    checkOrigin,
    parseAllowedOrigins,
} from "@/lib/security/originCheck";

/*
 * Next.js 16 Proxy (the former middleware). Runs before every /api/* request
 * and refuses a state-changing request that does not come from this app
 * itself (CSRF defence, second layer; the rules and their limits are in
 * lib/security/originCheck.ts).
 *
 * Only the Origin decision happens here: no session, permission, tenant or
 * database logic. Each route still authenticates and authorizes by itself.
 * A refusal is HTTP 403 with code ORIGIN_REFUSED; the offline sync client
 * treats that code as "stop without touching the queued item"
 * (lib/offline/syncPolicy.ts).
 *
 * ALLOWED_ORIGINS (optional, comma separated) lists extra exact origins,
 * needed only behind a reverse proxy that rewrites the Host header.
 */

const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

export function proxy(request: NextRequest): NextResponse {
    const decision = checkOrigin({
        method: request.method,
        origin: request.headers.get("origin"),
        host: request.headers.get("host"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        secFetchSite: request.headers.get("sec-fetch-site"),
        hasSessionCookie: Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value),
        allowedOrigins,
    });

    if (decision.allowed) return NextResponse.next();

    // Only the reason code is logged: never header values, cookies or bodies.
    console.warn("Origin check refused a request:", decision.reason, request.method);

    return NextResponse.json(
        {
            success: false,
            code: "ORIGIN_REFUSED",
            message: "Request refused.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } }
    );
}

export const config = {
    matcher: "/api/:path*",
};
