
/*
 * Sync client: network failures vs. real server failures
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * Exercises the pure queue rules in lib/offline/syncPolicy.ts and reads
 * lib/offline/SyncManager.ts to pin how it uses them. It does NOT run the
 * browser code (fetch, IndexedDB, service worker): that needs the browser
 * test. What it proves is the decision logic and the source wiring:
 *
 *  - no answer from the server ("unreachable") never counts an attempt and
 *    never leads to NEEDS_ATTENTION, however often it happens;
 *  - real server answers (5xx, 404, 409 IN_PROGRESS, 429, 400, 422) still
 *    count attempts with the same backoff and the same 8-attempt limit;
 *  - a wrong/missing session still stops without counting an attempt.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-sync-network-failure.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
    MAX_CLIENT_ATTEMPTS,
    decideAfterOutcome,
    interpretResponse,
    unreachableOutcome,
    type ItemDecision,
    type SyncOutcome,
} from "../lib/offline/syncPolicy";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const now = new Date("2026-01-01T12:00:00.000Z");
const half = () => 0.5; // no jitter: backoff is exactly 15s, 30s, 60s ...
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

/**
 * Replays outcomes against one queue item the way SyncManager.syncOne does:
 * "restore" leaves it exactly as it was, "failed" stores the new state.
 */
function replay(outcomes: SyncOutcome[]) {
    let state = { status: "PENDING" as string, attempts: 0, nextAttemptAt: undefined as string | undefined };
    const decisions: ItemDecision[] = [];
    for (const outcome of outcomes) {
        const decision = decideAfterOutcome(outcome, state.attempts, now, half);
        decisions.push(decision);
        if (decision.action === "synced") state = { ...state, status: "SYNCED" };
        if (decision.action === "failed") {
            state = { status: decision.status, attempts: decision.attempts, nextAttemptAt: decision.nextAttemptAt };
        }
        // "restore": nothing changes.
    }
    return { state, decisions };
}

const unreachable = unreachableOutcome();
const http = (status: number, body: Record<string, unknown> = {}) => interpretResponse(status, body);

// ------------------------------------------------------------ network failures
check("N1. A request with no server answer is classified as \"unreachable\"",
    unreachable.kind === "unreachable", JSON.stringify(unreachable));
check("N2. Its message is plain and reveals nothing about the server",
    unreachable.kind === "unreachable" && !/mongo|http|ECONN|ENOTFOUND|\d+\.\d+\.\d+/i.test(unreachable.message), unreachable.message);
check("N3. \"unreachable\" restores the item and ends the run (stop reason: unreachable)",
    (() => {
        const d = decideAfterOutcome(unreachable, 3, now, half);
        return d.action === "restore" && d.stopReason === "unreachable";
    })());

const manyNetworkFailures = replay(Array.from({ length: 50 }, () => unreachable));
check("N4. 50 network failures in a row: attempts stay 0, status stays PENDING, no next-attempt time is set",
    manyNetworkFailures.state.attempts === 0 && manyNetworkFailures.state.status === "PENDING"
    && manyNetworkFailures.state.nextAttemptAt === undefined,
    JSON.stringify(manyNetworkFailures.state));
check("N5. ...and never NEEDS_ATTENTION or FAILED, even far beyond the 8-attempt limit",
    manyNetworkFailures.decisions.every((d) => d.action === "restore"));
check("N6. An already FAILED item with 7 attempts is not pushed to NEEDS_ATTENTION by a network failure",
    decideAfterOutcome(unreachable, MAX_CLIENT_ATTEMPTS - 1, now, half).action === "restore");

// ------------------------------------------------------------ real server failures (unchanged)
check("R1. The client attempt limit is still 8", MAX_CLIENT_ATTEMPTS === 8, String(MAX_CLIENT_ATTEMPTS));
for (const status of [500, 502, 503, 404, 429]) {
    const d = decideAfterOutcome(http(status), 0, now, half);
    check(`R2. HTTP ${status} from the server still counts an attempt (FAILED, retried after the 15 s backoff)`,
        d.action === "failed" && d.attempts === 1 && d.status === "FAILED" && d.nextAttemptAt === at(15_000),
        JSON.stringify(d));
}
const inProgress = decideAfterOutcome(http(409, { code: "IN_PROGRESS", retryable: true, retryAfterSeconds: 42 }), 0, now, half);
check("R3. 409 IN_PROGRESS still counts an attempt and respects Retry-After (42 s > 15 s backoff)",
    inProgress.action === "failed" && inProgress.attempts === 1 && inProgress.status === "FAILED" && inProgress.nextAttemptAt === at(42_000),
    JSON.stringify(inProgress));
