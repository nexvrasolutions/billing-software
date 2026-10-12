
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
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import { BASE_URL, Page, findBrowser, sleep } from "./lib/cdpBrowser";
import { runTestSafely } from "./lib/testRunSafety";
import { ensureTestPermissions } from "./lib/testPermissions";

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

const READ_OFFLINE_SESSIONS = idbRequest(`
    if (!db.objectStoreNames.contains("offlineSessions")) { db.close(); resolve([]); return; }
    const req = db.transaction("offlineSessions", "readonly").objectStore("offlineSessions").getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
`);
const READ_PENDING_LOGOUT = idbRequest(`
    if (!db.objectStoreNames.contains("meta")) { db.close(); resolve(false); return; }
    const req = db.transaction("meta", "readonly").objectStore("meta").get("pendingServerLogout");
    req.onsuccess = () => { db.close(); resolve(Boolean(req.result && req.result.value)); };
    req.onerror = () => { db.close(); reject(req.error); };
`);
/** Move an offline session's 24-hour window into the past (expired an hour ago), consistently. */
const AGE_OFFLINE_SESSION = (key: string) => idbRequest(`
    const tx = db.transaction("offlineSessions", "readwrite");
    const store = tx.objectStore("offlineSessions");
    const req = store.get(${JSON.stringify(key)});
    req.onsuccess = () => {
        const record = req.result;
        if (!record) { db.close(); resolve(false); return; }
        const now = Date.now();
        record.lastOnlineCheckAt = new Date(now - 25 * 3600 * 1000).toISOString();
        record.expiresAt = new Date(now - 1 * 3600 * 1000).toISOString();
        store.put(record);
        tx.oncomplete = () => { db.close(); resolve(true); };
    };
    req.onerror = () => { db.close(); reject(req.error); };
`);

/**
 * Pass-through HTTP proxy for the browser. While "offline", every
 * connection is refused, so the page AND its service worker lose the
 * network (page-level emulation alone does not reach the service worker).
 * Only requests to the app under test are forwarded.
 */
