
/*
 * Storage durability and "not saved" messages (M-18)
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * 1. lib/offline/storageDurability.ts with fake storage objects and fake
 *    errors: persistent storage is requested safely (feature detection, a
 *    refusal is reported, never assumed), and a failed queue write always
 *    says the sale was NOT saved, with a specific message for a full disk.
 * 2. Source pins: success is shown only after the queue write resolved,
 *    and nothing clears or deletes stored data.
 *
 * This does NOT prove what a real browser grants or how IndexedDB fails;
 * that needs the browser test.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-storage-durability.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
    describeQueueWriteError,
    isQuotaError,
    persistenceText,
    requestPersistentStorage,
} from "../lib/offline/storageDurability";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

async function main() {
    // ------------------------------------------------------------ persistence
    let persistCalls = 0;
    const already = { persisted: async () => true, persist: async () => { persistCalls++; return true; } };
    check("P1. Already persistent: reported, and no second request", (await requestPersistentStorage(already)) === "persisted" && persistCalls === 0);
    check("P2. Granted on request -> persisted",
        (await requestPersistentStorage({ persisted: async () => false, persist: async () => true })) === "persisted");
    check("P3. Refused by the browser -> reported as not granted (never assumed)",
        (await requestPersistentStorage({ persisted: async () => false, persist: async () => false })) === "not-granted");
    check("P4. No storage API -> unsupported, without throwing",
        (await requestPersistentStorage(undefined)) === "unsupported" && (await requestPersistentStorage({})) === "unsupported");
    check("P5. A throwing storage API -> unsupported, without throwing",
        (await requestPersistentStorage({ persisted: async () => { throw new Error("boom"); }, persist: async () => true })) === "unsupported");
    check("P6. The refused/unsupported texts warn that waiting operations could be lost and to sync",
        /may delete data/.test(persistenceText("not-granted")) && /Sync regularly/.test(persistenceText("not-granted"))
        && /sync waiting operations regularly/.test(persistenceText("unsupported")));

    // ------------------------------------------------------------ "not saved" messages
    const quota = Object.assign(new Error("QuotaExceededError: The quota has been exceeded."), { name: "QuotaExceededError" });
    const dexieWrapped = Object.assign(new Error("Transaction aborted (internal detail)"), {
        name: "AbortError",
        inner: { name: "QuotaExceededError", message: "quota" },
    });
    check("Q1. A full disk is recognised, also when Dexie wraps it", isQuotaError(quota) && isQuotaError(dexieWrapped) && !isQuotaError(new Error("x")));
    check("Q2. A full disk says the sale was NOT saved and that storage is full",
        /NOT saved/.test(describeQueueWriteError(quota)) && /storage is full/.test(describeQueueWriteError(dexieWrapped)));
    const refusals = [
        "Please sign in online at least once before working offline",
        "The offline session has expired; sign in online to continue",
        "This account is not allowed to record sales offline",
    ];
    check("Q3. The queue's own plain refusals are shown, prefixed with NOT saved",
        refusals.every((text) => describeQueueWriteError(new Error(text)) === `The sale was NOT saved: ${text}`));
    const internal = describeQueueWriteError(Object.assign(new Error("DatabaseClosedError: Database has been closed (internal stack at db.ts:12)"), { name: "DatabaseClosedError" }));
    check("Q4. Any other failure says NOT saved without internal detail",
        /NOT saved/.test(internal) && !/DatabaseClosed|internal stack|db\.ts/.test(internal), internal);
    check("Q5. Non-Error values also say NOT saved", [null, undefined, "x", 42].every((v) => /NOT saved/.test(describeQueueWriteError(v))));

    // ------------------------------------------------------------ source pins
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const durability = read("lib/offline/storageDurability.ts");
    const demo = read("app/offline-test/page.tsx");
    const dashboard = read("app/dashboard/page.tsx");
    const queueService = read("lib/offline/SyncQueueService.ts");

    check("S1. storageDurability.ts never deletes or clears data",
        !/\.clear\(|\.delete\(|deleteDatabase|caches\.|localStorage|indexedDB/.test(durability));
    const add = demo.slice(demo.indexOf("async function addTestOperation"), demo.indexOf("async function checkQueue"));
    check("S2. The test page shows success only after the queue write resolved, and NOT saved otherwise",
        /const result =\s*await addToSyncQueue\(/.test(add)
        && add.indexOf("await addToSyncQueue(") < add.indexOf("Operation added successfully")
        && /`Failed to add offline operation\. \$\{describeQueueWriteError\(error\)\}`/.test(add));
    check("S3. The queue write is one IndexedDB add (atomic) and its id is returned only after it resolved",
        /const id = await offlineDB\.syncQueue\.add\(queueItem\);/.test(queueService));
    check("S4. The dashboard requests persistent storage with feature detection and shows the result",
        /requestPersistentStorage\(typeof navigator !== "undefined" \? navigator\.storage : undefined\)/.test(dashboard)
        && /persistenceText\(persistence\)/.test(dashboard));

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

process.exitCode = 1;
main().catch((error: unknown) => {
    console.error("Storage durability tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
