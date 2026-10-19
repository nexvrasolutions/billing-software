
/*
 * Offline client request timeouts (M-4)
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * 1. Simulation: a fake fetch that NEVER answers (it only honours its abort
 *    signal, like the real fetch) is given AbortSignal.timeout(...). The
 *    request must end with a TimeoutError instead of hanging, and that
 *    rejection, handled the way SyncManager's postJson handles it, must give
 *    the M-3 "unreachable" outcome: no attempt counted, item untouched.
 * 2. Source pins: the three browser files give every server request a
 *    timeout with the agreed values (5 s session check, 5 s pending logout,
 *    20 s sync upload/process), and a timeout is never treated as "signed
 *    out" or "logged out".
 *
 * The browser modules themselves (fetch, IndexedDB, service worker) are not
 * run here. This does NOT prove real browser behavior; that needs the
 * browser test.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-request-timeouts.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { decideAfterOutcome, unreachableOutcome, type SyncOutcome } from "../lib/offline/syncPolicy";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A request that never answers. Like the real fetch, it rejects with the signal's reason when aborted. */
function neverAnsweringFetch(_url: string, init?: { signal?: AbortSignal }): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

/** Settled within `ms`? */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return Promise.race([
        promise.then(() => true, () => true),
        sleep(ms).then(() => false),
    ]);
}

/** Same handling as SyncManager.postJson: any rejection -> unreachable. */
async function postLikeSyncManager(fetchImpl: typeof neverAnsweringFetch, timeoutMs: number): Promise<SyncOutcome> {
    try {
        await fetchImpl("/api/sync-operations", { signal: AbortSignal.timeout(timeoutMs) });
        return { kind: "success" };
    } catch {
        return unreachableOutcome();
    }
}

async function main() {
    // Node does not stay alive for AbortSignal.timeout's timer alone (and a
    // pending promise keeps nothing alive): without this the process could
    // exit silently in the middle of the simulation. Stopped in finally.
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
        await runChecks();
    } finally {
        clearInterval(keepAlive);
    }

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    // Success only after the complete summary.
    process.exitCode = failed.length || results.length === 0 ? 1 : 0;
}

