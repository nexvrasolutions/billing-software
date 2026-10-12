
/*
 * Browser test for the client side of offline sync (Dexie queue, identity,
 * account switching, crash recovery, offline queueing, service worker).
 *
 * Uses the real /login, /offline-test and /account pages in headless
 * Chrome/Edge against a locally running production build, with a temporary
 * tenant that is removed afterwards. The /offline-test demo sale refers to
 * products of another business, so syncing it is expected to fail
 * permanently (NEEDS_ATTENTION) - which is also part of the test.
 *
 * 1. npm run build && npx next start -p 3130
 * 2. ALLOW_BROWSER_TESTS=YES BASE_URL=http://localhost:3130 npx tsx scripts/test-offline-sync-browser.ts
 */

import { loadEnvConfig } from "@next/env";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

import { Page, findBrowser, sleep } from "./lib/cdpBrowser";
import { runTestSafely } from "./lib/testRunSafety";

loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    return failed.length === 0;
}

interface LocalItem {
    id: number;
    operationId: string;
    status: string;
    legacyUnowned?: boolean;
    owner?: { tenantId: string; userId: string; deviceId: string };
}

// Raw IndexedDB access from the page (independent of the app's Dexie code).
const idbRequest = (body: string) => `new Promise((resolve, reject) => {
    const open = indexedDB.open("billing_offline_db");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
        const db = open.result;
        try { ${body} } catch (error) { db.close(); reject(error); }
    };
})`;
const READ_QUEUE = idbRequest(`
    if (!db.objectStoreNames.contains("syncQueue")) { db.close(); resolve([]); return; }
    const req = db.transaction("syncQueue", "readonly").objectStore("syncQueue").getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
`);
const READ_IDENTITY = idbRequest(`
    if (!db.objectStoreNames.contains("meta")) { db.close(); resolve(null); return; }
    const req = db.transaction("meta", "readonly").objectStore("meta").get("lastSessionIdentity");
    req.onsuccess = () => { db.close(); resolve(req.result ? req.result.value : null); };
    req.onerror = () => { db.close(); reject(req.error); };
`);

