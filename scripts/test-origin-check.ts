
/*
 * Origin (CSRF) check tests (NO DATABASE, NO BROWSER, NO NETWORK, NO SERVER).
 *
 * Exercises lib/security/originCheck.ts, the one syncPolicy rule that
 * depends on it, and (by reading source files) the shape of proxy.ts.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-origin-check.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { interpretResponse, stateAfterFailure } from "../lib/offline/syncPolicy";
import {
    checkOrigin,
    normalizeOrigin,
    parseAllowedOrigins,
    type OriginCheckInput,
} from "../lib/security/originCheck";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const APP = "https://shop.example.in";

/** A same-origin browser POST unless overridden. */
function request(over: Partial<OriginCheckInput> = {}): OriginCheckInput {
    return {
        method: "POST",
        origin: APP,
        host: "shop.example.in",
        forwardedHost: null,
        secFetchSite: "same-origin",
        hasSessionCookie: true,
        allowedOrigins: [],
        ...over,
    };
}

const allowed = (over: Partial<OriginCheckInput> = {}) => checkOrigin(request(over)).allowed;
const reason = (over: Partial<OriginCheckInput> = {}) => checkOrigin(request(over)).reason;

// ------------------------------------------------------------ safe methods
for (const method of ["GET", "HEAD", "OPTIONS", "get", "Head"]) {
    check(`M1. ${method} is always allowed, even with a foreign origin and no headers`,
        allowed({ method, origin: "https://evil.test", host: "shop.example.in", secFetchSite: "cross-site" })
        && allowed({ method, origin: null, secFetchSite: null }));
}
check("M2. GET without any headers (offline verification, service worker reads) is allowed",
    allowed({ method: "GET", origin: null, host: null, forwardedHost: null, secFetchSite: null, hasSessionCookie: true }));

// ------------------------------------------------------------ same origin
for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    check(`S1. A same-origin ${method} is allowed`, allowed({ method }));
}
check("S2. The decision for a matching origin says so", reason() === "origin-matches-host");
check("S3. Host and origin are compared case-insensitively",
    allowed({ host: "SHOP.Example.IN" }) && allowed({ origin: "HTTPS://SHOP.EXAMPLE.IN" }));
check("S4. A local development origin with a port matches its Host",
    allowed({ origin: "http://localhost:3130", host: "localhost:3130" }));

// ------------------------------------------------------------ refused origins
check("R1. Another site is refused", !allowed({ origin: "https://evil.test" }) && reason({ origin: "https://evil.test" }) === "origin-mismatch");
check("R2. A different port is refused", !allowed({ origin: "http://localhost:3131", host: "localhost:3130" }));
check("R3. A look-alike host (suffix or prefix) is refused",
    !allowed({ origin: "https://shop.example.in.evil.test" }) && !allowed({ origin: "https://evilshop.example.in" })
    && !allowed({ origin: "https://sub.shop.example.in" }));
check("R4. The literal origin \"null\" (sandboxed frames, some redirects) is refused",
    !allowed({ origin: "null" }) && reason({ origin: "null" }) === "origin-invalid");
check("R5. An empty or malformed Origin is refused, not crashed on",
    ["", " ", "garbage", "https://", "//shop.example.in", "shop.example.in", "javascript:alert(1)", "ftp://shop.example.in"]
        .every((origin) => !allowed({ origin })));
check("R6. An Origin with a path, query, credentials or trailing slash is not a bare origin: refused",
    ["https://shop.example.in/", "https://shop.example.in/x", "https://shop.example.in?x=1", "https://user:pw@shop.example.in"]
        .every((origin) => !allowed({ origin })));
check("R7. A foreign Origin is refused even when Sec-Fetch-Site says same-origin and a session cookie is absent",
    !allowed({ origin: "https://evil.test", secFetchSite: "same-origin", hasSessionCookie: false }));
check("R8. Without a Host header, a present Origin cannot match and is refused",
    !allowed({ host: null, forwardedHost: null }));