check("R4. Backoff still grows with attempts (2nd attempt -> 30 s, 3rd -> 60 s)",
    (() => {
        const d2 = decideAfterOutcome(http(503), 1, now, half);
        const d3 = decideAfterOutcome(http(503), 2, now, half);
        return d2.action === "failed" && d2.nextAttemptAt === at(30_000) && d3.action === "failed" && d3.nextAttemptAt === at(60_000);
    })());
const eightServerErrors = replay(Array.from({ length: MAX_CLIENT_ATTEMPTS }, () => http(503)));
check("R5. 8 real server errors in a row -> NEEDS_ATTENTION after the 8th (unchanged)",
    eightServerErrors.state.attempts === 8 && eightServerErrors.state.status === "NEEDS_ATTENTION"
    && eightServerErrors.decisions.slice(0, 7).every((d) => d.action === "failed" && d.status === "FAILED"),
    JSON.stringify(eightServerErrors.state));
for (const [status, body] of [[400, { retryable: false }], [422, { retryable: false }], [409, { code: "OPERATION_ID_CONFLICT", retryable: false }]] as const) {
    const d = decideAfterOutcome(http(status, body), 0, now, half);
    check(`R6. Permanent server answer (HTTP ${status}${"code" in body ? ` ${body.code}` : ""}) -> NEEDS_ATTENTION at once (unchanged)`,
        d.action === "failed" && d.attempts === 1 && d.status === "NEEDS_ATTENTION", JSON.stringify(d));
}
const mixed = replay([unreachable, unreachable, unreachable, http(503), unreachable, unreachable]);
check("R7. Mixed: network failures add nothing; only the one real 503 is counted (attempts 1, FAILED)",
    mixed.state.attempts === 1 && mixed.state.status === "FAILED", JSON.stringify(mixed.state));
const failedDecision = decideAfterOutcome(http(503, { message: "Temporary problem while syncing; it will be retried" }), 0, now, half);
check("R8. The server's message is kept for the stored error text",
    failedDecision.action === "failed" && failedDecision.message === "Temporary problem while syncing; it will be retried");

// ------------------------------------------------------------ session stop and success (unchanged)
for (const [label, outcome] of [
    ["HTTP 401", http(401)],
    ["403 OWNER_MISMATCH", http(403, { code: "OWNER_MISMATCH" })],
    ["403 ORIGIN_REFUSED", http(403, { code: "ORIGIN_REFUSED" })],
] as const) {
    const d = decideAfterOutcome(outcome, 2, now, half);
    check(`S1. ${label} still restores the item without counting an attempt (stop reason: session)`,
        d.action === "restore" && d.stopReason === "session", JSON.stringify(d));
}
check("S2. A 2xx success is still SYNCED", decideAfterOutcome(http(200, { success: true }), 0, now, half).action === "synced");
check("S3. No HTTP status is ever classified as \"unreachable\" (only a missing answer is)",
    Array.from({ length: 500 }, (_, i) => i + 100).every((status) => interpretResponse(status, {}).kind !== "unreachable"));

// ------------------------------------------------------------ SyncManager wiring (source pins)
const sync = readFileSync(path.join(process.cwd(), "lib/offline/SyncManager.ts"), "utf8");
const catchBlock = sync.slice(sync.indexOf("async function postJson"), sync.indexOf("async function recoverInterrupted"));
check("W1. postJson returns unreachableOutcome() when the request fails with no answer",
    /catch\s*\{[\s\S]*return unreachableOutcome\(\);/.test(catchBlock) && !/kind:\s*"retryable",\s*message:\s*"Network error/.test(sync));
check("W2. syncOne decides through decideAfterOutcome (the logic tested above)",
    /const decision = decideAfterOutcome\(outcome, item\.attempts, new Date\(\)\);/.test(sync));
const restoreBlock = sync.slice(sync.indexOf('decision.action === "restore"'), sync.indexOf("await markAttemptFailed"));
check("W3. The restore branch puts the item back as it was and never calls markAttemptFailed or markSynced",
    restoreBlock.length > 0
    && /releaseItem\(id, item\.status === "FAILED" \? "FAILED" : "PENDING", \{ lastAttemptAt: item\.lastAttemptAt \}\)/.test(restoreBlock)
    && !restoreBlock.includes("markAttemptFailed(") && !restoreBlock.includes("markSynced("));
check("W4. An unreachable server ends the run with its own reason",
    /result === "UNREACHABLE"/.test(sync) && /reason: "server unreachable during sync"/.test(sync));
check("W5. Ownership check, Web Locks and interrupted-item recovery are still in place",
    /if \(!isOwnedBy\(item, identity\)\) continue;/.test(sync)
    && /navigator\.locks\.request\(SYNC_LOCK_NAME, \{ ifAvailable: true \}/.test(sync)
    && /await recoverInterrupted\(identity, holdsExclusiveLock\);/.test(sync));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