async function main() {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_BROWSER_TESTS !== "YES") {
        throw new Error("Set ALLOW_BROWSER_TESTS=YES after confirming MONGODB_URI is a development database.");
    }

    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Device } = await import("../lib/models/Device");
    const { Sale } = await import("../lib/models/Sale");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { hashPassword } = await import("../app/api/auth/password");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");

    await runTestSafely({
        name: "Offline sync browser tests",
        tenantNamePrefix: "SYNCB-TEST-",
        overallTimeoutMs: 300_000,
        summarize,
        run: async (run) => {
            await connectDB();
            const suffix = run.runId;

            const tenantId = run.newTenantId();
            await Tenant.create({ _id: tenantId, name: run.tenantName("A"), status: "active" });

            async function makeUser(label: string) {
                const email = `${label}-${suffix}@example.invalid`;
                const password = `Sync-${label}-${suffix}-Pw1!`;
                run.addRateLimitKeys(getLoginBuckets({ ip: null, email }).map((b) => b.key));
                const user = await User.create({ tenantId, name: `Sync ${label}`, email, passwordHash: await hashPassword(password), status: "active" });
                const device = await Device.create({
                    tenantId, userId: user._id, deviceName: `${label} browser`, deviceType: "desktop",
                    deviceId: `syncb-${label}-${suffix}`, status: "active",
                });
                return {
                    email, password, deviceCode: device.deviceId,
                    identity: { tenantId: tenantId.toString(), userId: user._id.toString(), deviceId: device._id.toString() },
                };
            }

            const alice = await makeUser("alice");
            const bob = await makeUser("bob");

            const userDataDir = mkdtempSync(path.join(os.tmpdir(), "browser-e2e-"));
            const port = 9300 + Math.floor(Math.random() * 500);
            const browser = spawn(findBrowser(), [
                "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
                "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
            ], { stdio: "ignore" });
            let page: Page | null = null;
            run.onCleanup("close browser", async () => {
                page?.close();
                browser.kill();
                await sleep(500);
                rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            });

            page = await Page.connect(port);
            const p = page;
            const queue = () => p.eval<LocalItem[]>(READ_QUEUE);
            const findItem = async (operationId: string) => (await queue()).find((i) => i.operationId === operationId);
            const sameIdentity = (a: unknown, b: { tenantId: string; userId: string; deviceId: string }) =>
                JSON.stringify(a) === JSON.stringify(b);

            async function login(user: typeof alice) {
                await p.goto("/login");
                await p.fill(`document.querySelector('input[type=email]')`, user.email);
                await p.fill(`document.querySelector('input[type=password]')`, user.password);
                await p.fill(`document.querySelector('input[type=text]')`, user.deviceCode);
                await p.clickButton("Login");
                return p.waitForText("Login successful.");
            }
            async function logout() {
                await p.goto("/account");
                await p.waitForText("Signed in as");
                await p.clickButton("Log out");
                return p.waitForText("You are signed out.");
            }
            async function syncFromDemoPage() {
                await p.goto("/offline-test");
                await p.waitForText("Network Status");
                await p.eval(`(() => { const m = [...document.querySelectorAll("p")].pop(); if (m) m.textContent = ""; })()`);
                await p.clickButton("Sync Operations");
                await p.waitFor(`/Sync completed|No pending operations|Sync skipped|Automatic sync failed/.test(document.body.innerText)`, 30_000);
                return p.text();
            }

            // ----------------------------- legacy v1 queue item (pre-ownership)
            await p.goto("/login");
            const legacyOperationId = `legacy-${suffix}`;
            await p.eval(`new Promise((resolve, reject) => {
                const open = indexedDB.open("billing_offline_db", 10); // Dexie version 1
                open.onupgradeneeded = () => {
                    const store = open.result.createObjectStore("syncQueue", { keyPath: "id", autoIncrement: true });
                    ["operationId", "status", "localSeq", "createdAt"].forEach((name) => store.createIndex(name, name));
                };
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction("syncQueue", "readwrite");
                    tx.objectStore("syncQueue").add({ operationId: ${JSON.stringify(legacyOperationId)}, operationType: "CREATE",
                        entityType: "Sale", payload: {}, status: "PENDING", localSeq: 1, attempts: 0, createdAt: new Date().toISOString() });
                    tx.oncomplete = () => { db.close(); resolve(true); };
                    tx.onerror = () => { db.close(); reject(tx.error); };
                };
            })`);

            check("B1. Alice logs in", await login(alice));
            const legacy = await findItem(legacyOperationId);
            check("B1. Legacy item without an owner is kept but locked (NEEDS_ATTENTION, legacyUnowned)",
                legacy?.status === "NEEDS_ATTENTION" && legacy?.legacyUnowned === true, JSON.stringify(legacy));
            check("B1. Login remembers the server-confirmed identity", sameIdentity(await p.eval(READ_IDENTITY), alice.identity));

            // ----------------------------- queue an item as Alice
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            await p.clickButton("Add Offline Test Sale");
            check("B2. Alice queues an operation", await p.waitForText("Operation added successfully"));
            const aliceItems = (await queue()).filter((i) => i.operationId !== legacyOperationId);
            const aliceItem = aliceItems[0];
            check("B2. Queued item is owned by Alice's tenant, user and device",
                aliceItems.length === 1 && sameIdentity(aliceItem.owner, alice.identity), JSON.stringify(aliceItem?.owner));
            check("B2. Operation ID is a random v4 UUID",
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(aliceItem?.operationId ?? ""));

            // Simulate a tab that crashed in the middle of syncing Alice's item.
            await p.eval(idbRequest(`
                const store = db.transaction("syncQueue", "readwrite").objectStore("syncQueue");
                const get = store.get(${aliceItem.id});
                get.onsuccess = () => {
                    const item = get.result; item.status = "SYNCING"; item.syncingSince = new Date().toISOString();
                    const put = store.put(item);
                    put.onsuccess = () => { db.close(); resolve(true); };
                };
            `));

            // ----------------------------- switch account to Bob
            check("B3. Alice logs out", await logout());
            check("B3. Logout forgets the remembered identity", (await p.eval(READ_IDENTITY)) === null);
            check("B4. Bob logs in on the same browser", await login(bob));
            const bobSync = await syncFromDemoPage();
            check("B4. Bob's sync finds nothing of his own", bobSync.includes("No pending operations to sync."), bobSync.slice(-200));
            check("B4. Alice's item was NOT uploaded under Bob's session",
                (await SyncOperation.countDocuments({ tenantId, operationId: aliceItem.operationId })) === 0);
            check("B4. Alice's interrupted item is untouched by Bob's sync (still SYNCING, owner Alice)",
                (await findItem(aliceItem.operationId))?.status === "SYNCING");
            await p.clickButton("Check Queue");
            check("B4. Bob's queue view shows none of Alice's items", await p.waitForText("Queued operations for this account: 0"));

            // ----------------------------- back to Alice: recovery + upload
            check("B5. Bob logs out and Alice logs back in", (await logout()) && (await login(alice)));
            const aliceSync = await syncFromDemoPage();
            const serverOp = await SyncOperation.findOne({ tenantId, operationId: aliceItem.operationId }).lean();
            check("B5. Alice's interrupted item is recovered and uploaded under Alice's own identity",
                Boolean(serverOp) && serverOp!.userId?.toString() === alice.identity.userId && serverOp!.deviceId.toString() === alice.identity.deviceId,
                aliceSync.slice(-200));
            check("B5. The demo sale fails permanently on the server (foreign product) -> NEEDS_ATTENTION, no sale",
                serverOp?.status === "NEEDS_ATTENTION" && serverOp?.failureKind === "PERMANENT" && (await Sale.countDocuments({ tenantId })) === 0);
            check("B5. Locally it is NEEDS_ATTENTION (not retried forever)", (await findItem(aliceItem.operationId))?.status === "NEEDS_ATTENTION");
            const attemptsAfter = serverOp?.attempts;
            await syncFromDemoPage();
            check("B5. A further sync does not retry the permanent failure",
                (await SyncOperation.findOne({ tenantId, operationId: aliceItem.operationId }).lean())?.attempts === attemptsAfter);
            check("B5. The legacy item was never uploaded",
                (await SyncOperation.countDocuments({ operationId: legacyOperationId })) === 0 && (await findItem(legacyOperationId))?.status === "NEEDS_ATTENTION");

            // ----------------------------- queue while offline
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            await p.send("Network.enable");
            await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await p.waitForText("OFFLINE");
            await p.clickButton("Add Offline Test Sale");
            check("B6. Queueing works while offline", await p.waitForText("Operation added successfully"));
            const offlineItem = (await queue()).find((i) => i.operationId !== legacyOperationId && i.operationId !== aliceItem.operationId);
            check("B6. The offline item is owned by Alice (remembered identity)", sameIdentity(offlineItem?.owner, alice.identity), JSON.stringify(offlineItem?.owner));
            await p.clickButton("Sync Operations");
            check("B6. Sync is skipped while offline", await p.waitForText("Sync skipped: offline."));
            await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await p.waitForText("ONLINE");
            await syncFromDemoPage();
            const offlineServerOp = await SyncOperation.findOne({ tenantId, operationId: offlineItem?.operationId }).lean();
            check("B6. Back online, the offline item is uploaded as Alice", offlineServerOp?.userId?.toString() === alice.identity.userId);

            // ----------------------------- service worker: no private API cache
            await p.goto("/account");
            await p.waitForText("Signed in as");
            const swReady = await p.waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller !== null`, 20_000)
                || (await p.goto("/account"), await p.waitFor(`navigator.serviceWorker.controller !== null`, 20_000));
            check("B7. The service worker is active", swReady);
            const cachesAfterApiUse = await p.eval<string[]>(`caches.keys()`);
            check("B7. Authenticated API responses are not cached (no apis cache)", !cachesAfterApiUse.includes("apis"), cachesAfterApiUse.join(","));
            await p.eval(`caches.open("apis").then((c) => c.put("/api/fake-private", new Response("private")))`);
            await p.eval(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())))`);
            await p.goto("/account");
            const oldCacheRemoved = await p.waitFor(`caches.has("apis").then((has) => !has)`, 20_000);
            check("B7. A newly activated service worker deletes an old apis cache", oldCacheRemoved);
        },
    });
}

main().catch((error: unknown) => {
    console.error("Offline sync browser tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