// ------------------------------------------------------------ forwarded host
check("F1. Behind a proxy, the first X-Forwarded-Host is accepted",
    allowed({ host: "internal:3000", forwardedHost: "shop.example.in" })
    && allowed({ host: "internal:3000", forwardedHost: "shop.example.in, other.proxy" }));
check("F2. Only the FIRST forwarded host counts (later entries are not trusted)",
    !allowed({ host: "internal:3000", forwardedHost: "other.proxy, shop.example.in" }));
check("F3. A forwarded host does not make a foreign origin acceptable",
    !allowed({ origin: "https://evil.test", host: "internal:3000", forwardedHost: "shop.example.in" }));

// ------------------------------------------------------------ allow list
const listed = parseAllowedOrigins(" https://shop.example.in , https://admin.example.in/ ,, not a url, ftp://x.test, https://shop.example.in");
check("L1. ALLOWED_ORIGINS keeps valid origins once, drops invalid ones and trailing slashes",
    JSON.stringify(listed) === JSON.stringify(["https://shop.example.in", "https://admin.example.in"]), JSON.stringify(listed));
check("L2. Empty or missing setting gives an empty list",
    parseAllowedOrigins(undefined).length === 0 && parseAllowedOrigins("").length === 0 && parseAllowedOrigins(null).length === 0);
check("L3. A listed origin is allowed even when Host differs (reverse proxy rewriting Host)",
    allowed({ origin: "https://shop.example.in", host: "internal:3000", allowedOrigins: listed })
    && reason({ origin: "https://shop.example.in", host: "internal:3000", allowedOrigins: listed }) === "origin-allow-listed");
check("L4. The list matches EXACTLY: other schemes, ports and look-alikes are refused",
    !allowed({ origin: "http://shop.example.in", host: "internal:3000", allowedOrigins: listed })
    && !allowed({ origin: "https://shop.example.in:8443", host: "internal:3000", allowedOrigins: listed })
    && !allowed({ origin: "https://shop.example.in.evil.test", host: "internal:3000", allowedOrigins: listed })
    && !allowed({ origin: "https://evil.example.in", host: "internal:3000", allowedOrigins: listed }));
check("L5. normalizeOrigin returns the bare origin only for exact origins",
    normalizeOrigin("https://shop.example.in") === APP && normalizeOrigin("https://shop.example.in/") === null
    && normalizeOrigin("null") === null && normalizeOrigin("") === null);

// ------------------------------------------------------------ missing Origin
const noOrigin = (over: Partial<OriginCheckInput> = {}) => ({ origin: null, ...over });
check("O1. No Origin + Sec-Fetch-Site same-origin: allowed", allowed(noOrigin({ secFetchSite: "same-origin" })));
check("O2. No Origin + Sec-Fetch-Site none (typed URL, bookmarks): allowed", allowed(noOrigin({ secFetchSite: "none" })));
check("O3. No Origin + Sec-Fetch-Site cross-site: refused", !allowed(noOrigin({ secFetchSite: "cross-site" })));
check("O4. No Origin + Sec-Fetch-Site same-site (a sibling subdomain): refused", !allowed(noOrigin({ secFetchSite: "same-site" })));
check("O5. No Origin + an unknown Sec-Fetch-Site value: refused", !allowed(noOrigin({ secFetchSite: "something-new" })));
check("O6. Sec-Fetch-Site is compared case-insensitively", allowed(noOrigin({ secFetchSite: " Same-Origin " })));
check("O7. No Origin, no Sec-Fetch-Site, no session cookie (a plain non-browser caller): allowed",
    allowed(noOrigin({ secFetchSite: null, hasSessionCookie: false })) && reason(noOrigin({ secFetchSite: null, hasSessionCookie: false })) === "no-origin-no-session");
