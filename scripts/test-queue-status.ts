
/*
 * Queue status shown to the cashier (M-5)
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * 1. The pure rules in lib/offline/queueStatus.ts: every local state maps to
 *    a plain label, counts are accurate, "nothing sent" is never reported as
 *    "nothing waiting", and failure reasons are made safe to show.
 * 2. Source pins: the dashboard, the Sync now button and the offline test
 *    page use these rules, show only the signed-in account's items, keep the
 *    texts other tests depend on, and never change queue items.
 *
 * This does NOT prove what a real browser renders; that needs the browser
 * test.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-queue-status.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
    CATEGORY_LABELS,
    INTERNAL_REASON_TEXT,
    categorize,
    describeAfterRun,
    describeRunReason,
    describeUnsynced,
    safeReason,
    summarizeQueue,
} from "../lib/offline/queueStatus";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

// ------------------------------------------------------------ mapping
const label = (status: string) => CATEGORY_LABELS[categorize(status)];
check("Q1. Every local state has its own plain label",
    label("PENDING") === "Waiting to send" && label("SYNCING") === "Sending" && label("FAILED") === "Will retry"
    && label("NEEDS_ATTENTION") === "Needs attention" && label("SYNCED") === "Sent to server",
    ["PENDING", "SYNCING", "FAILED", "NEEDS_ATTENTION", "SYNCED"].map(label).join(" / "));
check("Q2. An unknown status is shown as needing attention (never hidden, never \"sent\")",
    categorize("SOMETHING_NEW") === "attention" && categorize("") === "attention");
check("Q3. Only SYNCED is ever labelled as sent to the server",
    ["PENDING", "SYNCING", "FAILED", "NEEDS_ATTENTION", "X"].every((s) => categorize(s) !== "synced") && categorize("SYNCED") === "synced");

// ------------------------------------------------------------ counts
const items = ["PENDING", "PENDING", "SYNCING", "FAILED", "NEEDS_ATTENTION", "NEEDS_ATTENTION", "SYNCED", "SYNCED", "SYNCED"]
    .map((status) => ({ status }));
const summary = summarizeQueue(items);
check("C1. Counts per state are exact",
    summary.waiting === 2 && summary.sending === 1 && summary.retry === 1 && summary.attention === 2 && summary.synced === 3,
    JSON.stringify(summary));
check("C2. \"Unsynced\" counts everything not confirmed by the server (here 6 of 9)", summary.unsynced === 6, String(summary.unsynced));
check("C3. The breakdown names each unsynced group",
    describeUnsynced(summary) === "2 waiting to send, 1 sending, 1 will retry later, 2 need attention", describeUnsynced(summary));
check("C4. Singular wording for one item needing attention",
    describeUnsynced(summarizeQueue([{ status: "NEEDS_ATTENTION" }])) === "1 needs attention");
check("C5. Nothing unsynced gives an empty breakdown", describeUnsynced(summarizeQueue([{ status: "SYNCED" }])) === "");

// ------------------------------------------------------------ after a sync run
const onlyWaitingForRetry = summarizeQueue([{ status: "FAILED" }, { status: "NEEDS_ATTENTION" }]);
const afterText = describeAfterRun(onlyWaitingForRetry);
check("A1. When nothing was sent but items remain, the message says what is still on the device",
    afterText.includes("Still on this device") && afterText.includes("1 will retry later") && afterText.includes("1 needs attention"), afterText);
check("A2. Items needing attention come with advice that they are not retried automatically",
    afterText.includes("not retried automatically"), afterText);
check("A3. An empty queue after the run says nothing is left",
    describeAfterRun(summarizeQueue([{ status: "SYNCED" }])) === "Nothing is left waiting for this account.");
check("A4. A run that stopped because the server became unreachable says so",
    describeAfterRun(summarizeQueue([{ status: "PENDING" }]), "server unreachable during sync").includes("connection was lost"));
check("A5. Network trouble is explained separately from data problems",
    describeRunReason("offline").includes("offline") && describeRunReason("server unreachable").includes("could not be reached")
    && !describeRunReason("offline").includes("attention"));
check("A6. Every reason the sync manager can give has a plain explanation",
    ["offline", "server unreachable", "not signed in", "another tab is syncing", "server unreachable during sync", "session changed or ended during sync"]
        .every((reason) => describeRunReason(reason).length > 0));

// ------------------------------------------------------------ safe reasons
check("R1. A readable business reason is shown unchanged",
    safeReason("Insufficient stock for product Widget") === "Insufficient stock for product Widget");
check("R2. Raw database text stored by an older version is replaced",
    safeReason("E11000 duplicate key error collection: fakedb.sales index: x dup key: { a: 1 }") === INTERNAL_REASON_TEXT
    && safeReason("failed to connect to mongodb+srv://fake:fake@fake.invalid/db") === INTERNAL_REASON_TEXT);
check("R3. Missing or blank reasons show nothing", safeReason(undefined) === undefined && safeReason(null) === undefined && safeReason("   ") === undefined);
check("R4. Very long reasons are shortened", (safeReason("x".repeat(1000)) ?? "").length === 303);

// ------------------------------------------------------------ source pins
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const status = read("lib/offline/queueStatus.ts");
const manager = read("lib/offline/SyncManager.ts");
const access = read("lib/offline/offlineAccess.ts");
const button = read("components/offline/SyncNowButton.tsx");
const dashboard = read("app/dashboard/page.tsx");
const demo = read("app/offline-test/page.tsx");

check("P1. queueStatus.ts is read-only (no storage access, no queue changes)",
    !/offlineDB|indexedDB|Dexie|\.update\(|\.delete\(|\.put\(|\.add\(|markSynced|markAttemptFailed|releaseItem/.test(status));
check("P2. The sync manager reports this account's remaining items only (owner filter)",
    /async function remainingFor\(identity: SessionIdentity\)/.test(manager)
    && /summarizeQueue\(items\.filter\(\(item\) => isOwnedBy\(item, identity\)\)\)/.test(manager)
    && (manager.match(/remaining: await remainingFor\(identity\)/g) ?? []).length === 3);
check("P3. The dashboard summary counts only this account's items (tenant + user + device)",
    /where\("ownerUserId"\)\.equals\(identity\.userId\)/.test(access)
    && /item\.owner\?\.tenantId === identity\.tenantId &&\s*item\.owner\?\.deviceId === identity\.deviceId/.test(access));
check("P4. Sync now no longer says \"No waiting operations\" while items remain",
    /outcome\.remaining && outcome\.remaining\.unsynced > 0\s*\?\s*`Nothing was due to send right now\./.test(button));
check("P5. Sync now keeps \"X of Y operation(s) sent\" and \"Sync skipped:\"",
    /operation\(s\) sent\./.test(button) && /`Sync skipped: \$\{outcome\.reason\}\./.test(button));
check("P6. The offline test page keeps the texts the browser test waits for",
    demo.includes("No pending operations to sync.") && demo.includes("`Sync skipped: ${results.reason}.")
    && demo.includes("Sync completed. ") && demo.includes("Queued operations for this account: ")
    && demo.includes("Operation added successfully") && demo.includes("Failed to add offline operation."));
check("P7. ...and reports remaining items instead of \"No pending operations\" when some are waiting",
    /results\.remaining && results\.remaining\.unsynced > 0\s*\?\s*`No pending operations were due to send now\./.test(demo));
const afterMessage = demo.slice(demo.indexOf("{message}"));
check("P8. The list shows sanitized reasons and adds no paragraph after the message",
    /safeReason\(item\.errorMessage\)/.test(demo) && afterMessage.length > 0 && !/<p[\s>]/.test(afterMessage));
check("P9. The list shows only the signed-in account's items (getQueueItemsForOwner)",
    /await getQueueItemsForOwner\(identity\)/.test(demo) && /setQueueItems\(/.test(demo) && !/syncQueue\.toArray\(\)/.test(demo));
check("P10. The dashboard keeps its existing wording and adds the breakdown",
    /unsynced item\$\{count === 1 \? "" : "s"\}/.test(dashboard) && dashboard.includes("are safe on this device")
    && (dashboard.match(/breakdownText\(overview\.queue\)/g) ?? []).length === 2);

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
