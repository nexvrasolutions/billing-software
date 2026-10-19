
/*
 * Security header tests (NO DATABASE, NO BROWSER, NO NETWORK, NO SERVER).
 *
 * Imports next.config.ts and calls its real headers() function, so the
 * values checked here are the values that ship. The PWA wrapper only
 * registers webpack hooks when imported; nothing is built or started.
 * A few checks read source files to pin that other protections are intact.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-security-headers.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

type Rule = { source: string; headers: { key: string; value: string }[] };

const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;

async function rulesFor(nodeEnv: string): Promise<{ rules: Rule[]; config: Record<string, unknown> }> {
    env.NODE_ENV = nodeEnv;
    const imported = (await import("../next.config")) as unknown as { default: Record<string, unknown> };
    const config = imported.default;
    const headers = config.headers as (() => Promise<Rule[]>) | undefined;
    if (typeof headers !== "function") throw new Error("next.config.ts has no headers()");
    return { rules: await headers.call(config), config };
}

const directives = (policy: string) =>
    new Map(policy.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values] as const;
    }));

async function main() {
    const production = await rulesFor("production");
    const development = await rulesFor("development");
    env.NODE_ENV = originalNodeEnv;

    // ------------------------------------------------------------ structure
    check("H1. Exactly two header rules: the security headers for every path (/:path*) and no-store for the API (/api/:path*)",
        production.rules.length === 2 && production.rules[0].source === "/:path*" && production.rules[1].source === "/api/:path*",
        JSON.stringify(production.rules.map((r) => r.source)));
    const headers = production.rules[0].headers;
    const names = headers.map((h) => h.key.toLowerCase());
    check("H2. No header name is set twice", new Set(names).size === names.length, names.join(","));
    const apiHeaders = production.rules[1]?.headers ?? [];
    check("H5. The API rule sets only Cache-Control: no-store, and no header name overlaps the rule for every path",
        apiHeaders.length === 1 && apiHeaders[0].key === "Cache-Control" && apiHeaders[0].value === "no-store"
        && !names.includes("cache-control"));
    check("H6. Production and development apply the same API rule",
        JSON.stringify(development.rules[1]) === JSON.stringify(production.rules[1]));
    const get = (key: string, list = headers) => list.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

    check("H3. The poweredBy header is switched off", production.config.poweredByHeader === false);
    check("H4. The PWA wrapper kept the headers function and poweredByHeader setting",
        typeof production.config.headers === "function" && typeof production.config.webpack === "function");

    // ------------------------------------------------------------ CSP: report-only
    check("C1. CSP exists ONLY as Content-Security-Policy-Report-Only (nothing is enforced)",
        Boolean(get("Content-Security-Policy-Report-Only")) && get("Content-Security-Policy") === undefined);
    const policy = get("Content-Security-Policy-Report-Only") ?? "";
    const d = directives(policy);
    const only = (name: string, expected: string[]) => JSON.stringify(d.get(name)) === JSON.stringify(expected);

    check("C2. default-src, connect-src, worker-src, manifest-src, media-src and font-src are 'self' only",
        ["default-src", "connect-src", "worker-src", "manifest-src", "media-src", "font-src"].every((n) => only(n, ["'self'"])),
        policy);
    check("C3. img-src allows only 'self', data: and blob:", only("img-src", ["'self'", "data:", "blob:"]));
    check("C4. object-src is 'none'; base-uri and form-action are 'self'; frame-ancestors is 'none'",
        only("object-src", ["'none'"]) && only("base-uri", ["'self'"]) && only("form-action", ["'self'"]) && only("frame-ancestors", ["'none'"]));
    check("C5. script-src is 'self' + 'unsafe-inline' in production (no nonce is possible on static pages), with no eval",
        only("script-src", ["'self'", "'unsafe-inline'"]) && !policy.includes("unsafe-eval"));
    check("C6. style-src is 'self' + 'unsafe-inline'", only("style-src", ["'self'", "'unsafe-inline'"]));
    check("C7. In development only, script-src also allows 'unsafe-eval'",
        only("script-src", ["'self'", "'unsafe-inline'"]) && JSON.stringify(directives(get("Content-Security-Policy-Report-Only", development.rules[0].headers) ?? "").get("script-src")) ===
        JSON.stringify(["'self'", "'unsafe-inline'", "'unsafe-eval'"]));
    check("C8. No wildcard, no plain http:/https: source, no remote host anywhere in the policy",
        !/(^|[\s;])\*([\s;]|$)/.test(policy) && !/\bhttps?:(?!\/\/)/.test(policy) && !/https?:\/\//.test(policy) && !/\.[a-z]{2,}\b/i.test(policy.replace(/'self'/g, "")));
    check("C9. No nonce, no strict-dynamic, no report endpoint, no upgrade-insecure-requests",
        !/nonce|strict-dynamic|report-uri|report-to|upgrade-insecure-requests/.test(policy));
    check("C10. The policy is one single line (no stray newlines)", !/[\r\n]/.test(policy));
    check("C11. The development policy differs from production only by 'unsafe-eval'",
        (get("Content-Security-Policy-Report-Only", development.rules[0].headers) ?? "").replace(" 'unsafe-eval'", "") === policy);

    // ------------------------------------------------------------ the other headers
    check("X1. X-Content-Type-Options is nosniff", get("X-Content-Type-Options") === "nosniff");
    check("X2. Referrer-Policy is strict-origin-when-cross-origin", get("Referrer-Policy") === "strict-origin-when-cross-origin");
    check("X3. X-Frame-Options is DENY", get("X-Frame-Options") === "DENY");
    check("X4. Cross-Origin-Opener-Policy is same-origin", get("Cross-Origin-Opener-Policy") === "same-origin");
    const permissions = (get("Permissions-Policy") ?? "").split(",").map((p) => p.trim());
    check("X5. Permissions-Policy switches off the unused features and allows none of them",
        ["camera", "microphone", "geolocation", "payment", "usb", "bluetooth", "serial", "hid", "display-capture", "accelerometer", "gyroscope", "magnetometer"]
            .every((feature) => permissions.includes(`${feature}=()`)) && permissions.every((p) => /^[a-z-]+=\(\)$/.test(p)),
        permissions.join(", "));

    // ------------------------------------------------------------ deliberately absent
    check("N1. No Strict-Transport-Security (decided with the hosting, not here)", get("Strict-Transport-Security") === undefined);
    check("N2. No Cross-Origin-Embedder-Policy and no Cross-Origin-Resource-Policy",
        get("Cross-Origin-Embedder-Policy") === undefined && get("Cross-Origin-Resource-Policy") === undefined);
    check("N3. The same header values apply in development and production except 'unsafe-eval' in the CSP",
        JSON.stringify(development.rules[0].headers.filter((h) => h.key !== "Content-Security-Policy-Report-Only")) ===
        JSON.stringify(headers.filter((h) => h.key !== "Content-Security-Policy-Report-Only")));

    // ------------------------------------------------------------ other protections untouched
    const root = process.cwd();
    const read = (file: string) => readFileSync(path.join(root, file), "utf8");
    const config = read("next.config.ts");
    check("K1. The PWA precache still lists /dashboard and /offline-test",
        /url: "\/dashboard"/.test(config) && /url: "\/offline-test"/.test(config));
    check("K2. API GET requests are still NetworkOnly (never cached)",
        /pathname\.startsWith\("\/api\/"\)/.test(config) && /handler: "NetworkOnly"/.test(config));
    check("K3. The PWA wrapper, dest, register and extendDefaultRuntimeCaching are unchanged",
        /dest: "public"/.test(config) && /register: true/.test(config) && /extendDefaultRuntimeCaching: true/.test(config)
        && /export default withPWA\(/.test(config));

    const proxy = read("proxy.ts");
    check("K4. proxy.ts still applies the Origin check to /api/:path*",
        /matcher:\s*"\/api\/:path\*"/.test(proxy) && /checkOrigin\(/.test(proxy) && /ORIGIN_REFUSED/.test(proxy));
    check("K5. proxy.ts sets no security headers or CSP (no duplicates with next.config.ts)",
        !/Content-Security-Policy|X-Frame-Options|X-Content-Type-Options|Referrer-Policy|Permissions-Policy|Strict-Transport-Security|Cross-Origin-/i.test(proxy));
    const worker = read("worker/index.ts");
    check("K6. The custom service-worker code is unchanged in purpose (only deletes the old apis cache)",
        /caches\.delete\("apis"\)/.test(worker));

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((error: unknown) => {
    console.error("Security header tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