check("O8. No Origin, no Sec-Fetch-Site, WITH a session cookie (could be riding a login): refused",
    !allowed(noOrigin({ secFetchSite: null, hasSessionCookie: true })) && reason(noOrigin({ secFetchSite: null, hasSessionCookie: true })) === "no-origin-with-session");
check("O9. A cross-site Sec-Fetch-Site is refused even without a session cookie",
    !allowed(noOrigin({ secFetchSite: "cross-site", hasSessionCookie: false })));

// ------------------------------------------------------------ the offline sync client
const refusedBody = { success: false, code: "ORIGIN_REFUSED", message: "Request refused." };
const outcome403 = interpretResponse(403, refusedBody);
check("Y1. A refused Origin (HTTP 403, ORIGIN_REFUSED) stops the sync run without touching the item",
    outcome403.kind === "stop", JSON.stringify(outcome403));
check("Y2. ...so it is never turned into a failed attempt: stateAfterFailure is not even consulted for \"stop\"",
    outcome403.kind === "stop" && !("retryAfterSeconds" in outcome403));
check("Y3. Other 403 answers are unchanged (a permission refusal is still permanent)",
    interpretResponse(403, { success: false, code: "PERMISSION_DENIED", retryable: false, message: "x" }).kind === "permanent");
check("Y4. 401 and OWNER_MISMATCH still stop; 5xx is still retryable; 2xx is still success",
    interpretResponse(401, {}).kind === "stop" && interpretResponse(403, { code: "OWNER_MISMATCH" }).kind === "stop"
    && interpretResponse(503, {}).kind === "retryable" && interpretResponse(200, { success: true }).kind === "success");
check("Y5. Unrelated attempts still count normally (a retryable failure schedules a later attempt)",
    stateAfterFailure({ kind: "retryable", message: "x" }, 1, new Date(0), () => 0.5).status === "FAILED");

// ------------------------------------------------------------ source shape
const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const proxy = read("proxy.ts");

check("P1. proxy.ts exports a named proxy function (Next.js 16 convention) at the project root", /export function proxy\(/.test(proxy));
check("P2. proxy.ts applies only to /api/:path*", /matcher:\s*"\/api\/:path\*"/.test(proxy) && (proxy.match(/matcher/g) ?? []).length >= 1);
check("P3. proxy.ts only decides on the Origin: no database, session, tenant or permission logic",
    !/mongoose|connectDB|@\/lib\/models|getSession|getAuthenticatedContext|hasPermission|verifySessionToken/.test(proxy));
check("P4. proxy.ts answers a refusal with HTTP 403 and code ORIGIN_REFUSED",
    /status:\s*403/.test(proxy) && /code:\s*"ORIGIN_REFUSED"/.test(proxy));
check("P5. proxy.ts logs only the reason code and method, never header values or cookies",
    /console\.warn\("Origin check refused a request:", decision\.reason, request\.method\)/.test(proxy));

const sync = read("lib/offline/SyncManager.ts");
check("Q1. A stopped sync restores status and lastAttemptAt and counts no attempt",
    /releaseItem\(id, item\.status === "FAILED" \? "FAILED" : "PENDING", \{ lastAttemptAt: item\.lastAttemptAt \}\)/.test(sync));
// A refused Origin ("stop") takes syncOne's restore branch: from the
// restore decision up to the failed-attempt path that follows it.
const restoreStart = sync.indexOf('decision.action === "restore"');
const restoreEnd = sync.indexOf("await markAttemptFailed", restoreStart);
const stopBlock = restoreStart >= 0 && restoreEnd > restoreStart ? sync.slice(restoreStart, restoreEnd) : "";
check("Q2. ...and that stop branch never calls markAttemptFailed or markSynced",
    stopBlock.trim().length > 0
    && stopBlock.includes("releaseItem(") && !stopBlock.includes("markAttemptFailed(") && !stopBlock.includes("markSynced("),
    stopBlock.trim().length > 0 ? undefined : "restore branch not found in SyncManager.ts (markers changed)");

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
