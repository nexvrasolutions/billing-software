
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
 * Current rules exercised here (see lib/offline/*):
 *  - The 72-hour offline session is created/renewed ONLY by a successful
 *    online verification made by login, the dashboard or the account page,
 *    based on the server's clock (serverTime from /api/auth/me) and refused
 *    when the device clock differs by more than five minutes. Sync, Sync
 *    now, queueing, queue inspection and offline use never renew it.
 *  - Signing in as a different account is stopped while ANY unsynced queue
 *    item (every type and status, including NEEDS_ATTENTION and items
 *    without an owner) is not owned by that account, unless a verified
 *    export covering every such item was saved on this device. The export
 *    never changes, deletes or reassigns items and is NOT an import (no
 *    import endpoint exists). Items always stay with their original owner.
 *  - Logout and rejection remove the offline session and only the named
 *    runtime page/data caches; the queue and the precached shell stay.
 *
 * SAFETY: the script refuses to run unless the database named in MONGODB_URI
 * is exactly "billing_test" (checked before anything is loaded or
 * connected), and a Ctrl+C / SIGTERM ends the test and runs the normal
 * cleanup once.
 *
 * Same database for server and test: the script starts the app server
 * ITSELF (next start, from the existing production build), passing it this
 * process's environment, i.e. the very MONGODB_URI and SESSION_SECRET the
 * guard just checked. It refuses to run when anything already listens on
 * BASE_URL's port on 127.0.0.1 or ::1 (that server could be using another
 * database) and when BASE_URL is not on this computer. The server listens on
 * 127.0.0.1 only and is stopped in the normal cleanup. Do NOT start a server
 * yourself.
 *
 * 1. npm run build            (never "npm run dev": it replaces the service worker)
 * 2. With NODE_ENV=test, only .env.test.local is loaded (never .env.local):
 *    NODE_ENV=test ALLOW_BROWSER_TESTS=YES npx tsx scripts/test-offline-sync-browser.ts
 *    (optional BASE_URL=http://localhost:<port>, default http://localhost:3130)
 */

import { loadEnvConfig } from "@next/env";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import http from "http";
import net, { type AddressInfo } from "net";
import os from "os";
import path from "path";

import { BASE_URL, Page, findBrowser, sleep } from "./lib/cdpBrowser";
import { runTestSafely } from "./lib/testRunSafety";
import { ensureTestPermissions } from "./lib/testPermissions";
import { verifyPendingExport, type PendingExport } from "../lib/offline/pendingGuard";

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
    payload?: Record<string, unknown>;
    errorMessage?: string;
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
// The acknowledgement remembered after a pending-items export was saved.
const READ_EXPORT_ACK = idbRequest(`
    if (!db.objectStoreNames.contains("meta")) { db.close(); resolve(null); return; }
    const req = db.transaction("meta", "readonly").objectStore("meta").get("pendingExportAck");
    req.onsuccess = () => { db.close(); resolve(req.result ? req.result.value : null); };
    req.onerror = () => { db.close(); reject(req.error); };
`);
/** Remove an offline session record only (queued sales are not touched). */
const DELETE_OFFLINE_SESSION = (key: string) => idbRequest(`
    const tx = db.transaction("offlineSessions", "readwrite");
    tx.objectStore("offlineSessions").delete(${JSON.stringify(key)});
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
`);
/** Move an offline session's 72-hour window into the past (expired an hour ago), consistently. */
const AGE_OFFLINE_SESSION = (key: string) => idbRequest(`
    const tx = db.transaction("offlineSessions", "readwrite");
    const store = tx.objectStore("offlineSessions");
    const req = store.get(${JSON.stringify(key)});
    req.onsuccess = () => {
        const record = req.result;
        if (!record) { db.close(); resolve(false); return; }
        const now = Date.now();
        record.lastOnlineCheckAt = new Date(now - 73 * 3600 * 1000).toISOString();
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
            // The test server listens on 127.0.0.1 only ("-H 127.0.0.1"), and
            // BASE_URL is checked to be this computer; "localhost" could
            // resolve to IPv6 ::1, where nothing listens.
            { hostname: "127.0.0.1", port: target.port, method: req.method, path: url.pathname + url.search, headers: req.headers },
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

// ----- The app server under test (started by this script)

/** BASE_URL must be plain http on this computer; returns its port. */
function localTestServerPort(baseUrl: string): number {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new Error("Refusing to run: BASE_URL is not a valid URL.");
    }
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/") {
        throw new Error("Refusing to run: BASE_URL must be http://localhost:<port> (the test starts its own server there).");
    }
    const port = Number(url.port || 80);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("Refusing to run: BASE_URL needs a port between 1024 and 65535.");
    }
    return port;
}

/** True when something accepts connections on host:port. */
function acceptsConnections(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (inUse: boolean) => {
            socket.destroy();
            resolve(inUse);
        };
        socket.setTimeout(2_000, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

/**
 * True when anything already listens on the port on this computer, over
 * IPv4 (127.0.0.1) OR IPv6 (::1): "localhost" can mean either, so a server
 * listening on only one of them must still be found.
 */
async function portInUse(port: number): Promise<boolean> {
    const [ipv4, ipv6] = await Promise.all([
        acceptsConnections("127.0.0.1", port),
        acceptsConnections("::1", port),
    ]);
    return ipv4 || ipv6;
}

/**
 * Fail-closed checks before anything touches a database: no foreign server
 * may answer at BASE_URL (it could use another database) and a production
 * build must exist for "next start".
 */
async function assertTestServerCanStart(port: number): Promise<void> {
    if (await portInUse(port)) {
        throw new Error(
            `Refusing to run: something is already listening on port ${port}. ` +
            "Stop it first: this test starts its own server so that the server and the test use the same test database."
        );
    }
    if (!existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))) {
        throw new Error("Refusing to run: no production build found. Run \"npm run build\" first (never \"npm run dev\").");
    }
}

/**
 * Start "next start" with THIS process's (guard-checked) environment.
 * Returns at once so the caller can register stop() for cleanup BEFORE
 * waiting for the server with waitUntilReady().
 */
function launchTestServer(port: number) {
    const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    // -H 127.0.0.1: reachable from this computer only, never from the network.
    const server = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: process.cwd(),
        // Values already in the environment win over .env files in Next.js,
        // so the server uses exactly the MONGODB_URI checked by the guard.
        env: { ...process.env },
        stdio: "ignore",
        windowsHide: true,
    });
    let exited = false;
    server.once("exit", () => {
        exited = true;
    });

    const stop = async () => {
        if (exited || server.pid === undefined) return;
        if (process.platform === "win32") {
            // Only this server's own process tree.
            await new Promise<void>((resolve) => {
                spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
                    .once("exit", () => resolve())
                    .once("error", () => resolve());
            });
        } else {
            server.kill("SIGTERM");
        }
        for (let i = 0; i < 20 && !exited; i++) await sleep(250);
    };

    // Ready once the login page answers; give up after 90 s.
    const waitUntilReady = async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
            if (exited) throw new Error("The test server stopped while starting (is the production build complete?).");
            const ready = await new Promise<boolean>((resolve) => {
                const request = http.get({ host: "127.0.0.1", port, path: "/login", timeout: 2_000 }, (response) => {
                    response.resume();
                    resolve((response.statusCode ?? 0) > 0 && (response.statusCode ?? 0) < 500);
                });
                request.once("timeout", () => request.destroy());
                request.once("error", () => resolve(false));
            });
            if (ready) return;
            await sleep(500);
        }
        throw new Error("The test server did not become ready within 90 seconds.");
    };

    return { stop, waitUntilReady };
}

/** The only database this test may use. */
const TEST_DATABASE_NAME = "billing_test";

/**
 * Database-name guard. Runs BEFORE any database module is loaded or any
 * connection is made. The test only runs against the database named exactly
 * "billing_test" (TEST_DATABASE_NAME, case-sensitive like MongoDB), so it
 * cannot touch the normal application database or any other database by
 * accident. It fails closed: a missing, unparseable or unnamed URI is
 * refused too. Neither the URI, the credentials nor the database name found
 * in it ever appear in a message.
 *
 * The name is the first path segment of a mongodb:// or mongodb+srv:// URI
 * (reserved characters in credentials must be percent-encoded, as MongoDB
 * requires; anything else simply fails to parse and is refused).
 */
function assertDedicatedTestDatabase(uri: string | undefined): void {
    const refuse = (): never => {
        throw new Error(
            `Refusing to run: MONGODB_URI must name the dedicated test database ${TEST_DATABASE_NAME}. ` +
            "Nothing was connected to or written."
        );
    };

    if (!uri) return refuse();

    const match = /^mongodb(?:\+srv)?:\/\/([^/?#]+)\/([^/?#]*)/i.exec(uri.trim());
    if (!match) return refuse();

    let name: string;
    try {
        name = decodeURIComponent(match[2]);
    } catch {
        return refuse();
    }

    // Exactly the test database: not another "*_test" database, not a
    // name that merely contains it.
    if (name !== TEST_DATABASE_NAME) return refuse();
}

// ----- Interrupts (Ctrl+C / SIGTERM)
// The existing cleanup of runTestSafely runs once, after the test body ends
// (normally, by an error, by the overall timeout, or - added here - by a
// signal). A signal never starts a second cleanup: it only ends the body
// early, and a signal that arrives later just reports that cleanup is already
// running. Not covered: SIGKILL, "taskkill /F", a power loss, and closing the
// terminal window - nothing in Node can run code then (see the report).
type RunPhase = "before" | "running" | "finishing";
let runPhase: RunPhase = "before";
let interruptRun: ((signal: string) => void) | null = null;
let signalSeen = false;

function installSignalHandlers(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            if (signalSeen) {
                console.error(`Received ${signal} again: the cleanup is already in progress. Please wait (it is limited to about 90 seconds).`);
                return;
            }
            signalSeen = true;

            if (runPhase === "before") {
                // No connection was made and no record exists yet.
                console.error(`\nReceived ${signal} before the test created anything: nothing to clean up. Exiting.`);
                process.exit(signal === "SIGINT" ? 130 : 143);
            }

            console.error(`\nReceived ${signal}: stopping the test and running the normal cleanup. Please wait.`);
            if (runPhase === "running" && interruptRun) {
                interruptRun(signal);
            } else {
                console.error("The test body had already finished, so the normal cleanup is already running.");
            }
        });
    }
}

async function main() {
    installSignalHandlers();

    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_BROWSER_TESTS !== "YES") {
        throw new Error("Set ALLOW_BROWSER_TESTS=YES after confirming MONGODB_URI is a development database.");
    }
    assertDedicatedTestDatabase(process.env.MONGODB_URI);
    if (!process.env.SESSION_SECRET) {
        throw new Error("Refusing to run: SESSION_SECRET is not set (the test server and the test must share it).");
    }
    const serverPort = localTestServerPort(BASE_URL);
    await assertTestServerCanStart(serverPort);

    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Device } = await import("../lib/models/Device");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Sale } = await import("../lib/models/Sale");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { Session } = await import("../lib/models/Session");
    const mongoose = (await import("mongoose")).default;
    const { Types } = mongoose;
    const { hashPassword } = await import("../app/api/auth/password");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");

    // Runs the test body so that a signal can end it early. On a signal the
    // test's own connection is force-closed first (as runTestSafely does on
    // its overall timeout) so the unfinished body can no longer write, then
    // the body is abandoned with an error and runTestSafely performs its one
    // normal cleanup and reports any problem ("CLEANUP ERRORS ... Manual
    // cleanup needed for tenant IDs ...").
    const interruptible = async (work: () => Promise<void>): Promise<void> => {
        runPhase = "running";
        const interrupted = new Promise<never>((_, reject) => {
            interruptRun = (signal) => {
                void (async () => {
                    await mongoose.connection.close(true).catch(() => undefined);
                    await sleep(3000);
                    reject(new Error(`Interrupted by ${signal}`));
                })();
            };
        });
        try {
            await Promise.race([work(), interrupted]);
        } finally {
            interruptRun = null;
            runPhase = "finishing";
        }
    };

    await runTestSafely({
        name: "Offline sync browser tests",
        tenantNamePrefix: "SYNCB-TEST-",
        overallTimeoutMs: 540_000,
        summarize,
        run: (run) => interruptible(async () => {
            // The app server, started here with the guard-checked
            // environment, so it uses the same test database as this script.
            const testServer = launchTestServer(serverPort);
            run.onCleanup("stop test server", () => testServer.stop());
            await testServer.waitUntilReady();

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
            // Every read of the queue also checks continuity: once seen, an item
            // must stay in the queue and keep the same owner for the whole run
            // (nothing deleted, nothing silently reassigned to another account).
            const ownerLedger = new Map<string, string>();
            const ledgerProblems: string[] = [];
            const queue = async () => {
                const items = await p.eval<LocalItem[]>(READ_QUEUE);
                const present = new Set(items.map((i) => i.operationId));
                for (const known of [...ownerLedger.keys()]) {
                    if (!present.has(known)) {
                        ledgerProblems.push(`${known} disappeared from the queue`);
                        ownerLedger.delete(known);
                    }
                }
                for (const item of items) {
                    const owner = JSON.stringify(item.owner ?? null);
                    const seen = ownerLedger.get(item.operationId);
                    if (seen === undefined) ownerLedger.set(item.operationId, owner);
                    else if (seen !== owner) {
                        ledgerProblems.push(`${item.operationId} changed owner: ${seen} -> ${owner}`);
                        ownerLedger.set(item.operationId, owner);
                    }
                }
                return items;
            };
            const findItem = async (operationId: string) => (await queue()).find((i) => i.operationId === operationId);
            const sameIdentity = (a: unknown, b: { tenantId: string; userId: string; deviceId: string }) =>
                JSON.stringify(a) === JSON.stringify(b);
            // The dashboard syncs by itself when it opens (AutoSync, M-13).
            // Before comparing queue snapshots, wait until that account's
            // items are no longer SYNCING and stayed unchanged for a second.
            async function waitForQueueSettled(owner: { tenantId: string; userId: string; deviceId: string }, timeoutMs = 30_000) {
                const deadline = Date.now() + timeoutMs;
                let previous = "";
                while (Date.now() < deadline) {
                    const own = (await queue()).filter((i) => sameIdentity(i.owner, owner));
                    const snapshot = JSON.stringify(own);
                    if (!own.some((i) => i.status === "SYNCING") && snapshot === previous) return true;
                    previous = snapshot;
                    await sleep(1000);
                }
                return false;
            }
            /** The item added by the last click: the one operation ID that was not there before. */
            const newItemSince = async (before: LocalItem[]) => {
                const known = new Set(before.map((i) => i.operationId));
                return (await queue()).find((i) => !known.has(i.operationId));
            };

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
            const offlineSessions = () => p.eval<{
                key: string; userId: string; expiresAt: string; lastOnlineCheckAt: string; clockHighWater: number;
            }[]>(READ_OFFLINE_SESSIONS);
            const keyOf = (u: typeof alice) => `${u.identity.tenantId}:${u.identity.userId}:${u.identity.deviceId}`;

            // The offline session is created automatically by a successful online
            // verification (visiting the dashboard); there is nothing to set up.
            const noPinFields = () => p.eval<boolean>(`document.querySelectorAll('input').length === 0 && !/\\bPIN\\b/i.test(document.body.innerText)`);
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
            // The browser helper auto-accepts window.confirm(); this also records the
            // message so the logout warning about waiting operations can be asserted.
            const CAPTURE_CONFIRMS = `window.__confirms = []; window.confirm = (message) => { window.__confirms.push(String(message)); return true; }`;
            let lastConfirms: string[] = [];
            async function readConfirmsAfterClick(): Promise<string[]> {
                const asked = await p.waitFor(`(window.__confirms || []).length > 0`, 4000);
                if (!asked) return [];
                try {
                    return await p.eval<string[]>(`window.__confirms`);
                } catch {
                    return [];
                }
            }
            async function logoutFromDashboard(beforeClick?: () => Promise<void>) {
                await p.goto("/dashboard");
                await p.waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Logout")`);
                await p.eval(CAPTURE_CONFIRMS);
                await beforeClick?.();
                await p.clickButton("Logout");
                lastConfirms = await readConfirmsAfterClick();
                return p.waitFor(`location.pathname === "/login"`);
            }
            async function logout() {
                await p.goto("/account");
                await p.waitForText("Signed in as");
                await p.eval(CAPTURE_CONFIRMS);
                await p.clickButton("Log out");
                lastConfirms = await readConfirmsAfterClick();
                return p.waitForText("You are signed out.");
            }

            // ----- pending-items export (the login page's "stopped" panel, /account)
            // Capture the file the page builds instead of letting the browser write it
            // to disk. (That the browser's own download is offered cannot be checked here.)
            const CAPTURE_EXPORTS = `(() => {
                window.__exportedFiles = [];
                window.__downloadClicks = [];
                const create = URL.createObjectURL.bind(URL);
                URL.createObjectURL = (blob) => { blob.text().then((t) => window.__exportedFiles.push(t)); return create(blob); };
                const click = HTMLAnchorElement.prototype.click;
                HTMLAnchorElement.prototype.click = function () {
                    if (this.download) { window.__downloadClicks.push(this.download); return; }
                    return click.call(this);
                };
            })()`;
            async function saveExportFromPage() {
                await p.eval(CAPTURE_EXPORTS);
                await p.clickButton("Save a copy of waiting operations");
                const created = await p.waitFor(`window.__exportedFiles.length > 0 && window.__downloadClicks.length > 0`, 20_000);
                if (!created) throw new Error("The export file was not created");
                const [json] = await p.eval<string[]>(`window.__exportedFiles`);
                const [filename] = await p.eval<string[]>(`window.__downloadClicks`);
                const file = JSON.parse(json) as PendingExport;
                // The acknowledgement is remembered right after the file is handed to the browser.
                const remembered = await p.waitFor(
                    READ_EXPORT_ACK + `.then((ack) => Boolean(ack) && ack.exportedAt === ${JSON.stringify(file.exportedAt)} && ack.exportDigest === ${JSON.stringify(file.digest)})`,
                    15_000
                );
                return { file, json, filename, remembered };
            }
            /** The export covers exactly the unsynced items, preserves them, and left the queue untouched. */
            async function checkExportAgainstQueue(label: string, exported: { file: PendingExport; remembered: boolean }, before: LocalItem[]) {
                const unsynced = before.filter((i) => i.status !== "SYNCED");
                const byId = new Map(exported.file.items.map((e) => [e.operationId, e]));
                check(`${label}: the export verifies (its digest matches its items)`, await verifyPendingExport(exported.file));
                check(`${label}: it lists exactly the ${unsynced.length} unsynced item(s)`,
                    exported.file.itemCount === unsynced.length && byId.size === unsynced.length && unsynced.every((i) => byId.has(i.operationId)));
                check(`${label}: ownership, status and payload of every item are preserved`,
                    unsynced.every((i) => {
                        const e = byId.get(i.operationId);
                        return Boolean(e) && e!.status === i.status
                            && JSON.stringify(e!.owner) === JSON.stringify(i.owner ?? null)
                            && JSON.stringify(e!.payload) === JSON.stringify(i.payload ?? {});
                    }));
                check(`${label}: the file says it is not an import and that no import endpoint exists`,
                    /NOT imported/.test(exported.file.note) && /no import endpoint/i.test(exported.file.note));
                check(`${label}: the acknowledgement was remembered on this device`, exported.remembered);
                check(`${label}: exporting changed, deleted and reassigned nothing in the queue`,
                    JSON.stringify(await queue()) === JSON.stringify(before));
            }
            /**
             * Sign in. If the sign-in is stopped by waiting operations of another
             * account, save the verified export and sign in again.
             */
            async function loginThroughExport(user: typeof alice, expectedPath = "/dashboard") {
                await submitLogin(user.email, user.password, user.deviceCode);
                await p.waitFor(`location.pathname !== "/login" || document.body.innerText.includes("Sign-in was stopped")`, 20_000);
                const blocked = await p.eval<boolean>(`document.body.innerText.includes("Sign-in was stopped")`);
                let exported: Awaited<ReturnType<typeof saveExportFromPage>> | null = null;
                if (blocked) {
                    exported = await saveExportFromPage();
                    await p.clickButton("Sign in");
                }
                const arrived = await p.waitFor(`location.pathname === ${JSON.stringify(expectedPath)}`, 20_000);
                return { blocked, arrived, exported };
            }

            // ----- device clock control (Date.now of every new document in this page)
            let clockScriptId: string | null = null;
            async function clearClockOffset() {
                if (clockScriptId) {
                    await p.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockScriptId });
                    clockScriptId = null;
                }
            }
            async function setClockOffset(ms: number) {
                await clearClockOffset();
                const added = (await p.send("Page.addScriptToEvaluateOnNewDocument", {
                    source: `(() => { const real = Date.now.bind(Date); Date.now = () => real() + (${ms}); })();`,
                })) as { identifier: string };
                clockScriptId = added.identifier;
            }

            const activeSessionsOf = (u: typeof alice) => Session.countDocuments({
                tenantId, userId: new Types.ObjectId(u.identity.userId), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() },
            });
            const logoutRevocationsOf = (u: typeof alice) => Session.countDocuments({
                tenantId, userId: new Types.ObjectId(u.identity.userId), revokedReason: "logout",
            });
            const expiryOf = async (u: typeof alice) => (await offlineSessions()).find((s) => s.key === keyOf(u))?.expiresAt;
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

            // The unowned legacy item is an unsynced item no account owns, so even
            // the very first sign-in is stopped until a verified export of it is saved.
            await submitLogin(alice.email, alice.password, alice.deviceCode);
            check("B1. The first sign-in is stopped (an unowned legacy item waits on the device) and stays on /login",
                (await p.waitForText("Sign-in was stopped")) && (await p.eval<string>("location.pathname")) === "/login");
            const stoppedText = await p.text();
            // The app's own database upgrade (which marks the legacy item NEEDS_ATTENTION) ran
            // during this attempt, so this is the baseline for "nothing changes from here on".
            const queueBeforeFirstLogin = await queue();
            check("B1. ...the message gives only counts and says nothing was deleted, changed or moved",
                stoppedText.includes("1 operation(s)") && stoppedText.includes("not been deleted, changed or moved")
                && !stoppedText.includes(alice.identity.userId));
            check("B1. ...it states the saved file is not an import",
                stoppedText.includes("not an import") && stoppedText.includes("cannot read it back"));
            check("B1. ...the server session created by that sign-in was ended again",
                (await activeSessionsOf(alice)) === 0 && (await logoutRevocationsOf(alice)) >= 1);
            check("B1. ...no identity was remembered and no offline session was created for Alice",
                (await p.eval(READ_IDENTITY)) === null && !(await offlineSessions()).some((s) => s.key === keyOf(alice)));
            check("B1. ...and the legacy item is kept, unowned and locked (NEEDS_ATTENTION), not reassigned or uploaded",
                queueBeforeFirstLogin.length === 1 && queueBeforeFirstLogin[0].operationId === legacyOperationId
                && queueBeforeFirstLogin[0].owner === undefined && queueBeforeFirstLogin[0].status === "NEEDS_ATTENTION"
                && queueBeforeFirstLogin[0].legacyUnowned === true
                && (await SyncOperation.countDocuments({ operationId: legacyOperationId })) === 0);

            const firstExport = await saveExportFromPage();
            await checkExportAgainstQueue("B1", firstExport, queueBeforeFirstLogin);
            check("B1. The export lists the legacy item with no owner and status NEEDS_ATTENTION",
                firstExport.file.items.length === 1 && firstExport.file.items[0].operationId === legacyOperationId
                && firstExport.file.items[0].owner === null && firstExport.file.items[0].legacyUnowned === true
                && firstExport.file.items[0].status === "NEEDS_ATTENTION");
            await p.clickButton("Sign in");
            check("B1. Alice logs in after the verified export", await p.waitFor(`location.pathname === "/dashboard"`, 20_000));
            const legacy = await findItem(legacyOperationId);
            check("B1. Legacy item without an owner is kept but locked (NEEDS_ATTENTION, legacyUnowned)",
                legacy?.status === "NEEDS_ATTENTION" && legacy?.legacyUnowned === true, JSON.stringify(legacy));
            check("B1. Login remembers the server-confirmed identity", sameIdentity(await p.eval(READ_IDENTITY), alice.identity));

            // /api/auth/me now reports the server's clock; the offline session is based on it.
            const meNow = await p.eval<{ serverTime?: unknown }>(`fetch("/api/auth/me", { credentials: "include", cache: "no-store" }).then((r) => r.json())`);
            check("B1. /api/auth/me reports serverTime as an ISO date close to now",
                typeof meNow.serverTime === "string" && Math.abs(Date.parse(meNow.serverTime) - Date.now()) < 5 * 60 * 1000,
                String(meNow.serverTime));
            const firstSession = (await offlineSessions()).find((s) => s.key === keyOf(alice));
            check("B1. Login created Alice's offline session from the server time: expiry exactly 72 hours after the last online check",
                Boolean(firstSession) && Date.parse(firstSession!.expiresAt) - Date.parse(firstSession!.lastOnlineCheckAt) === 72 * 3600 * 1000
                && Math.abs(Date.parse(firstSession!.lastOnlineCheckAt) - Date.now()) < 5 * 60 * 1000,
                JSON.stringify(firstSession));

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

            check("B2. The demo page no longer offers a button that deletes queued items",
                !(await p.text()).includes("Delete Old Test"));

            // ----------------------------- switch account to Bob
            // A failed sign-in attempt must not leave Alice's identity usable.
            await submitLogin(bob.email, "Definitely-Wrong-Pass-1", bob.deviceCode);
            check("B3. A failed sign-in shows an error and stays on /login",
                (await p.waitForText("Invalid email or password")) && (await p.eval<string>("location.pathname")) === "/login");
            check("B3. A failed sign-in clears the previously remembered identity", (await p.eval(READ_IDENTITY)) === null);
            check("B3. Alice signs in again (identity remembered again)",
                (await login(alice)) && sameIdentity(await p.eval(READ_IDENTITY), alice.identity));
            // Her dashboard sends her waiting item by itself (AutoSync); the demo
            // sale uses another business's product, so it ends NEEDS_ATTENTION.
            check("B3. Alice's dashboard sends her waiting item automatically, under her own identity",
                (await waitForQueueSettled(alice.identity))
                && (await SyncOperation.findOne({ tenantId, operationId: aliceItem.operationId }).lean())?.userId?.toString() === alice.identity.userId
                && (await findItem(aliceItem.operationId))?.status === "NEEDS_ATTENTION");

            // Logout removes the offline session and ONLY the named runtime page/data
            // caches. Plant a private-looking entry in each of them (and in an unrelated
            // cache) to prove which are cleared; the precache must stay.
            const RUNTIME_CACHES = ["pages", "pages-rsc", "pages-rsc-prefetch", "next-data", "start-url"];
            let precacheBeforeLogout: string[] = [];
            const queueBeforeAliceLogout = await queue();
            check("B3. Alice logs out from the dashboard", await logoutFromDashboard(async () => {
                precacheBeforeLogout = await p.eval<string[]>(`(async () => {
                    for (const name of ${JSON.stringify(RUNTIME_CACHES)}) {
                        await (await caches.open(name)).put("/__billing-test-private", new Response("private"));
                    }
                    await (await caches.open("billing-test-keep")).put("/__keep", new Response("keep"));
                    return (await caches.keys()).filter((k) => k.startsWith("workbox-precache")).sort();
                })()`);
            }));
            check("B3. Logging out with waiting operations warns first (they stay on the device, only their account can send them)",
                lastConfirms.length === 1 && /2 operation\(s\)/.test(lastConfirms[0]) && /NOT be deleted/.test(lastConfirms[0])
                && /only the account that made them/.test(lastConfirms[0]), JSON.stringify(lastConfirms));
            check("B3. Dashboard logout forgets the remembered identity", (await p.eval(READ_IDENTITY)) === null);
            check("B3. ...and Alice's offline session is removed", !(await offlineSessions()).some((s) => s.key === keyOf(alice)));
            check("B3. ...and the queue is untouched by the logout", JSON.stringify(await queue()) === JSON.stringify(queueBeforeAliceLogout));
            const afterLogoutCaches = await p.eval<{ cleared: boolean[]; kept: boolean; precache: string[] }>(`(async () => {
                const cleared = await Promise.all(${JSON.stringify(RUNTIME_CACHES)}.map(async (name) =>
                    !(await caches.has(name)) || !(await (await caches.open(name)).match("/__billing-test-private"))));
                const kept = Boolean(await (await caches.open("billing-test-keep")).match("/__keep"));
                const precache = (await caches.keys()).filter((k) => k.startsWith("workbox-precache")).sort();
                return { cleared, kept, precache };
            })()`);
            check("B3. Logout cleared the entries of the identified runtime page/data caches",
                afterLogoutCaches.cleared.every(Boolean), JSON.stringify(afterLogoutCaches.cleared));
            check("B3. ...but not an unrelated cache, and the precached app shell is unchanged",
                afterLogoutCaches.kept && JSON.stringify(afterLogoutCaches.precache) === JSON.stringify(precacheBeforeLogout),
                JSON.stringify({ before: precacheBeforeLogout, after: afterLogoutCaches.precache }));

            // Simulate a tab of Alice's that crashed in the middle of syncing her
            // item (after her last dashboard visit, so nothing of hers recovers it).
            await p.eval(idbRequest(`
                const store = db.transaction("syncQueue", "readwrite").objectStore("syncQueue");
                const get = store.get(${aliceItem.id});
                get.onsuccess = () => {
                    const item = get.result; item.status = "SYNCING"; item.syncingSince = new Date().toISOString();
                    const put = store.put(item);
                    put.onsuccess = () => { db.close(); resolve(true); };
                };
            `));
            const bobUploads = (operationId: string) =>
                SyncOperation.countDocuments({ tenantId, operationId, userId: new Types.ObjectId(bob.identity.userId) });

            // Alice's item (SYNCING) and the legacy item are unsynced items Bob does not own.
            const queueBeforeBob = await queue();
            await submitLogin(bob.email, bob.password, bob.deviceCode);
            check("B4. Bob's sign-in is stopped while Alice's unsynced items wait on the device, and stays on /login",
                (await p.waitForText("Sign-in was stopped")) && (await p.eval<string>("location.pathname")) === "/login");
            const bobStoppedText = await p.text();
            check("B4. ...the message gives counts only (no account details) and says nothing was moved to Bob",
                bobStoppedText.includes("2 operation(s)") && bobStoppedText.includes("not been deleted, changed or moved")
                && !bobStoppedText.includes(alice.identity.userId) && !bobStoppedText.includes(alice.email));
            check("B4. ...Bob's new server session was ended again",
                (await activeSessionsOf(bob)) === 0 && (await logoutRevocationsOf(bob)) >= 1);
            check("B4. ...nothing was remembered or created for Bob",
                (await p.eval(READ_IDENTITY)) === null && !(await offlineSessions()).some((s) => s.key === keyOf(bob)));
            check("B4. ...the queue is exactly as it was: Alice's item is still SYNCING and owned by Alice",
                JSON.stringify(await queue()) === JSON.stringify(queueBeforeBob)
                && (await findItem(aliceItem.operationId))?.status === "SYNCING"
                && sameIdentity((await findItem(aliceItem.operationId))?.owner, alice.identity));
            check("B4. ...and nothing of Alice's was uploaded under Bob's identity",
                (await bobUploads(aliceItem.operationId)) === 0);

            const bobExport = await saveExportFromPage();
            await checkExportAgainstQueue("B4", bobExport, queueBeforeBob);
            check("B4. The export lists Alice's item with Alice as owner and status SYNCING (and the unowned legacy item)",
                bobExport.file.items.some((e) => e.operationId === aliceItem.operationId && sameIdentity(e.owner, alice.identity) && e.status === "SYNCING")
                && bobExport.file.items.some((e) => e.operationId === legacyOperationId && e.owner === null));
            await p.clickButton("Sign in");
            check("B4. Bob logs in on the same browser after the verified export", await p.waitFor(`location.pathname === "/dashboard"`, 20_000));
            check("B4. Bob's sign-in records Bob's identity, never Alice's",
                sameIdentity(await p.eval(READ_IDENTITY), bob.identity));
            check("B4. The export did not reassign anything: Alice's item is still hers and still SYNCING",
                sameIdentity((await findItem(aliceItem.operationId))?.owner, alice.identity)
                && (await findItem(aliceItem.operationId))?.status === "SYNCING");
            const bobSync = await syncFromDemoPage();
            check("B4. Bob's sync finds nothing of his own", bobSync.includes("No pending operations to sync."), bobSync.slice(-200));
            check("B4. Alice's item was NOT uploaded under Bob's session (Bob's dashboard sync and his manual sync)",
                (await bobUploads(aliceItem.operationId)) === 0
                && (await SyncOperation.findOne({ tenantId, operationId: aliceItem.operationId }).lean())?.userId?.toString() === alice.identity.userId);
            check("B4. Alice's interrupted item is untouched by Bob's sync (still SYNCING, owner Alice)",
                (await findItem(aliceItem.operationId))?.status === "SYNCING");
            await p.clickButton("Check Queue");
            check("B4. Bob's queue view shows none of Alice's items", await p.waitForText("Queued operations for this account: 0"));

            // ----------------------------- back to Alice: recovery + upload
            check("B5. Bob logs out and Alice logs back in", (await logout()) && (await login(alice)));
            // Her dashboard recovers the interrupted (SYNCING) item by itself.
            check("B5. Alice's dashboard recovers her interrupted item (no longer SYNCING)",
                (await waitForQueueSettled(alice.identity)) && (await findItem(aliceItem.operationId))?.status !== "SYNCING");
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

            // ----------------------------- queue while offline (needs a valid offline session)
            check("B6. Alice's verified dashboard and offline pages are cached", await warmOfflinePages());
            check("B6. Online verification created Alice's offline session automatically (no PIN)",
                (await offlineSessions()).some((s) => s.key === keyOf(alice)));
            check("B6. (test setup) Alice's offline session record is removed", await p.eval<boolean>(DELETE_OFFLINE_SESSION(keyOf(alice))));
            const queueBeforeNoSession = (await queue()).length;
            const noSessionResult = await whileOffline(async () => ({
                reachable: await serverReachable(),
                added: await addOfflineSale(),
            }));
            check("B6. Offline simulation cuts the network for the service worker too", noSessionResult.reachable === false);
            check("B6. Without an offline session, offline queueing is refused (nothing queued)",
                !noSessionResult.added && (await queue()).length === queueBeforeNoSession);

            check("B6. Alice's next online verification re-creates the offline session without any PIN",
                (await warmOfflinePages()) && (await offlineSessions()).some((s) => s.key === keyOf(alice)));
            check("B6. The offline session record is bound to Alice and holds no PIN or secret",
                (await offlineSessions()).some((s) => s.key === keyOf(alice))
                && !/\bpin\b|salt|ciphertext/i.test(JSON.stringify(await offlineSessions())));

            await setOffline(true);
            let offlineItem: LocalItem | undefined;
            try {
                check("B6. Cold offline load of /dashboard (from the service worker cache) shows offline mode with no PIN prompt",
                    (await openDashboardOffline()) && (await p.waitForText("Offline mode")) && (await noPinFields()));
                check("B6. Queueing works while offline without any unlock step", await addOfflineSale());
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
            check("B9. ...and Alice's offline session is removed", !(await offlineSessions()).some((s) => s.key === keyOf(alice)));
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
            async function withMeResponse<T>(responseCode: number, responseBody: unknown, work: () => Promise<T>): Promise<{ result: T; intercepted: number }> {
                let intercepted = 0;
                const unsubscribe = p.on("Fetch.requestPaused", (params: { requestId: string }) => {
                    intercepted++;
                    void p.send("Fetch.fulfillRequest", {
                        requestId: params.requestId,
                        responseCode,
                        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
                        body: Buffer.from(JSON.stringify(responseBody)).toString("base64"),
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
            const withMeServerError = <T>(work: () => Promise<T>) =>
                withMeResponse(500, { success: false, message: "Simulated server error" }, work);
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

            // B13b: a SUCCESSFUL answer that lacks serverTime still verifies the session
            // (the dashboard opens) but must not create or renew the offline authorization.
            const realMe = await p.eval<Record<string, unknown>>(`fetch("/api/auth/me", { credentials: "include", cache: "no-store" }).then((r) => r.json())`);
            const meWithoutServerTime: Record<string, unknown> = { ...realMe };
            delete meWithoutServerTime.serverTime;
            const expiryBeforeNoServerTime = await expiryOf(alice);
            await sleep(1200); // a renewal would move the expiry by at least this much
            const { result: noServerTime, intercepted: interceptedNoServerTime } = await withMeResponse(200, meWithoutServerTime, async () => {
                await p.goto("/dashboard");
                return {
                    verified: await p.waitForText("Welcome to your billing and inventory system."),
                    reported: await p.waitForText("did not report its time"),
                };
            });
            check("B13. The 200 answer without serverTime was intercepted", interceptedNoServerTime >= 1, `intercepted=${interceptedNoServerTime}`);
            check("B13. A verified session without serverTime still opens the dashboard, with a message that offline access was not renewed",
                noServerTime.verified && noServerTime.reported);
            check("B13. ...and the offline session was NOT renewed", (await expiryOf(alice)) === expiryBeforeNoServerTime,
                `${expiryBeforeNoServerTime} -> ${await expiryOf(alice)}`);
            await p.goto("/dashboard");
            await p.waitForText("Welcome to your billing and inventory system.");
            check("B13. With the real answer (serverTime present) the next dashboard verification renews it",
                Boolean(expiryBeforeNoServerTime) && Date.parse((await expiryOf(alice)) ?? "") > Date.parse(expiryBeforeNoServerTime!));

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
            // Carol is a third account: Alice's newer unsynced items (not covered by the
            // last export) stop her sign-in too, until a fresh verified export is saved.
            const carolLogin = await loginThroughExport(carol, "/account");
            check("B16. Carol's sign-in is first stopped by Alice's unsynced items and succeeds after the export",
                carolLogin.blocked && carolLogin.exported !== null && carolLogin.exported.file.itemCount > 0);
            check("B16. A temporary-password user is sent to /account", carolLogin.arrived);
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

            const aliceUnsynced = async () => (await queue()).filter((i) => sameIdentity(i.owner, alice.identity) && i.status !== "SYNCED").length;

            // ------------------- B17: no PIN anywhere; temporary-password users get no offline access
            check("B17. Alice signs in again", await login(alice));
            await p.goto("/account");
            await p.waitForText("Offline access");
            check("B17. The account page shows the 72-hour expiry and has no PIN fields",
                (await p.text()).includes("Offline session expires at")
                && !(await p.eval<boolean>(`/PIN/.test(document.body.innerText) || document.querySelectorAll('section[aria-label="Offline access"] input').length > 0`)));
            const tempPwSection = await (async () => {
                // (Carol may or may not be stopped again, depending on what is already covered by an export.)
                await loginThroughExport(carol, "/account");
                await p.waitForText("Signed in as");
                return p.eval<boolean>(`Boolean(document.querySelector('section[aria-label="Offline access"]'))`);
            })();
            check("B17. A temporary-password user is not offered offline access", tempPwSection === false);
            check("B17. ...and has no offline session", !(await offlineSessions()).some((s) => s.key === keyOf(carol)));
            check("B17. Alice signs in again", await login(alice));
            await warmOfflinePages();

            // ------------------- B18: cold offline dashboard works without any unlock
            let b18Item: string | undefined;
            await whileOffline(async () => {
                check("B18. Offline: the cached dashboard loads with no PIN prompt",
                    (await openDashboardOffline()) && (await p.waitForText("Offline mode")) && (await noPinFields()));
                check("B18. The page shows the session expiry time and the number of unsynced items",
                    (await p.text()).includes("offline session expires at") && /\d+ unsynced item/.test(await p.text()));
                const before = (await queue()).length;
                check("B18. Offline work can be queued without unlocking", await addOfflineSale());
                b18Item = (await queue()).slice(-1)[0]?.operationId;
                check("B18. ...one item was queued, owned by Alice",
                    (await queue()).length === before + 1 && sameIdentity((await findItem(b18Item ?? ""))?.owner, alice.identity));
            });

            // ------------------- B19: expiry blocks new work, keeps queued sales; online renews
            const unsyncedBeforeExpiry = await aliceUnsynced();
            check("B19. Alice's offline session is aged past its 72-hour window (test setup)", await p.eval<boolean>(AGE_OFFLINE_SESSION(keyOf(alice))));
            await whileOffline(async () => {
                await openDashboardOffline();
                check("B19. Offline: the dashboard reports the expiry and that unsynced sales are safe",
                    (await p.waitForText("Your offline session expired at")) && (await p.text()).includes("are safe on this device"));
                check("B19. No PIN field is shown for an expired session", await noPinFields());
                check("B19. New offline work is blocked", !(await addOfflineSale()));
                check("B19. Queued items are preserved", (await aliceUnsynced()) === unsyncedBeforeExpiry);
            });
            // Back online with the offline session still expired: syncing and inspecting the
            // queue use the server session but must NEVER renew the offline authorization.
            const agedSession = (await offlineSessions()).find((s) => s.key === keyOf(alice));
            await sleep(1200);
            const syncWhileExpired = await syncFromDemoPage();
            await p.clickButton("Check Queue");
            await p.waitForText("Queued operations for this account:");
            const afterSyncSession = (await offlineSessions()).find((s) => s.key === keyOf(alice));
            check("B19. Sync still runs with an expired offline session (it uses the server session, not the offline one)",
                /Sync completed|No pending operations/.test(syncWhileExpired) && !syncWhileExpired.includes("Sync skipped"), syncWhileExpired.slice(-200));
            check("B19. ...but syncing and inspecting the queue did NOT renew the expired offline session",
                Boolean(agedSession) && afterSyncSession?.expiresAt === agedSession!.expiresAt
                && afterSyncSession?.lastOnlineCheckAt === agedSession!.lastOnlineCheckAt,
                JSON.stringify({ agedSession, afterSyncSession }));
            check("B19. Back online, Alice signs in", await login(alice));
            const renewed = (await offlineSessions()).find((s) => s.key === keyOf(alice));
            check("B19. The successful online check renewed the window to about 72 hours",
                Boolean(renewed) && Date.parse(renewed!.expiresAt) > Date.now() + 71 * 3600 * 1000, renewed?.expiresAt);
            await syncFromDemoPage();
            check("B19. The sale queued before expiry is uploaded under Alice",
                (await SyncOperation.findOne({ tenantId, operationId: b18Item ?? "-" }).lean())?.userId?.toString() === alice.identity.userId);

            // ------------------- B20: offline use never extends the expiry
            await warmOfflinePages();
            const queueBeforeOfflineUse = JSON.stringify(await queue());
            const expiryBeforeOffline = (await offlineSessions()).find((s) => s.key === keyOf(alice))?.expiresAt;
            const beforeOfflineOpen = Date.now(); // the test machine's clock is the browser's clock
            await whileOffline(async () => {
                await openDashboardOffline();
                await p.waitForText("Offline mode");
                await openDashboardOffline();
                check("B20. Opening the app offline repeatedly does not extend the offline expiry",
                    Boolean(expiryBeforeOffline)
                    && (await offlineSessions()).find((s) => s.key === keyOf(alice))?.expiresAt === expiryBeforeOffline);
                check("B20. Queued sales are untouched", JSON.stringify(await queue()) === queueBeforeOfflineUse);
            });
            const afterOfflineOpen = (await offlineSessions()).find((s) => s.key === keyOf(alice));
            check("B20. Offline use persisted the clock high-water mark (it moves, the expiry does not)",
                Boolean(afterOfflineOpen) && afterOfflineOpen!.clockHighWater >= beforeOfflineOpen - 1000
                && afterOfflineOpen!.expiresAt === expiryBeforeOffline,
                JSON.stringify({ beforeOfflineOpen, afterOfflineOpen }));

            // ------------------- B20a: only online verification renews; "Sync now" never does
            // Queueing, queue inspection and sync all verify the session with the server but
            // must leave the offline expiry exactly as it is.
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            const expiryBeforeQueueing = await expiryOf(alice);
            await sleep(1200); // a renewal would move the expiry by at least this much
            const queueBeforeB20a = await queue();
            await p.clickButton("Add Offline Test Sale");
            check("B20a. Alice queues one more operation while online", await p.waitForText("Operation added successfully"));
            const syncNowItem = await newItemSince(queueBeforeB20a);
            await p.clickButton("Check Queue");
            await p.waitForText("Queued operations for this account:");
            check("B20a. Online queueing and queue inspection did NOT renew the offline session",
                Boolean(syncNowItem) && (await expiryOf(alice)) === expiryBeforeQueueing,
                `${expiryBeforeQueueing} -> ${await expiryOf(alice)}`);

            await p.goto("/dashboard");
            await p.waitForText("Welcome to your billing and inventory system.");
            const expiryAfterDashboard = await expiryOf(alice);
            check("B20a. Opening the dashboard while online (a server verification) renews it",
                Boolean(expiryBeforeQueueing) && Date.parse(expiryAfterDashboard ?? "") > Date.parse(expiryBeforeQueueing!),
                `${expiryBeforeQueueing} -> ${expiryAfterDashboard}`);
            const dashboardText = await p.text();
            check("B20a. The online dashboard shows the session expiry, a Sync now action, and says syncing does not extend it",
                dashboardText.includes("Offline session expires at") && dashboardText.includes("Sync now")
                && dashboardText.includes("does not extend the offline session"));
            // The dashboard sends the waiting operation by itself (AutoSync).
            check("B20a. Opening the dashboard sends the signed-in account's waiting operation automatically",
                (await waitForQueueSettled(alice.identity))
                && Boolean(await SyncOperation.findOne({ tenantId, operationId: syncNowItem?.operationId ?? "-" }).lean()));
            await sleep(1200);
            await p.clickButton("Sync now");
            check("B20a. Sync now still runs and reports truthfully (nothing left due, or what was sent)",
                await p.waitFor(`/\\d+ of \\d+ operation\\(s\\) sent|Nothing was due to send right now|No waiting operations to send/.test(document.body.innerText)`, 30_000));
            const syncNowServerOp = await SyncOperation.findOne({ tenantId, operationId: syncNowItem?.operationId ?? "-" }).lean();
            check("B20a. ...it reached the server under Alice's own identity and kept its owner locally",
                syncNowServerOp?.userId?.toString() === alice.identity.userId
                && sameIdentity((await findItem(syncNowItem?.operationId ?? ""))?.owner, alice.identity));
            check("B20a. Neither the dashboard's automatic sync nor Sync now renewed the offline session", (await expiryOf(alice)) === expiryAfterDashboard,
                `${expiryAfterDashboard} -> ${await expiryOf(alice)}`);

            // The account page also offers Sync now, and saves a verified export without touching the queue.
            await p.goto("/account");
            await p.waitForText("Offline access");
            const accountText = await p.text();
            const accountButtons = await p.eval<string[]>(`[...document.querySelectorAll("button")].map((b) => b.innerText.trim())`);
            check("B20a. The account page shows the expiry, Sync now and the export button",
                accountText.includes("Offline session expires at") && accountButtons.includes("Sync now")
                && accountButtons.includes("Save a copy of waiting operations"));
            const queueBeforeAccountExport = await queue();
            const accountExport = await saveExportFromPage();
            await checkExportAgainstQueue("B20a", accountExport, queueBeforeAccountExport);

            // ------------------- B20b: device clock versus the server clock
            // Date.now of the page is shifted by +/-10 minutes (the server clock is not). A
            // sign-in or dashboard verification still works, but the offline session is NOT
            // renewed (more than 5 minutes apart) and the page says why.
            try {
                const expiryBeforeSkew = await expiryOf(alice);
                await sleep(1200);
                await setClockOffset(10 * 60 * 1000);
                check("B20b. With the device clock 10 minutes ahead, signing in still works", await login(alice));
                check("B20b. ...but the dashboard says offline access was not renewed because the clocks differ by more than 5 minutes",
                    await p.waitForText("more than 5 minutes"));
                check("B20b. ...and the offline session was NOT renewed", (await expiryOf(alice)) === expiryBeforeSkew,
                    `${expiryBeforeSkew} -> ${await expiryOf(alice)}`);
                await setClockOffset(-10 * 60 * 1000);
                await p.goto("/dashboard");
                check("B20b. With the device clock 10 minutes behind, the dashboard verifies the session but does not renew either",
                    (await p.waitForText("Welcome to your billing and inventory system.")) && (await p.waitForText("more than 5 minutes"))
                    && (await expiryOf(alice)) === expiryBeforeSkew);
            } finally {
                await clearClockOffset();
            }
            const expiryBeforeRecovery = await expiryOf(alice);
            await sleep(1200);
            await p.goto("/dashboard");
            check("B20b. With the correct clock the next dashboard verification renews it again and shows no clock message",
                (await p.waitForText("Welcome to your billing and inventory system."))
                && Date.parse((await expiryOf(alice)) ?? "") > Date.parse(expiryBeforeRecovery ?? "")
                && !(await p.text()).includes("more than 5 minutes"));

            // A device clock set back after offline use is detected from the persisted high-water mark.
            await warmOfflinePages();
            await whileOffline(async () => {
                await openDashboardOffline();
                await p.waitForText("Offline mode"); // offline use raises the high-water mark
            });
            const queueBeforeRollback = await queue();
            try {
                await setClockOffset(-60 * 60 * 1000);
                const rollback = await whileOffline(async () => {
                    const opened = await openDashboardOffline();
                    const message = await p.waitForText("device clock appears to have moved backwards");
                    const added = await addOfflineSale();
                    return { opened, message, added };
                });
                check("B20b. Offline with the clock set back one hour: the dashboard reports the clock problem",
                    rollback.opened && rollback.message);
                check("B20b. ...and new offline work is refused (nothing queued)",
                    !rollback.added && JSON.stringify(await queue()) === JSON.stringify(queueBeforeRollback));
            } finally {
                await clearClockOffset();
            }
            await p.goto("/dashboard");
            await p.waitForText("Welcome to your billing and inventory system."); // verified with the correct clock
            await whileOffline(async () => {
                await openDashboardOffline();
                check("B20b. After a verified online check with the correct clock, offline access works again",
                    await p.waitForText("Offline mode"));
            });

            // ------------------- B21: shared device - another user cannot use Alice's offline session
            check("B21. Alice signs in again", await login(alice));
            await waitForQueueSettled(alice.identity); // her dashboard's automatic sync
            // One more Alice item AFTER the last export, so it is not covered by any export.
            await p.goto("/offline-test");
            await p.waitForText("Network Status");
            const queueBeforeB21 = await queue();
            await p.clickButton("Add Offline Test Sale");
            await p.waitForText("Operation added successfully");
            const aliceNewerItem = await newItemSince(queueBeforeB21);
            const bobSwitch = await loginThroughExport(bob);
            check("B21. Bob signs in online on the same browser, but only after Alice's newer item was covered by a fresh verified export",
                bobSwitch.blocked && bobSwitch.arrived && bobSwitch.exported !== null
                && bobSwitch.exported.file.items.some((e) => e.operationId === aliceNewerItem?.operationId && sameIdentity(e.owner, alice.identity)),
                JSON.stringify({ blocked: bobSwitch.blocked, arrived: bobSwitch.arrived }));
            check("B21. Alice's newer item was not reassigned or uploaded for Bob (still PENDING, owner Alice)",
                (await findItem(aliceNewerItem?.operationId ?? ""))?.status === "PENDING"
                && sameIdentity((await findItem(aliceNewerItem?.operationId ?? ""))?.owner, alice.identity)
                && (await SyncOperation.countDocuments({ tenantId, operationId: aliceNewerItem?.operationId ?? "-" })) === 0);
            await warmOfflinePages();
            const bobQueueBefore = (await queue()).length;
            let bobOfflineItem: string | undefined;
            await whileOffline(async () => {
                await openDashboardOffline();
                check("B21. Offline, the dashboard shows Bob's own session (the remembered account), not Alice's",
                    await p.waitForText("Offline mode"));
                check("B21. Offline work is queued for Bob, never for Alice", await addOfflineSale());
                bobOfflineItem = (await queue()).slice(-1)[0]?.operationId;
                check("B21. ...exactly one item, owned by Bob",
                    (await queue()).length === bobQueueBefore + 1 && sameIdentity((await findItem(bobOfflineItem ?? ""))?.owner, bob.identity));
            });
            check("B21. Alice's own offline session record is still on the device (dormant)",
                (await offlineSessions()).some((s) => s.key === keyOf(alice)));

            // ------------------- B22: offline sign-out, then the server logout on reconnection
            // Bob's offline item is now an unsynced item Alice does not own: she is stopped
            // until a verified export covers it, and it stays Bob's.
            const aliceBack = await loginThroughExport(alice);
            check("B22. Alice is stopped by Bob's unsynced offline item and signs in only after a verified export",
                aliceBack.blocked && aliceBack.arrived && aliceBack.exported !== null
                && aliceBack.exported.file.items.some((e) => e.operationId === bobOfflineItem && sameIdentity(e.owner, bob.identity)),
                JSON.stringify({ blocked: aliceBack.blocked, arrived: aliceBack.arrived }));
            check("B22. Bob's offline item is still Bob's, still unsynced and was never uploaded",
                sameIdentity((await findItem(bobOfflineItem ?? ""))?.owner, bob.identity)
                && (await findItem(bobOfflineItem ?? ""))?.status !== "SYNCED"
                && (await SyncOperation.countDocuments({ tenantId, operationId: bobOfflineItem ?? "-" })) === 0);
            await warmOfflinePages();
            const activeAliceSessions = () => Session.countDocuments({
                tenantId, userId: new Types.ObjectId(alice.identity.userId), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() },
            });
            const logoutRevocations = () => Session.countDocuments({
                tenantId, userId: new Types.ObjectId(alice.identity.userId), revokedReason: "logout",
            });
            await waitForQueueSettled(alice.identity); // the dashboard's automatic sync
            const activeBefore = await activeAliceSessions();
            const logoutsBefore = await logoutRevocations();
            const queueBeforeSignOut = JSON.stringify(await queue());
            await whileOffline(async () => {
                await openDashboardOffline();
                await p.waitForText("Offline mode");
                await p.clickButton("Sign out offline");
                check("B22. Offline sign-out says the server session has NOT been ended yet",
                    await p.waitForText("The server session has NOT been ended yet"));
                check("B22. The offline session and remembered identity are removed; a server logout is pending",
                    !(await offlineSessions()).some((s) => s.key === keyOf(alice))
                    && (await p.eval(READ_IDENTITY)) === null && (await p.eval<boolean>(READ_PENDING_LOGOUT)) === true);
                check("B22. Queued sales are untouched", JSON.stringify(await queue()) === queueBeforeSignOut);
                // Measured while still offline: on reconnection the dashboard
                // completes the pending logout by itself.
                check("B22. While the device was offline the server session stayed active (not claimed as revoked)",
                    activeBefore >= 1 && (await activeAliceSessions()) === activeBefore, `${activeBefore} -> ${await activeAliceSessions()}`);
            });
            await p.goto("/dashboard");
            check("B22. On reconnection the pending logout runs and the dashboard goes to /login",
                await p.waitFor(`location.pathname === "/login"`));
            check("B22. ...the server session was revoked by that logout (exactly one more logout revocation)",
                (await activeAliceSessions()) === activeBefore - 1 && (await logoutRevocations()) === logoutsBefore + 1,
                `active ${activeBefore} -> ${await activeAliceSessions()}, logouts ${logoutsBefore} -> ${await logoutRevocations()}`);
            check("B22. ...and the pending-logout flag is cleared", (await p.eval<boolean>(READ_PENDING_LOGOUT)) === false);

            // ------------------- whole run: nothing deleted, nothing reassigned
            await queue(); // final continuity check of the queue
            check("Z1. Across every sign-in, switch, export, logout, sync and offline sign-out, no queued item was deleted or changed owner",
                ownerLedger.size >= 8 && ledgerProblems.length === 0, ledgerProblems.join("; ") || `${ownerLedger.size} items tracked`);
        }),
    });
}

main().catch((error: unknown) => {
    console.error("Offline sync browser tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
