
/*
 * Automatic sync on app open / reconnect (M-13)
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * 1. The pure trigger rules in lib/offline/autoSyncPolicy.ts.
 * 2. Source pins: the AutoSync component uses only events (no timers or
 *    loops), removes its listeners, never runs two of its own runs at once,
 *    goes through syncPendingOperations (Web Locks, owner filter, backoff,
 *    NEEDS_ATTENTION never retried); the dashboard mounts it only after the
 *    session was verified; the PWA no longer reloads pages on reconnect.
 *
 * This does NOT prove browser behavior (events, timing, a real reload);
 * that needs the browser test.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-auto-sync.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { MIN_AUTO_SYNC_INTERVAL_MS, shouldStartAutoSync } from "../lib/offline/autoSyncPolicy";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const now = 1_000_000;
const base = { online: true, inFlight: false, lastStartedAt: null as number | null, now };

// ------------------------------------------------------------ trigger rules
check("T1. Opening the page starts a sync", shouldStartAutoSync({ ...base, trigger: "open" }));
check("T2. Going back online starts a sync", shouldStartAutoSync({ ...base, trigger: "online" }));
check("T3. Nothing starts while the browser reports offline",
    (["open", "online", "visible"] as const).every((trigger) => !shouldStartAutoSync({ ...base, trigger, online: false })));
check("T4. Nothing starts while this page's previous run is still in progress",
    (["open", "online", "visible"] as const).every((trigger) => !shouldStartAutoSync({ ...base, trigger, inFlight: true })));
check("T5. Reconnect / tab-visible triggers within 30 s of the last start are ignored (no flooding)",
    MIN_AUTO_SYNC_INTERVAL_MS === 30_000
    && !shouldStartAutoSync({ ...base, trigger: "online", lastStartedAt: now - 5_000 })
    && !shouldStartAutoSync({ ...base, trigger: "visible", lastStartedAt: now - 29_999 }));
check("T6. ...and allowed again after 30 s",
    shouldStartAutoSync({ ...base, trigger: "online", lastStartedAt: now - 30_000 })
    && shouldStartAutoSync({ ...base, trigger: "visible", lastStartedAt: now - 60_000 }));
const flapping = Array.from({ length: 100 }, (_, i) => now + i * 100); // reconnect every 0.1 s for 10 s
let started = 0;
let last: number | null = null;
for (const t of flapping) {
    if (shouldStartAutoSync({ trigger: "online", online: true, inFlight: false, lastStartedAt: last, now: t })) {
        started++;
        last = t;
    }
}
check("T7. A connection flapping 100 times in 10 s starts only one run", started === 1, String(started));

// ------------------------------------------------------------ source pins
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const component = read("components/offline/AutoSync.tsx");
const dashboard = read("app/dashboard/page.tsx");
const config = read("next.config.ts");
const demo = read("app/offline-test/page.tsx");

check("S1. AutoSync uses events only: no timers or loops",
    !/setInterval|setTimeout|requestAnimationFrame|while\s*\(/.test(component));
check("S2. It listens for reconnect and tab-visible, triggers once on open, and removes its listeners",
    /window\.addEventListener\("online", onOnline\)/.test(component) && /window\.removeEventListener\("online", onOnline\)/.test(component)
    && /document\.addEventListener\("visibilitychange", onVisible\)/.test(component) && /document\.removeEventListener\("visibilitychange", onVisible\)/.test(component)
    && (component.match(/trigger\("open"\)/g) ?? []).length === 1);
check("S3. Every run goes through shouldStartAutoSync and syncPendingOperations (Web Locks, owner filter, backoff)",
    /if \(!shouldStartAutoSync\(\{/.test(component) && /await syncPendingOperations\(\)/.test(component)
    && !/offlineDB|fetch\(/.test(component));
check("S4. The in-progress flag is set before the run and cleared in finally",
    /inFlight\.current = true;[\s\S]*?try \{[\s\S]*?finally \{\s*inFlight\.current = false;/.test(component));
const verifiedBranch = dashboard.slice(dashboard.indexOf("function OnlineOfflineStatus"), dashboard.indexOf("export default function DashboardPage"));
check("S5. The dashboard mounts AutoSync only in the verified-session view, and only once",
    (dashboard.match(/<AutoSync/g) ?? []).length === 1 && /<AutoSync/.test(verifiedBranch));
check("S6. In offline mode the dashboard re-checks the session when the connection returns",
    /if \(session !== "unreachable"\) return;[\s\S]*?window\.addEventListener\("online", onOnline\)[\s\S]*?checkSession\(\)\.then\(applySessionCheck\)/.test(dashboard));
check("S7. The PWA no longer reloads every page when the connection returns", /reloadOnOnline: false,/.test(config));
check("S8. The offline test page keeps its own reconnect sync and does not add a second one",
    /useOnlineStatus\(syncOperations\)/.test(demo) && !/<AutoSync/.test(demo));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
