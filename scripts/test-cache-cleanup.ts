
/*
 * Logout cache cleanup tests (NO DATABASE, NO BROWSER, NO NETWORK).
 *
 * Exercises lib/offline/cacheCleanup.ts with a fake cache storage.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-cache-cleanup.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { LOGOUT_CLEARED_CACHES, clearRuntimeCaches, type CacheDeleter } from "../lib/offline/cacheCleanup";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function fakeCaches(names: string[], failing: string[] = []) {
    const existing = new Set(names);
    const asked: string[] = [];
    const storage: CacheDeleter = {
        delete: async (name) => {
            asked.push(name);
            if (failing.includes(name)) throw new Error("boom");
            return existing.delete(name);
        },
    };
    return { storage, existing, asked };
}

async function main() {
    const PRECACHE = "workbox-precache-v2-https://example.test/";
    const everything = [
        ...LOGOUT_CLEARED_CACHES,
        PRECACHE,
        "next-static-js-assets",
        "static-image-assets",
        "static-style-assets",
        "static-font-assets",
        "apis",
        "cross-origin",
    ];

    check("L1. Exactly the identified runtime page/data caches are listed",
        JSON.stringify([...LOGOUT_CLEARED_CACHES].sort()) ===
        JSON.stringify(["next-data", "pages", "pages-rsc", "pages-rsc-prefetch", "start-url"]));
    check("L2. The precache and static asset caches are not in the list",
        !LOGOUT_CLEARED_CACHES.some((name) => name.includes("precache") || name.startsWith("static-") || name.startsWith("next-static")));

    const a = fakeCaches(everything);
    const removed = await clearRuntimeCaches(a.storage);
    check("C1. Every listed cache that existed is removed and reported",
        JSON.stringify([...removed].sort()) === JSON.stringify([...LOGOUT_CLEARED_CACHES].sort()), removed.join(","));
    check("C2. The offline app shell (precache) and static asset caches are untouched",
        a.existing.has(PRECACHE) && a.existing.has("next-static-js-assets") && a.existing.has("static-image-assets")
        && a.existing.has("static-style-assets") && a.existing.has("static-font-assets"));
    check("C3. Caches not in the list are untouched", a.existing.has("apis") && a.existing.has("cross-origin"));
    check("C4. Only the listed names were ever asked to be deleted (no wildcard cleanup)",
        a.asked.length === LOGOUT_CLEARED_CACHES.length && a.asked.every((name) => (LOGOUT_CLEARED_CACHES as readonly string[]).includes(name)));

    const b = fakeCaches([PRECACHE, "pages"]);
    check("C5. Caches that do not exist are simply skipped", JSON.stringify(await clearRuntimeCaches(b.storage)) === JSON.stringify(["pages"]));

    const c = fakeCaches(everything, ["pages-rsc"]);
    const partial = await clearRuntimeCaches(c.storage);
    check("C6. A failing delete does not stop the others and never throws",
        !partial.includes("pages-rsc") && partial.includes("pages") && partial.includes("start-url") && c.existing.has(PRECACHE));

    check("C7. Without cache storage nothing happens", (await clearRuntimeCaches(undefined)).length === 0 && (await clearRuntimeCaches(null)).length === 0);
    check("C8. Running it twice is harmless", (await clearRuntimeCaches(a.storage)).length === 0 && a.existing.has(PRECACHE));

    // The helper must not touch the offline queue or list caches.
    const source = readFileSync(path.join(process.cwd(), "lib/offline/cacheCleanup.ts"), "utf8");
    check("S1. The helper never lists caches and never touches IndexedDB",
        !/\.keys\(/.test(source) && !/indexedDB|syncQueue|deleteDatabase|Dexie/.test(source));

    const identity = readFileSync(path.join(process.cwd(), "lib/offline/sessionIdentity.ts"), "utf8");
    const access = readFileSync(path.join(process.cwd(), "lib/offline/offlineAccess.ts"), "utf8");
    check("S2. Logout/revocation (endOfflineAccess) and offline sign-out call the helper",
        /clearRuntimeCaches\(/.test(identity) && /clearRuntimeCaches\(/.test(access));
    check("S3. Neither cleanup path deletes or clears queue items",
        !/syncQueue\.(clear|delete|bulkDelete)/.test(identity) && !/syncQueue\.(clear|delete|bulkDelete)/.test(access));

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((error: unknown) => {
    console.error("Cache cleanup tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