async function runChecks() {
    // ------------------------------------------------------------ simulation
    check("T1. AbortSignal.timeout is available in this runtime", typeof AbortSignal.timeout === "function");

    check("T2. Without a timeout, a request to a server that never answers is still pending after 300 ms (the problem)",
        !(await settlesWithin(neverAnsweringFetch("/api/auth/me"), 300)));

    const started = Date.now();
    let error: unknown = null;
    try {
        await neverAnsweringFetch("/api/auth/me", { signal: AbortSignal.timeout(150) });
    } catch (caught) {
        error = caught;
    }
    const elapsed = Date.now() - started;
    check("T3. With AbortSignal.timeout(150), the same request ends with a rejection (no hang)",
        error !== null && elapsed >= 100 && elapsed < 2_000, `elapsed ${elapsed} ms`);
    check("T4. ...and the rejection is a TimeoutError (thrown, never a fake HTTP answer such as 401)",
        (error as { name?: unknown } | null)?.name === "TimeoutError", String((error as { name?: unknown } | null)?.name));

    const outcome = await postLikeSyncManager(neverAnsweringFetch, 150);
    check("T5. Handled like postJson, a timed-out sync request gives the \"unreachable\" outcome", outcome.kind === "unreachable", outcome.kind);
    const decision = decideAfterOutcome(outcome, 3, new Date());
    check("T6. ...which restores the item without counting an attempt (attempts stay as they were)",
        decision.action === "restore" && decision.stopReason === "unreachable", JSON.stringify(decision));
    check("T7. The cashier-facing text of a timeout is plain (no internal error text)",
        outcome.kind === "unreachable" && !/TimeoutError|abort|DOMException|signal/i.test(outcome.message),
        outcome.kind === "unreachable" ? outcome.message : "");

    // ------------------------------------------------------------ source pins
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const identity = read("lib/offline/sessionIdentity.ts");
    const access = read("lib/offline/offlineAccess.ts");
    const sync = read("lib/offline/SyncManager.ts");
    const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
    const between = (text: string, start: string, end: string) => {
        const from = text.indexOf(start);
        const to = text.indexOf(end, from + start.length);
        return from >= 0 && to > from ? text.slice(from, to) : "";
    };

    // Session check: 5 s.
    check("S1. Session check timeout is 5 seconds", /export const SESSION_CHECK_TIMEOUT_MS = 5_000;/.test(identity));
    const fetchIdentity = between(identity, "export async function fetchSessionIdentity", "export async function rememberSessionIdentity");
    check("S2. The /api/auth/me request in fetchSessionIdentity uses that timeout",
        fetchIdentity.length > 0
        && /fetch\("\/api\/auth\/me", \{[\s\S]*?signal: AbortSignal\.timeout\(SESSION_CHECK_TIMEOUT_MS\),[\s\S]*?\}\);/.test(fetchIdentity));
    check("S3. A timeout is not caught there: it is thrown as \"unreachable\"; only a 401/403 answer ends offline access",
        fetchIdentity.length > 0 && !/catch/.test(fetchIdentity)
        && count(fetchIdentity, /await endOfflineAccess\(\);/g) === 1
        && /if \(isSessionRejected\(response\.status\)\) \{\s*await endOfflineAccess\(\);/.test(fetchIdentity));
    // The last function in the file: from its start to the end of the file.
    const queueingStart = identity.indexOf("export async function getIdentityForQueueing");
    const forQueueing = queueingStart >= 0 ? identity.slice(queueingStart) : "";
    check("S4. Queueing still falls back to the remembered account and the local 72-hour check when the server is unreachable",
        forQueueing.length > 0
        && /catch \(error\) \{[\s\S]*?Please sign in[\s\S]*?\}/.test(forQueueing)
        && /await assertOfflineWorkAllowed\(remembered\);/.test(forQueueing));

    // Pending logout: 5 s.
    check("L1. Pending-logout timeout is 5 seconds", /export const PENDING_LOGOUT_TIMEOUT_MS = 5_000;/.test(access));
    const settle = between(access, "export async function settlePendingServerLogout", "export async function clearPendingServerLogout");
    check("L2. The pending /api/auth/logout request uses that timeout",
        settle.length > 0
        && /fetch\("\/api\/auth\/logout", \{[\s\S]*?signal: AbortSignal\.timeout\(PENDING_LOGOUT_TIMEOUT_MS\),[\s\S]*?\}\);/.test(settle));
    check("L3. The flag is cleared only after a confirmed server logout; a timeout returns \"unreachable\" and keeps it",
        settle.length > 0
        && count(settle, /offlineDB\.meta\.delete\(PENDING_LOGOUT_KEY\)/g) === 1
        && /if \(response\.ok && data\?\.success\) \{\s*await offlineDB\.meta\.delete\(PENDING_LOGOUT_KEY\);\s*return "done";/.test(settle)
        && /catch \{[\s\S]*?\}\s*return "unreachable";/.test(settle));

    // Sync: 20 s.
    check("Y1. Sync request timeout is 20 seconds", /export const SYNC_REQUEST_TIMEOUT_MS = 20_000;/.test(sync));
    const postJson = between(sync, "async function postJson", "async function recoverInterrupted");
    check("Y2. postJson (used for both upload and process) uses that timeout",
        postJson.length > 0 && /signal: AbortSignal\.timeout\(SYNC_REQUEST_TIMEOUT_MS\),/.test(postJson)
        && /postJson\("\/api\/sync-operations",/.test(sync) && /postJson\("\/api\/sync-operations\/process",/.test(sync));
    check("Y3. A timeout in postJson gives unreachableOutcome() (M-3: no attempt counted)",
        /catch \{[\s\S]*?return unreachableOutcome\(\);/.test(postJson));

    // Nothing left without a timeout.
    for (const [file, text] of [
        ["lib/offline/sessionIdentity.ts", identity],
        ["lib/offline/offlineAccess.ts", access],
        ["lib/offline/SyncManager.ts", sync],
    ] as const) {
        const fetches = count(text, /\bfetch\(/g);
        const timed = count(text, /signal: AbortSignal\.timeout\(/g);
        check(`A1. ${file}: every server request has a timeout (${timed}/${fetches})`, fetches > 0 && fetches === timed);
    }
}

// Fail closed: only a completed run with every check passing sets 0.
process.exitCode = 1;

main().catch((error: unknown) => {
    console.error("Request timeout tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
