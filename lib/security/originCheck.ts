
/*
 * CSRF defence, second layer: the Origin check (pure, no Next.js or database
 * imports, so it can be unit-tested). The first layer is the SameSite=Lax
 * session cookie. proxy.ts applies this to every /api/* request.
 *
 * Rules, in order:
 *  1. GET, HEAD and OPTIONS change nothing and are always allowed.
 *  2. Any other method with an Origin header is allowed only if that origin
 *     is the app itself: its host equals the request's Host header (or the
 *     first X-Forwarded-Host, which a hosting proxy sets), or it is listed
 *     exactly in ALLOWED_ORIGINS. "null", malformed values, other hosts,
 *     other ports and other schemes are refused.
 *  3. Without an Origin header (a non-browser caller, or a very old browser):
 *       - Sec-Fetch-Site same-origin or none: allowed;
 *       - Sec-Fetch-Site cross-site, same-site or anything else: refused;
 *       - no Sec-Fetch-Site either: allowed ONLY when the request carries no
 *         session cookie (there is no login to ride on), otherwise refused.
 *
 * Browsers always send Origin on POST/PUT/PATCH/DELETE (also same-origin),
 * so the legitimate pages, the offline sync and the service worker (which
 * forwards the original request) are covered by rule 2.
 *
 * LIMITS: this protects a victim's BROWSER from other sites. It does not
 * authenticate anyone, replaces no permission or tenant check, and cannot
 * stop a caller that is not a browser and simply sets the headers itself
 * (such a caller needs its own valid session anyway). Behind a reverse proxy
 * that rewrites Host without sending X-Forwarded-Host, list the public
 * origin in ALLOWED_ORIGINS (comma separated, e.g. https://shop.example.in).
 */

export const SESSION_COOKIE_NAME = "session";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginCheckInput {
    method: string;
    /** The Origin header, or null when the request has none. */
    origin: string | null;
    /** The Host header. */
    host: string | null;
    /** The X-Forwarded-Host header (may be a comma-separated list). */
    forwardedHost: string | null;
    /** The Sec-Fetch-Site header. */
    secFetchSite: string | null;
    /** Whether the request carries a non-empty session cookie. */
    hasSessionCookie: boolean;
    /** Exact origins that are also accepted (see parseAllowedOrigins). */
    allowedOrigins?: readonly string[];
}

export type OriginDecision =
    | { allowed: true; reason: string }
    | { allowed: false; reason: string };

/**
 * The bare origin ("https://shop.example.in") of a value, or null when it is
 * not exactly an http(s) origin (a path, query, credentials, "null" or
 * garbage all give null).
 */
export function normalizeOrigin(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    // Must already be in origin form (no trailing slash, nothing extra).
    return url.origin === value.toLowerCase() ? url.origin : null;
}

/** Parses the ALLOWED_ORIGINS setting: comma separated, invalid entries dropped. */
export function parseAllowedOrigins(value: string | undefined | null): string[] {
    if (!value) return [];
    const result: string[] = [];
    for (const entry of value.split(",")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        // Accept a trailing slash in the setting, but nothing else extra.
        const origin = normalizeOrigin(trimmed.replace(/\/$/, ""));
        if (origin && !result.includes(origin)) result.push(origin);
    }
    return result;
}

function hostOf(origin: string): string {
    return new URL(origin).host.toLowerCase();
}

function candidateHosts(host: string | null, forwardedHost: string | null): string[] {
    const hosts: string[] = [];
    const direct = host?.trim().toLowerCase();
    if (direct) hosts.push(direct);
    const forwarded = forwardedHost?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) hosts.push(forwarded);
    return hosts;
}

export function checkOrigin(input: OriginCheckInput): OriginDecision {
    if (SAFE_METHODS.has(input.method.toUpperCase())) {
        return { allowed: true, reason: "safe-method" };
    }

    // ---- Origin present (an empty value counts as present, and is invalid)
    if (input.origin !== null) {
        const origin = normalizeOrigin(input.origin);
        if (origin === null) return { allowed: false, reason: "origin-invalid" };

        if ((input.allowedOrigins ?? []).includes(origin)) {
            return { allowed: true, reason: "origin-allow-listed" };
        }
        if (candidateHosts(input.host, input.forwardedHost).includes(hostOf(origin))) {
            return { allowed: true, reason: "origin-matches-host" };
        }
        return { allowed: false, reason: "origin-mismatch" };
    }

    // ---- No Origin header
    const fetchSite = input.secFetchSite?.trim().toLowerCase() ?? null;
    if (fetchSite !== null) {
        return fetchSite === "same-origin" || fetchSite === "none"
            ? { allowed: true, reason: "fetch-site-same-origin" }
            : { allowed: false, reason: "fetch-site-not-same-origin" };
    }

    return input.hasSessionCookie
        ? { allowed: false, reason: "no-origin-with-session" }
        : { allowed: true, reason: "no-origin-no-session" };
}