async function startOfflineSwitchProxy() {
    const target = new URL(BASE_URL);
    const state = { offline: false };
    const server = http.createServer((req, res) => {
        if (state.offline) {
            req.socket.destroy();
            return;
        }
        let url: URL;
        try {
            url = new URL(req.url ?? "");
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (url.host !== target.host) {
            res.writeHead(403).end();
            return;
        }
        const upstream = http.request(
            { hostname: target.hostname, port: target.port, method: req.method, path: url.pathname + url.search, headers: req.headers },
            (response) => {
                res.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(res);
            }
        );
        upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
        req.pipe(upstream);
    });
    // No HTTPS tunnelling: only the local app is used.
    server.on("connect", (_req, socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        state,
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}

async function main() {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_BROWSER_TESTS !== "YES") {
        throw new Error("Set ALLOW_BROWSER_TESTS=YES after confirming MONGODB_URI is a development database.");
    }

    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Device } = await import("../lib/models/Device");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Sale } = await import("../lib/models/Sale");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { Session } = await import("../lib/models/Session");
    const { Types } = (await import("mongoose")).default;
    const { hashPassword } = await import("../app/api/auth/password");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");

    await runTestSafely({
        name: "Offline sync browser tests",
        tenantNamePrefix: "SYNCB-TEST-",
        overallTimeoutMs: 540_000,
        summarize,
        run: async (run) => {
            await connectDB();
            const suffix = run.runId;

            const tenantId = run.newTenantId();
            await Tenant.create({ _id: tenantId, name: run.tenantName("A"), status: "active" });

            // Processing a queued sale requires sales.create (role at processing time).
            const salesCreateId = (await ensureTestPermissions(run, Permission, ["sales.create"])).get("sales.create")!;
            const sellerRole = await Role.create({ tenantId, name: `Seller ${suffix}`, permissions: [salesCreateId], status: "active" });

            async function makeUser(label: string, extra: { mustChangePassword?: boolean } = {}) {
                const email = `${label}-${suffix}@example.invalid`;
                const password = `Sync-${label}-${suffix}-Pw1!`;
                run.addRateLimitKeys(getLoginBuckets({ ip: null, email }).map((b) => b.key));
                const user = await User.create({
                    tenantId, name: `Sync ${label}`, email, passwordHash: await hashPassword(password), status: "active",
                    roleId: sellerRole._id, ...extra,
                });
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
            // Temporary password set by an administrator (must change it first).
            const carol = await makeUser("carol", { mustChangePassword: true });

            // All browser traffic to the app goes through this proxy so the
            // tests can cut the network for the page and its service worker.
            const proxy = await startOfflineSwitchProxy();
            run.onCleanup("close offline-switch proxy", () => proxy.close());

            const userDataDir = mkdtempSync(path.join(os.tmpdir(), "browser-e2e-"));
            const port = 9300 + Math.floor(Math.random() * 500);
            const browser = spawn(findBrowser(), [
                "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
                "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                `--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>",
                "about:blank",
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

            // Current login page: "Sign in", then a redirect to /dashboard.
            async function submitLogin(email: string, password: string, deviceCode: string) {
                await p.goto("/login");
                await p.fill(`document.querySelector('input[type=email]')`, email);
                await p.fill(`document.querySelector('input[type=password]')`, password);
                await p.fill(`document.querySelector('input[type=text]')`, deviceCode);
                await p.clickButton("Sign in");
            }
            async function login(user: typeof alice) {
                await submitLogin(user.email, user.password, user.deviceCode);
                return p.waitFor(`location.pathname === "/dashboard"`);
            }

            // Offline for the page (navigator.onLine) AND the service worker
            // (proxy refuses connections). Always restored by the caller.
            async function setOffline(offline: boolean) {
                proxy.state.offline = offline;
                await p.send("Network.enable");
                await p.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
                return p.waitFor(`navigator.onLine === ${!offline}`);
            }
            async function whileOffline<T>(work: () => Promise<T>): Promise<T> {
                try {
                    await setOffline(true);
                    return await work();
                } finally {
                    await setOffline(false);
                }
            }
            // Proves the network is gone for requests made via the service worker.
            const serverReachable = () => p.eval<boolean>(`fetch("/api/auth/me", { cache: "no-store" }).then(() => true, () => false)`);
            const offlineSessions = () => p.eval<{ key: string; userId: string; expiresAt: string }[]>(READ_OFFLINE_SESSIONS);
            const keyOf = (u: typeof alice) => `${u.identity.tenantId}:${u.identity.userId}:${u.identity.deviceId}`;

            async function setOfflinePin(pin: string) {
                await p.goto("/account");
                await p.waitForText("Offline access");
                await p.fill(`document.querySelectorAll('section[aria-label="Offline PIN"] input')[0]`, pin);
                await p.fill(`document.querySelectorAll('section[aria-label="Offline PIN"] input')[1]`, pin);
                await p.eval(`document.querySelector('section[aria-label="Offline PIN"] button[type=submit]').click()`);
                return p.waitFor(`/Offline PIN saved|too easy|not allowed|could not be confirmed|Unable to contact/.test(document.body.innerText)`)
                    .then(() => p.text());
            }
            async function enterOfflinePin(pin: string) {
                await p.fill(`document.querySelector('section[aria-label="Offline session"] input')`, pin);
                await p.clickButton("Unlock");
            }
            // Cold load of the dashboard while offline (from the service worker cache).
            async function openDashboardOffline() {
                await p.goto("/dashboard");
                return p.waitForText("Unable to contact the server to verify your session.");
            }
            async function addOfflineSale() {
                await p.goto("/offline-test");
                await p.waitForText("Network Status");
                await p.clickButton("Add Offline Test Sale");
                await p.waitFor(`/Operation added successfully|Failed to add offline operation/.test(document.body.innerText)`);
                return (await p.text()).includes("Operation added successfully");
            }
            async function warmOfflinePages() {
                await p.goto("/dashboard");
                const verified = await p.waitForText("Welcome to your billing");
                await p.goto("/offline-test");
                await p.waitForText("Network Status");
                await p.goto("/dashboard");
                await p.waitForText("Welcome to your billing");
                await p.waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller !== null`, 20_000);
                await sleep(1000); // let the service worker store the pages
                return verified;
            }
            async function logoutFromDashboard() {
                await p.goto("/dashboard");
                await p.waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Logout")`);
                await p.clickButton("Logout");
                return p.waitFor(`location.pathname === "/login"`);
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
            // A failed sign-in attempt must not leave Alice's identity usable.
            await submitLogin(bob.email, "Definitely-Wrong-Pass-1", bob.deviceCode);
            check("B3. A failed sign-in shows an error and stays on /login",
                (await p.waitForText("Invalid email or password")) && (await p.eval<string>("location.pathname")) === "/login");
            check("B3. A failed sign-in clears the previously remembered identity", (await p.eval(READ_IDENTITY)) === null);
            check("B3. Alice signs in again (identity remembered again)",
                (await login(alice)) && sameIdentity(await p.eval(READ_IDENTITY), alice.identity));

            check("B3. Alice logs out from the dashboard", await logoutFromDashboard());
            check("B3. Dashboard logout forgets the remembered identity", (await p.eval(READ_IDENTITY)) === null);
            check("B4. Bob logs in on the same browser", await login(bob));
            check("B4. Bob's sign-in records Bob's identity, never Alice's",
                sameIdentity(await p.eval(READ_IDENTITY), bob.identity));
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

            // ----------------------------- queue while offline (needs an unlocked offline PIN session)
            check("B6. Alice's verified dashboard and offline pages are cached", await warmOfflinePages());
            const queueBeforeNoPin = (await queue()).length;
            const noPinResult = await whileOffline(async () => ({
                reachable: await serverReachable(),
                added: await addOfflineSale(),
            }));
            check("B6. Offline simulation cuts the network for the service worker too", noPinResult.reachable === false);
            check("B6. Without an offline PIN session, offline queueing is refused (nothing queued)",
                !noPinResult.added && (await queue()).length === queueBeforeNoPin);

            const pinSetup = await setOfflinePin("583920");
            check("B6. Alice sets an offline PIN on /account while online", pinSetup.includes("Offline PIN saved"), pinSetup.slice(-300));
            check("B6. The offline session record is bound to Alice and does not contain the PIN",
                (await offlineSessions()).some((s) => s.key === keyOf(alice))
                && !JSON.stringify(await offlineSessions()).includes("583920"));
            await warmOfflinePages();

            await setOffline(true);
            let offlineItem: LocalItem | undefined;
            try {
                check("B6. Cold offline load of /dashboard (from the service worker cache) offers the PIN unlock",
                    (await openDashboardOffline()) && (await p.waitForText("Offline PIN")));
                await enterOfflinePin("583920");
                check("B6. The correct PIN unlocks offline mode", await p.waitForText("Offline mode"));
                check("B6. Queueing works while offline after unlocking", await addOfflineSale());
                await p.waitForText("OFFLINE");
                offlineItem = (await queue()).find((i) => i.operationId !== legacyOperationId && i.operationId !== aliceItem.operationId);
                check("B6. The offline item is owned by Alice (remembered identity)", sameIdentity(offlineItem?.owner, alice.identity), JSON.stringify(offlineItem?.owner));
                await p.clickButton("Sync Operations");
                check("B6. Sync is skipped while offline", await p.waitForText("Sync skipped: offline."));
            } finally {
                await setOffline(false);
            }
            await p.waitForText("ONLINE");
            await syncFromDemoPage();
            const offlineServerOp = await SyncOperation.findOne({ tenantId, operationId: offlineItem?.operationId }).lean();
            check("B6. Back online, the offline item is uploaded as Alice", offlineServerOp?.userId?.toString() === alice.identity.userId);
            check("B6. Reconnecting and syncing did not change the item's local owner",
                sameIdentity((await findItem(offlineItem?.operationId ?? ""))?.owner, alice.identity));

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

            // ------------------- identity lifecycle when the session ends elsewhere
            // Revoke Alice's server sessions as "log out of all devices" on
            // another device would (only this run's temporary tenant).
            const revokeAliceSessions = () => Session.updateMany(
                { tenantId, userId: new Types.ObjectId(alice.identity.userId), revokedAt: { $exists: false } },
                { $set: { revokedAt: new Date(), revokedReason: "test-revoked-elsewhere" } }
            );
            const aliceItemCount = async () => (await queue()).filter((i) => sameIdentity(i.owner, alice.identity)).length;

            // B8: a network failure during the session check is not a sign-out.
            await p.send("Network.setBlockedURLs", { urls: ["*/api/auth/me*"] });
            await p.goto("/dashboard");
            const unreachableShown = await p.waitForText("Unable to contact the server to verify your session.");
            await p.send("Network.setBlockedURLs", { urls: [] });
            check("B8. Network failure while checking the session shows a retry message (stays on /dashboard)",
                unreachableShown && (await p.eval<string>("location.pathname")) === "/dashboard");
            check("B8. Network failure does not forget the remembered identity", sameIdentity(await p.eval(READ_IDENTITY), alice.identity));

            // B9: the session is revoked elsewhere; the next online check clears the identity.
            const itemsBeforeRevoke = await aliceItemCount();
            await revokeAliceSessions();
            await p.goto("/dashboard");
            check("B9. After the session is revoked elsewhere, /dashboard redirects to /login",
                await p.waitFor(`location.pathname === "/login"`));
            check("B9. The rejected session's remembered identity is forgotten", (await p.eval(READ_IDENTITY)) === null);
            check("B9. ...and Alice's offline PIN session is removed", !(await offlineSessions()).some((s) => s.key === keyOf(alice)));
            check("B9. Alice's queued offline items are kept (not deleted)",
                itemsBeforeRevoke > 0 && (await aliceItemCount()) === itemsBeforeRevoke, `${itemsBeforeRevoke} -> ${await aliceItemCount()}`);

            // B10: with no remembered identity, offline queueing is refused.
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            const itemsBeforeOfflineAttempt = (await queue()).length;
            await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await p.waitForText("OFFLINE");
            await p.clickButton("Add Offline Test Sale");
            const refused = await p.waitForText("Failed to add offline operation.");
            await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await p.waitForText("ONLINE");
            check("B10. Offline queueing is refused after the session was rejected (nothing queued)",
                refused && (await queue()).length === itemsBeforeOfflineAttempt);

            // B11: the sync path also clears the identity on a rejected session.
            check("B11. Alice signs in again", (await login(alice)) && sameIdentity(await p.eval(READ_IDENTITY), alice.identity));
            await revokeAliceSessions();
            const syncAfterRevoke = await syncFromDemoPage();
            check("B11. Sync with a revoked session is skipped as not signed in", syncAfterRevoke.includes("Sync skipped: not signed in."), syncAfterRevoke.slice(-200));
            check("B11. ...and the remembered identity is forgotten, queued items kept",
                (await p.eval(READ_IDENTITY)) === null && (await aliceItemCount()) === itemsBeforeRevoke);

            // B12: /account and /users clear it too.
            for (const [pagePath, signedOutText] of [["/account", "You are signed out."], ["/users", "not logged in"]] as const) {
                await login(alice);
                await revokeAliceSessions();
                await p.goto(pagePath);
                const shown = await p.waitForText(signedOutText);
                const cleared = await p.waitFor(READ_IDENTITY + ".then((v) => v === null)");
                check(`B12. ${pagePath} with a revoked session shows the signed-out state and forgets the identity`, shown && cleared);
            }

            // ------------------- B13: /api/auth/me returns HTTP 500 (browser stays online)
            // Only /api/auth/me is intercepted; interception is always removed
            // in finally, and the number of intercepted requests is checked so
            // a silently ineffective interception cannot produce a pass.
            async function withMeServerError<T>(work: () => Promise<T>): Promise<{ result: T; intercepted: number }> {
                let intercepted = 0;
                const unsubscribe = p.on("Fetch.requestPaused", (params: { requestId: string }) => {
                    intercepted++;
                    void p.send("Fetch.fulfillRequest", {
                        requestId: params.requestId,
                        responseCode: 500,
                        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
                        body: Buffer.from(JSON.stringify({ success: false, message: "Simulated server error" })).toString("base64"),
                    }).catch(() => undefined);
                });
                try {
                    // The service worker makes the real network request, so
                    // bypass it for this window to let the page-level
                    // interception see /api/auth/me. (The worker passes /api/*
                    // through NetworkOnly, so a 500 would reach the page anyway.)
                    await p.send("Network.enable");
                    await p.send("Network.setBypassServiceWorker", { bypass: true });
                    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/auth/me*", requestStage: "Request" }] });
                    return { result: await work(), intercepted };
                } finally {
                    await p.send("Fetch.disable").catch(() => undefined);
                    await p.send("Network.setBypassServiceWorker", { bypass: false }).catch(() => undefined);
                    unsubscribe();
                }
            }
            const snapshotAliceItems = async () => JSON.stringify(
                (await queue()).filter((i) => sameIdentity(i.owner, alice.identity))
                    .map((i) => ({ operationId: i.operationId, status: i.status, owner: i.owner }))
                    .sort((a, b) => a.operationId.localeCompare(b.operationId))
            );

            check("B13. Alice signs in again", (await login(alice)) && sameIdentity(await p.eval(READ_IDENTITY), alice.identity));
            const itemsBefore5xx = await snapshotAliceItems();
            const { result: during5xx, intercepted } = await withMeServerError(async () => {
                await p.goto("/dashboard");
                const unreachable = await p.waitForText("Unable to contact the server to verify your session.");
                await sleep(1500); // a wrongful redirect to /login would happen within this time
                const stayedOnDashboard = (await p.eval<string>("location.pathname")) === "/dashboard";
                const identityAfterDashboard = await p.eval(READ_IDENTITY);
                const syncText = await syncFromDemoPage();
                return { unreachable, stayedOnDashboard, identityAfterDashboard, syncText, identityAfterSync: await p.eval(READ_IDENTITY) };
            });
            check("B13. The HTTP 500 interception was active (requests to /api/auth/me intercepted)", intercepted >= 2, `intercepted=${intercepted}`);
            check("B13. Dashboard reports it cannot verify the session (not treated as signed out)",
                during5xx.unreachable && during5xx.stayedOnDashboard);
            check("B13. The remembered identity is preserved after the dashboard check",
                sameIdentity(during5xx.identityAfterDashboard, alice.identity));
            check("B13. Sync reports the server is unreachable, not \"not signed in\"",
                during5xx.syncText.includes("Sync skipped: server unreachable.") && !during5xx.syncText.includes("not signed in"),
                during5xx.syncText.slice(-200));
            check("B13. The remembered identity is preserved after the sync attempt", sameIdentity(during5xx.identityAfterSync, alice.identity));
            check("B13. Queued offline items are unchanged", (await snapshotAliceItems()) === itemsBefore5xx);
            await p.goto("/dashboard");
            check("B13. After the interception is removed, the dashboard verifies the session normally",
                await p.waitForText("Welcome to your billing and inventory system."));

            // ------------------- B14: a rejected session blocks the upload of PENDING work
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            await p.clickButton("Add Offline Test Sale");
            await p.waitForText("Operation added successfully");
            const pendingItem = (await queue()).find((i) =>
                sameIdentity(i.owner, alice.identity) && i.status === "PENDING");
            check("B14. Alice has a PENDING queued item", Boolean(pendingItem));
            await revokeAliceSessions();
            const blockedSync = await syncFromDemoPage();
            check("B14. Sync with a rejected session reports not signed in", blockedSync.includes("Sync skipped: not signed in."), blockedSync.slice(-200));
            check("B14. The PENDING item was NOT uploaded",
                (await SyncOperation.countDocuments({ operationId: pendingItem?.operationId ?? "-" })) === 0);
            check("B14. The PENDING item is preserved locally, unchanged (status and owner)",
                (await findItem(pendingItem?.operationId ?? ""))?.status === "PENDING"
                && sameIdentity((await findItem(pendingItem?.operationId ?? ""))?.owner, alice.identity));
            check("B14. The rejected session's identity was forgotten", (await p.eval(READ_IDENTITY)) === null);

            // Signing in again as the owner uploads it under the same owner.
            check("B14. Alice signs in again", await login(alice));
            await syncFromDemoPage();
            const uploadedPending = await SyncOperation.findOne({ tenantId, operationId: pendingItem?.operationId ?? "-" }).lean();
            check("B14. After Alice signs in again, the preserved item is uploaded under Alice (owner unchanged)",
                uploadedPending?.userId?.toString() === alice.identity.userId
                && sameIdentity((await findItem(pendingItem?.operationId ?? ""))?.owner, alice.identity));

            // ------------------- B15: offline sign-in attempt keeps the identity
            const offline = (on: boolean) => p.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            check("B15. Alice's identity is remembered before the offline sign-in attempt",
                sameIdentity(await p.eval(READ_IDENTITY), alice.identity));
            await p.goto("/login");
            await p.waitForText("Sign in");
            let offlineLoginError = false;
            try {
                await offline(true);
                await p.fill(`document.querySelector('input[type=email]')`, bob.email);
                await p.fill(`document.querySelector('input[type=password]')`, bob.password);
                await p.fill(`document.querySelector('input[type=text]')`, bob.deviceCode);
                await p.clickButton("Sign in");
                offlineLoginError = await p.waitForText("Unable to connect to the server");
            } finally {
                await offline(false);
            }
            check("B15. A sign-in attempt while offline fails with a connection error", offlineLoginError);
            check("B15. A failed offline sign-in attempt does NOT erase the remembered identity",
                sameIdentity(await p.eval(READ_IDENTITY), alice.identity), JSON.stringify(await p.eval(READ_IDENTITY)));

            // ------------------- B16: temporary-password users cannot queue offline work
            await submitLogin(carol.email, carol.password, carol.deviceCode);
            check("B16. A temporary-password user is sent to /account", await p.waitFor(`location.pathname === "/account"`));
            check("B16. Their sign-in does not remember an offline identity (the previous one is forgotten too)",
                (await p.eval(READ_IDENTITY)) === null);
            const queueBeforeCarol = (await queue()).length;
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            await p.clickButton("Add Offline Test Sale");
            check("B16. Online, queueing is refused for a temporary-password user", await p.waitForText("Failed to add offline operation."));
            // Change the page's message through the app (React only re-renders
            // when the message changes), so the next refusal is visible again.
            await p.clickButton("Check Queue");
            await p.waitForText("Sign in to see this account's queued operations.");
            let carolOfflineRefused = false;
            try {
                await offline(true);
                await p.waitForText("OFFLINE");
                await p.clickButton("Add Offline Test Sale");
                carolOfflineRefused = await p.waitForText("Failed to add offline operation.");
            } finally {
                await offline(false);
            }
            await p.waitForText("ONLINE");
            check("B16. Offline, queueing is refused too (no identity was remembered)", carolOfflineRefused);
            check("B16. Nothing was queued for the temporary-password user",
                (await queue()).length === queueBeforeCarol
                && !(await queue()).some((i) => (i.owner as { userId?: string } | undefined)?.userId === carol.identity.userId));

            // A remembered identity whose user is then required to change the
            // password: online queueing is refused and the identity forgotten.
            check("B16. Alice signs in again", await login(alice));
            check("B16. Alice's identity is remembered", sameIdentity(await p.eval(READ_IDENTITY), alice.identity));
            await User.updateOne({ _id: new Types.ObjectId(alice.identity.userId), tenantId }, { $set: { mustChangePassword: true } });
            const aliceItemsBefore = (await queue()).filter((i) => sameIdentity(i.owner, alice.identity)).length;
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            await p.clickButton("Add Offline Test Sale");
            check("B16. After an administrator reset, Alice cannot queue work until she changes her password",
                await p.waitForText("Failed to add offline operation."));
            check("B16. ...and her remembered identity is forgotten, her queued items kept",
                (await p.eval(READ_IDENTITY)) === null
                && (await queue()).filter((i) => sameIdentity(i.owner, alice.identity)).length === aliceItemsBefore);
            await User.updateOne({ _id: new Types.ObjectId(alice.identity.userId), tenantId }, { $set: { mustChangePassword: false } });

            const PIN = "583920";
            const aliceUnsynced = async () => (await queue()).filter((i) => sameIdentity(i.owner, alice.identity) && i.status !== "SYNCED").length;

            // ------------------- B17: PIN setup rules (online only)
            check("B17. Alice signs in again", await login(alice));
            const trivial = await setOfflinePin("123456");
            check("B17. A trivial PIN is refused and nothing is stored",
                trivial.includes("too easy") && !(await offlineSessions()).some((s) => s.key === keyOf(alice)));
            const tempPwPin = await (async () => {
                await submitLogin(carol.email, carol.password, carol.deviceCode);
                await p.waitFor(`location.pathname === "/account"`);
                await p.waitForText("Signed in as");
                return p.eval<boolean>(`Boolean(document.querySelector('section[aria-label="Offline PIN"]'))`);
            })();
            check("B17. A temporary-password user is not offered an offline PIN", tempPwPin === false);
            check("B17. Alice signs in again and sets a valid PIN", (await login(alice)) && (await setOfflinePin(PIN)).includes("Offline PIN saved"));
            await warmOfflinePages();

            // ------------------- B18: cold offline dashboard, wrong PIN, unlock, lock
            let b18Item: string | undefined;
            await whileOffline(async () => {
                check("B18. Offline: the cached dashboard loads and offers the PIN unlock",
                    (await openDashboardOffline()) && (await p.waitForText("Offline PIN")));
                check("B18. The page shows the expiry time and the number of unsynced items",
                    (await p.text()).includes("available until") && /\d+ unsynced item/.test(await p.text()));
                await enterOfflinePin("604187");
                check("B18. A wrong PIN is refused with the attempts left", await p.waitForText("Incorrect PIN. 4 attempt(s) left"));
                await enterOfflinePin(PIN);
                check("B18. The correct PIN unlocks offline mode", await p.waitForText("Offline mode"));
                const before = (await queue()).length;
                check("B18. An unlocked session can queue offline work", await addOfflineSale());
                b18Item = (await queue()).slice(-1)[0]?.operationId;
                check("B18. ...one item was queued, owned by Alice",
                    (await queue()).length === before + 1 && sameIdentity((await findItem(b18Item ?? ""))?.owner, alice.identity));
                await openDashboardOffline();
                await p.waitForText("Offline mode");
                await p.clickButton("Lock");
                check("B18. Lock returns to the PIN prompt", await p.waitForText("Offline session locked"));
                const lockedCount = (await queue()).length;
                check("B18. A locked session cannot queue offline work (queued items kept)",
                    !(await addOfflineSale()) && (await queue()).length === lockedCount);
            });

            // ------------------- B19: expiry blocks new work, keeps queued sales; online renews
            const unsyncedBeforeExpiry = await aliceUnsynced();
            check("B19. Alice's offline session is aged past its 24-hour window (test setup)", await p.eval<boolean>(AGE_OFFLINE_SESSION(keyOf(alice))));
            await whileOffline(async () => {
                await openDashboardOffline();
                check("B19. Offline: the dashboard reports the expiry and that unsynced sales are safe",
                    (await p.waitForText("Your offline session expired at")) && (await p.text()).includes("are safe on this device"));
                check("B19. No PIN unlock is offered for an expired session",
                    !(await p.eval<boolean>(`Boolean(document.querySelector('section[aria-label="Offline session"] input'))`)));
                check("B19. New offline work is blocked", !(await addOfflineSale()));
                check("B19. Queued items are preserved", (await aliceUnsynced()) === unsyncedBeforeExpiry);
            });
            check("B19. Back online, Alice signs in", await login(alice));
            const renewed = (await offlineSessions()).find((s) => s.key === keyOf(alice));
            check("B19. The successful online check renewed the window to about 24 hours",
                Boolean(renewed) && Date.parse(renewed!.expiresAt) > Date.now() + 23 * 3600 * 1000, renewed?.expiresAt);
            await syncFromDemoPage();
            check("B19. The sale queued before expiry is uploaded under Alice",
                (await SyncOperation.findOne({ tenantId, operationId: b18Item ?? "-" }).lean())?.userId?.toString() === alice.identity.userId);

            // ------------------- B20: five wrong PINs remove the session, never queued sales
            await warmOfflinePages();
            const queueBeforeLockout = JSON.stringify(await queue());
            await whileOffline(async () => {
                await openDashboardOffline();
                await p.waitForText("Offline PIN");
                const steps: boolean[] = [];
                for (let attempt = 1; attempt <= 5; attempt++) {
                    await enterOfflinePin("604187");
                    steps.push(await p.waitForText(attempt < 5 ? `Incorrect PIN. ${5 - attempt} attempt(s) left` : "Too many incorrect PINs"));
                }
                check("B20. Each wrong PIN reports the attempts left (4, 3, 2, 1)", steps.slice(0, 4).every(Boolean), steps.join(","));
                check("B20. The fifth wrong PIN removes the offline session and says queued sales are safe",
                    (await p.waitForText("Too many incorrect PINs")) && (await p.text()).includes("are safe"));
                check("B20. The offline session record is deleted", !(await offlineSessions()).some((s) => s.key === keyOf(alice)));
                check("B20. Queued sales are untouched", JSON.stringify(await queue()) === queueBeforeLockout);
                check("B20. Offline work is now blocked", !(await addOfflineSale()));
            });

            // ------------------- B21: shared device - another user cannot use Alice's offline session
            check("B21. Alice signs in and sets her PIN again", (await login(alice)) && (await setOfflinePin(PIN)).includes("Offline PIN saved"));
            check("B21. Bob signs in online on the same browser", await login(bob));
            await warmOfflinePages();
            const bobQueueBefore = (await queue()).length;
            await whileOffline(async () => {
                await openDashboardOffline();
                check("B21. Offline, Bob has no offline session (Alice's PIN session is not offered)",
                    (await p.waitForText("has not been set up for this account"))
                    && !(await p.eval<boolean>(`Boolean(document.querySelector('section[aria-label="Offline session"] input'))`)));
                check("B21. Bob cannot queue offline work", !(await addOfflineSale()) && (await queue()).length === bobQueueBefore);
            });
            check("B21. Alice's own offline session record is still on the device (dormant)",
                (await offlineSessions()).some((s) => s.key === keyOf(alice)));

            // ------------------- B22: offline sign-out, then the server logout on reconnection
            check("B22. Alice signs in again", await login(alice));
            await warmOfflinePages();
            const activeAliceSessions = () => Session.countDocuments({
                tenantId, userId: new Types.ObjectId(alice.identity.userId), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() },
            });
            const logoutRevocations = () => Session.countDocuments({
                tenantId, userId: new Types.ObjectId(alice.identity.userId), revokedReason: "logout",
            });
            const activeBefore = await activeAliceSessions();
            const logoutsBefore = await logoutRevocations();
            const queueBeforeSignOut = JSON.stringify(await queue());
            await whileOffline(async () => {
                await openDashboardOffline();
                await p.waitForText("Offline PIN");
                await enterOfflinePin(PIN);
                await p.waitForText("Offline mode");
                await p.clickButton("Sign out offline");
                check("B22. Offline sign-out says the server session has NOT been ended yet",
                    await p.waitForText("The server session has NOT been ended yet"));
                check("B22. The offline session and remembered identity are removed; a server logout is pending",
                    !(await offlineSessions()).some((s) => s.key === keyOf(alice))
                    && (await p.eval(READ_IDENTITY)) === null && (await p.eval<boolean>(READ_PENDING_LOGOUT)) === true);
                check("B22. Queued sales are untouched", JSON.stringify(await queue()) === queueBeforeSignOut);
            });
            check("B22. While the device was offline the server session stayed active (not claimed as revoked)",
                activeBefore >= 1 && (await activeAliceSessions()) === activeBefore, `${activeBefore} -> ${await activeAliceSessions()}`);
            await p.goto("/dashboard");
            check("B22. On reconnection the pending logout runs and the dashboard goes to /login",
                await p.waitFor(`location.pathname === "/login"`));
            check("B22. ...the server session was revoked by that logout (exactly one more logout revocation)",
                (await activeAliceSessions()) === activeBefore - 1 && (await logoutRevocations()) === logoutsBefore + 1,
                `active ${activeBefore} -> ${await activeAliceSessions()}, logouts ${logoutsBefore} -> ${await logoutRevocations()}`);
            check("B22. ...and the pending-logout flag is cleared", (await p.eval<boolean>(READ_PENDING_LOGOUT)) === false);
        },
    });
}

main().catch((error: unknown) => {
    console.error("Offline sync browser tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
