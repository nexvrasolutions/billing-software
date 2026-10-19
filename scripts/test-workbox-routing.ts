/**
 * Workbox Routing and Offline Configuration Static Verification (M-20)
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER)
 *
 * Verifies:
 * 1. next.config.ts PWA configuration:
 *    - /dashboard, /offline-test, and /pos are in additionalManifestEntries
 *    - /api/* is handled by NetworkOnly (no sensitive business data cached)
 *    - Next.js CSS styles are handled by StaleWhileRevalidate (not CacheFirst)
 *    - skipWaiting is false (no mid-sale disruption)
 *    - reloadOnOnline is false (no reload cutting off offline queue sync)
 * 2. components/layout/AppShell.tsx:
 *    - /api/auth/me uses AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)
 *    - Guaranteed setLoading(false) on offline / 401 / 403 / network rejection
 * 3. components/pos/pos-screen.tsx:
 *    - /api/products and /api/auth/me use AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)
 * 4. app/dashboard/page.tsx:
 *    - warmOfflinePages pre-fetches /dashboard, /pos, /offline-test, /catalog/products
 * 5. Route Intent Verification:
 *    - /catalog/lists is confirmed online-only (no offline mutations)
 *    - /pos, /dashboard, and /catalog/products have offline restoration & caching
 *
 * Run:
 *   npx tsx scripts/test-workbox-routing.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const nextConfig = read("next.config.ts");
const appShell = read("components/layout/AppShell.tsx");
const posScreen = read("components/pos/pos-screen.tsx");
const dashboard = read("app/dashboard/page.tsx");
const catalogLists = read("app/catalog/lists/page.tsx");
const catalogProducts = read("app/catalog/products/page.tsx");

// ------------------------------------------------------------ 1. next.config.ts Workbox Configuration
check("W1. /dashboard is precached in additionalManifestEntries",
    /url:\s*"\/dashboard"/.test(nextConfig));

check("W2. /offline-test is precached in additionalManifestEntries",
    /url:\s*"\/offline-test"/.test(nextConfig));

check("W3. /pos is precached in additionalManifestEntries for immediate offline billing",
    /url:\s*"\/pos"/.test(nextConfig));

check("W4. Authenticated /api/* requests are strictly NetworkOnly",
    /url\.pathname\.startsWith\("\/api\/"\)[\s\S]*?handler:\s*"NetworkOnly"[\s\S]*?cacheName:\s*"apis"/.test(nextConfig));

check("W5. Next.js CSS assets use StaleWhileRevalidate (NOT CacheFirst)",
    /static-style-assets[\s\S]*?handler:\s*"StaleWhileRevalidate"/.test(nextConfig) ||
    /handler:\s*"StaleWhileRevalidate"[\s\S]*?cacheName:\s*"static-style-assets"/.test(nextConfig));

check("W6. CSS asset matcher matches query strings /_next/static/css/ via pathname",
    /url\.pathname\.startsWith\("\/_next\/static\/css\/"\)/.test(nextConfig));

check("W7. skipWaiting is false (open tabs not disrupted without user consent)",
    /skipWaiting:\s*false/.test(nextConfig));

check("W8. reloadOnOnline is false (reconnect does not dump in-progress cart)",
    /reloadOnOnline:\s*false/.test(nextConfig));

// ------------------------------------------------------------ 2. AppShell Timeout & Loading Resilience
check("S1. AppShell imports SESSION_CHECK_TIMEOUT_MS from sessionIdentity",
    /import\s*\{[^}]*SESSION_CHECK_TIMEOUT_MS[^}]*\}\s*from\s*["']@\/lib\/offline\/sessionIdentity["']/.test(appShell));

check("S2. AppShell /api/auth/me uses AbortSignal.timeout to prevent offline loading hang",
    /fetch\("\/api\/auth\/me",[\s\S]*?signal:\s*AbortSignal\.timeout\(SESSION_CHECK_TIMEOUT_MS\)/.test(appShell));

check("S3. AppShell releases loading state on 401/403 rejection",
    /if\s*\(response\.status === 401 \|\| response\.status === 403\)\s*\{[\s\S]*?setLoading\(false\)/.test(appShell));

check("S4. AppShell falls back to restoreOfflineSession when server unreachable",
    /catch\s*\{[\s\S]*?restoreOfflineSession\(\)[\s\S]*?setLoading\(false\)/.test(appShell));

// ------------------------------------------------------------ 3. POS Screen Timeout Protection
check("P1. POS screen imports SESSION_CHECK_TIMEOUT_MS",
    /import\s*\{[^}]*SESSION_CHECK_TIMEOUT_MS[^}]*\}\s*from\s*["']@\/lib\/offline\/sessionIdentity["']/.test(posScreen));

check("P2. POS screen /api/products fetch has AbortSignal.timeout protection",
    /fetch\("\/api\/products",[\s\S]*?signal:\s*AbortSignal\.timeout\(SESSION_CHECK_TIMEOUT_MS\)/.test(posScreen));

check("P3. POS screen /api/auth/me pricing mode fetch has AbortSignal.timeout protection",
    /fetch\("\/api\/auth\/me",[\s\S]*?signal:\s*AbortSignal\.timeout\(SESSION_CHECK_TIMEOUT_MS\)/.test(posScreen));

// ------------------------------------------------------------ 4. Dashboard Offline Warming
check("D1. warmOfflinePages warms /dashboard",
    /warmOfflinePages\(\)[\s\S]*?"\/dashboard"/.test(dashboard));

check("D2. warmOfflinePages warms /pos",
    /warmOfflinePages\(\)[\s\S]*?"\/pos"/.test(dashboard));

check("D3. warmOfflinePages warms /catalog/products",
    /warmOfflinePages\(\)[\s\S]*?"\/catalog\/products"/.test(dashboard));

// ------------------------------------------------------------ 5. Route Intent Verification
check("R1. /catalog/lists has no offline queueing or Dexie imports (confirmed online-only)",
    !/addToSyncQueue|syncQueue|offlineDB|restoreOfflineSession/.test(catalogLists));

check("R2. /catalog/products implements offline catalogue fallback from cache",
    /getCachedProductsForTenant|saveCachedProducts/.test(catalogProducts) &&
    /restoreOfflineSession/.test(catalogProducts));

check("R3. /pos implements offline catalogue fallback and offline queueing",
    /getCachedProductsForTenant/.test(posScreen) &&
    /addToSyncQueue/.test(posScreen) &&
    /restoreOfflineSession/.test(posScreen));

const failed = results.filter((r) => !r.passed);
console.log(`\n========================================`);
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
console.log(`========================================`);
if (failed.length > 0) {
    console.error(`Failed checks:`);
    failed.forEach((f) => console.error(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
}
process.exitCode = failed.length ? 1 : 0;
