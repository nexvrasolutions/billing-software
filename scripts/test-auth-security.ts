
/*
 * Authentication security tests: login rate limiting and server-side
 * session revocation.
 *
 * Calls the real route handlers (login, logout, logout-all, me, users,
 * sync-operations) against the database in MONGODB_URI.
 *
 * Safety:
 * - Creates two brand-new, uniquely named test tenants and deletes only
 *   their users, roles, devices, sessions, audit logs and sync records.
 * - Rate-limit counters are created only for this run's unique test emails
 *   and TEST-NET IP addresses, and are deleted at the end.
 * - Tokens and passwords are never printed.
 *
 * Run:
 *   ALLOW_AUTH_SECURITY_TESTS=YES npx tsx scripts/test-auth-security.ts
 */

import { loadEnvConfig } from "@next/env";
import { assertTestDatabaseUri } from "./lib/testDatabaseGuard";
import { spawnSync } from "child_process";
import path from "path";

loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

type Json = Record<string, unknown> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
};

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

/**
 * Child mode: a separate Node process (a second "application instance")
 * checks tokens passed via environment variables and prints only statuses.
 */
async function childCheck() {
    // Child mode skips main(): check the database here as well.
    assertTestDatabaseUri(process.env.MONGODB_URI);
    const mongoose = (await import("mongoose")).default;
    const { NextRequest } = await import("next/server");
    const meRoute = await import("../app/api/auth/me/route");
    const statuses: number[] = [];

    for (const name of ["AUTH_TEST_TOKEN_1", "AUTH_TEST_TOKEN_2"]) {
        const token = process.env[name] ?? "";
        const request = new NextRequest(new URL("/api/auth/me", "http://localhost:3000"), {
            headers: { cookie: `session=${token}` },
        });
        statuses.push((await meRoute.GET(request)).status);
    }

    console.log(`CHILD_STATUSES=${statuses.join(",")}`);
    await mongoose.disconnect();
}

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Refusing to run in production.");
    }

    if (process.env.ALLOW_AUTH_SECURITY_TESTS !== "YES") {
        throw new Error(
            "Set ALLOW_AUTH_SECURITY_TESTS=YES after confirming MONGODB_URI is a development database."
        );
    }
    // Only the dedicated test database, checked before anything connects.
    assertTestDatabaseUri(process.env.MONGODB_URI);

    // Use the documented default limits; only the trusted IP header is set.
    for (const name of [
        "LOGIN_RATE_LIMIT_WINDOW_SECONDS",
        "LOGIN_RATE_LIMIT_IP_MAX",
        "LOGIN_RATE_LIMIT_ACCOUNT_IP_MAX",
        "LOGIN_RATE_LIMIT_ACCOUNT_MAX",
        "LOGIN_LOCKOUT_BASE_SECONDS",
        "LOGIN_LOCKOUT_MAX_SECONDS",
    ]) {
        delete process.env[name];
    }
    process.env.LOGIN_TRUSTED_IP_HEADER = "x-forwarded-for";

    const mongoose = (await import("mongoose")).default;
    type Types = typeof mongoose.Types;
    const { NextRequest } = await import("next/server");
    const { SignJWT, decodeJwt } = await import("jose");
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Device } = await import("../lib/models/Device");
    const { AuditLog } = await import("../lib/models/AuditLog");
    const { Session } = await import("../lib/models/Session");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { LoginRateLimit } = await import("../lib/models/LoginRateLimit");
    const { TenantAdminGuard } = await import("../lib/models/TenantAdminGuard");
    const { hashPassword } = await import("../app/api/auth/password");
    const { createSessionToken } = await import("../app/api/auth/session");
    const { hashSessionId } = await import("../lib/auth/sessionStore");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");
    const loginRoute = await import("../app/api/auth/login/route");
    const logoutRoute = await import("../app/api/auth/logout/route");
    const logoutAllRoute = await import("../app/api/auth/logout-all/route");
    const meRoute = await import("../app/api/auth/me/route");
    const usersRoute = await import("../app/api/users/route");
    const syncRoute = await import("../app/api/sync-operations/route");

    type ObjectId = InstanceType<Types["ObjectId"]>;

    await connectDB();

    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const createdTenantIds: ObjectId[] = [];
    const subjects: { ip: string | null; email: string }[] = [];
    let ipCounter = 0;
    const base = Math.floor(Math.random() * 200);

    // Unique TEST-NET addresses (RFC 5737) for this run.
    function nextIp() {
        ipCounter++;
        const octet3 = (base + Math.floor(ipCounter / 250)) % 256;
        return `198.51.${octet3}.${(ipCounter % 250) + 1}`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Handler = (request: any, context?: any) => Promise<Response>;

    async function call(
        handler: Handler,
        options: { method?: string; path: string; token?: string; body?: unknown; rawBody?: string; ip?: string }
    ): Promise<{ status: number; json: Json; headers: Headers }> {
        const headers = new Headers({ "content-type": "application/json" });
        if (options.token) headers.set("cookie", `session=${options.token}`);
        if (options.ip) headers.set("x-forwarded-for", options.ip);

        const request = new NextRequest(new URL(options.path, "http://localhost:3000"), {
            method: options.method ?? "GET",
            headers,
            body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        });

        const response = await handler(request);
        const text = await response.text();
        let json: Json = {};
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        return { status: response.status, json, headers: response.headers };
    }

    function cookieToken(headers: Headers): string {
        const match = /(?:^|,\s*)session=([^;]*)/.exec(headers.get("set-cookie") ?? "");
        return match?.[1] ?? "";
    }

    const login = (email: string, password: string, deviceId: string, ip?: string) => {
        subjects.push({ ip: ip ?? null, email: email.trim().toLowerCase() });
        return call(loginRoute.POST, { method: "POST", path: "/api/auth/login", body: { email, password, deviceId }, ip });
    };
    const me = (token: string) => call(meRoute.GET, { path: "/api/auth/me", token });
    const listUsers = (token: string) => call(usersRoute.GET, { path: "/api/users", token });
    const logout = (token?: string) => call(logoutRoute.POST, { method: "POST", path: "/api/auth/logout", token });
    const logoutAll = (token?: string) => call(logoutAllRoute.POST, { method: "POST", path: "/api/auth/logout-all", token });
    const noInternals = (json: Json) => !/mongo|stack|E11000|ObjectId|jwt|jose|Error:/i.test(JSON.stringify(json));

    const originalFind = LoginRateLimit.find;
    const originalFindOneAndUpdate = LoginRateLimit.findOneAndUpdate;

    try {
        // ------------------------------------------------------------ fixtures
        const permissions = await Permission.find({ name: { $in: ["users.read", "users.create", "users.update", "users.delete"] } })
            .select("_id")
            .lean();
        if (permissions.length !== 4) throw new Error("users.* permissions missing");

        const tenantA = (await Tenant.create({ name: `AUTH-TEST-A-${suffix}`, status: "active" }))._id as ObjectId;
        const tenantB = (await Tenant.create({ name: `AUTH-TEST-B-${suffix}`, status: "active" }))._id as ObjectId;
        createdTenantIds.push(tenantA, tenantB);

        const adminRoleA = (await Role.create({ tenantId: tenantA, name: "Admin", permissions: permissions.map((p) => p._id) }))._id as ObjectId;
        const readerRoleB = (await Role.create({ tenantId: tenantB, name: "Reader", permissions: [permissions[0]._id] }))._id as ObjectId;

        const password = `Auth-Test-${suffix}-Pass!`;
        const passwordHash = await hashPassword(password);

        async function makeUser(tenantId: ObjectId, label: string, roleId: ObjectId, deviceCount = 1) {
            const email = `${label}-${suffix}@example.invalid`;
            const user = await User.create({ tenantId, name: `Test ${label}`, email, passwordHash, roleId, status: "active" });
            const devices: string[] = [];
            const deviceDocIds: string[] = [];
            for (let i = 1; i <= deviceCount; i++) {
                const device = await Device.create({
                    tenantId, userId: user._id, deviceName: `${label} device ${i}`, deviceType: "desktop",
                    deviceId: `auth-${label}-${i}-${suffix}`, status: "active",
                });
                devices.push(device.deviceId);
                deviceDocIds.push(device._id.toString());
            }
            return { id: user._id.toString(), email, devices, deviceDocIds };
        }

        const rlA = await makeUser(tenantA, "rl-a", adminRoleA);
        const rlB = await makeUser(tenantA, "rl-b", adminRoleA);
        const rlC = await makeUser(tenantA, "rl-c", adminRoleA);
        const rlD = await makeUser(tenantA, "rl-d", adminRoleA);
        const rlE = await makeUser(tenantA, "rl-e", adminRoleA);
        const sUser = await makeUser(tenantA, "session-user", adminRoleA, 2);
        const other = await makeUser(tenantB, "other-user", readerRoleB);

        // =============================================== RATE LIMITING
        // --- per account + IP
        const ipA = nextIp();
        const accountIpStatuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            accountIpStatuses.push((await login(rlA.email, "Wrong-Password-1", rlA.devices[0], ipA)).status);
        }
        check("RL1. First 5 wrong passwords return 401", accountIpStatuses.every((s) => s === 401), accountIpStatuses.join(","));
        const limited = await login(rlA.email, "Wrong-Password-1", rlA.devices[0], ipA);
        const retryAfter = Number(limited.headers.get("retry-after"));
        check("RL1. 6th attempt from same IP/account returns 429", limited.status === 429, String(limited.status));
        check("RL1. 429 has Retry-After within the 60s first lockout", retryAfter >= 1 && retryAfter <= 60, String(retryAfter));
        check("RL1. 429 body is generic and safe", limited.json.message === "Too many login attempts. Please wait and try again." && noInternals(limited.json));
        const lockedCorrect = await login(rlA.email, password, rlA.devices[0], ipA);
        check("RL1. Correct password also refused while locked (checked before hashing)", lockedCorrect.status === 429 && !cookieToken(lockedCorrect.headers));

        // Progressive lockout: expire the lock, fail 5 more times -> longer lock.
        const [accountIpBucket] = getLoginBuckets({ ip: ipA, email: rlA.email });
        await LoginRateLimit.updateOne({ key: accountIpBucket.key }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
        for (let i = 0; i < 5; i++) await login(rlA.email, "Wrong-Password-1", rlA.devices[0], ipA);
        const secondLock = await login(rlA.email, "Wrong-Password-1", rlA.devices[0], ipA);
        const secondRetry = Number(secondLock.headers.get("retry-after"));
        check("RL1. Repeat offence gets a longer (progressive) lockout", secondLock.status === 429 && secondRetry > 60 && secondRetry <= 120, `${secondLock.status} retry=${secondRetry}`);

        // --- per account across IPs
        const accountStatuses: number[] = [];
        for (let i = 0; i < 25; i++) {
            accountStatuses.push((await login(rlB.email, "Wrong-Password-1", rlB.devices[0], nextIp())).status);
        }
        check("RL2. 25 failures spread over 25 IPs each return 401", accountStatuses.every((s) => s === 401), accountStatuses.join(","));
        const fromNewIp = await login(rlB.email, password, rlB.devices[0], nextIp());
        check("RL2. A new IP does not bypass the account-wide limit (429)", fromNewIp.status === 429 && Boolean(fromNewIp.headers.get("retry-after")), String(fromNewIp.status));

        // --- per IP across accounts
        const ipC = nextIp();
        const sprayStatuses: number[] = [];
        for (let i = 0; i < 30; i++) {
            sprayStatuses.push((await login(`nobody-${i}-${suffix}@example.invalid`, "Wrong-Password-1", "none", ipC)).status);
        }
        check("RL3. 30 failures for different accounts from one IP return 401", sprayStatuses.every((s) => s === 401), sprayStatuses.join(","));
        const ipLocked = await login(rlC.email, password, rlC.devices[0], ipC);
        check("RL3. That IP is then limited even for another valid account (429)", ipLocked.status === 429, String(ipLocked.status));
        const otherIpOk = await login(rlC.email, password, rlC.devices[0], nextIp());
        check("RL3. Same valid account from a different IP still logs in (200)", otherIpOk.status === 200, String(otherIpOk.status));

        // --- success resets account counters
        const ipD = nextIp();
        for (let i = 0; i < 4; i++) await login(rlD.email, "Wrong-Password-1", rlD.devices[0], ipD);
        const dSuccess = await login(rlD.email, password, rlD.devices[0], ipD);
        check("RL4. Correct password after 4 failures succeeds (200)", dSuccess.status === 200);
        const afterReset: number[] = [];
        for (let i = 0; i < 4; i++) afterReset.push((await login(rlD.email, "Wrong-Password-1", rlD.devices[0], ipD)).status);
        check("RL4. Successful login reset the account counters (4 new failures not limited)", afterReset.every((s) => s === 401), afterReset.join(","));

        // --- account existence not revealed
        const unknown = await login(`ghost-${suffix}@example.invalid`, "Wrong-Password-1", "x", nextIp());
        const wrongPw = await login(rlD.email, "Wrong-Password-2", rlD.devices[0], nextIp());
        check(
            "RL5. Unknown email and wrong password give identical responses",
            unknown.status === 401 && wrongPw.status === 401 && JSON.stringify(unknown.json) === JSON.stringify(wrongPw.json),
            `${unknown.status} ${JSON.stringify(unknown.json)} vs ${wrongPw.status} ${JSON.stringify(wrongPw.json)}`
        );

        // --- input validation
        const loginRaw = (rawBody: string) => call(loginRoute.POST, { method: "POST", path: "/api/auth/login", rawBody, ip: nextIp() });
        check("RL6. Malformed JSON returns 400", (await loginRaw("{bad json")).status === 400);
        check("RL6. Empty body returns 400", (await loginRaw("")).status === 400);
        check("RL6. Non-string password returns 400", (await loginRaw(JSON.stringify({ email: rlD.email, password: 12345678, deviceId: "x" }))).status === 400);
        check("RL6. Password over 128 characters returns 400", (await loginRaw(JSON.stringify({ email: rlD.email, password: "a".repeat(129), deviceId: "x" }))).status === 400);
        check("RL6. Missing deviceId returns 400", (await loginRaw(JSON.stringify({ email: rlD.email, password }))).status === 400);
        check("RL6. Array body returns 400", (await loginRaw("[]")).status === 400);

        // --- store failure fails closed
        LoginRateLimit.find = (() => { throw new Error("simulated store outage"); }) as unknown as typeof LoginRateLimit.find;
        const outage = await login(rlD.email, password, rlD.devices[0], nextIp());
        LoginRateLimit.find = originalFind;
        check("RL7. Rate-limit store outage refuses login (503, fail closed)", outage.status === 503 && !cookieToken(outage.headers), String(outage.status));
        check("RL7. Outage response has Retry-After and no internals", Boolean(outage.headers.get("retry-after")) && noInternals(outage.json));

        LoginRateLimit.findOneAndUpdate = (() => { throw new Error("simulated store outage"); }) as unknown as typeof LoginRateLimit.findOneAndUpdate;
        const recordOutage = await login(rlD.email, "Wrong-Password-1", rlD.devices[0], nextIp());
        LoginRateLimit.findOneAndUpdate = originalFindOneAndUpdate;
        check("RL7. Failure that cannot be recorded is refused (503), not silently allowed", recordOutage.status === 503, String(recordOutage.status));

        // --- untrusted forwarding headers are ignored
        delete process.env.LOGIN_TRUSTED_IP_HEADER;
        const spoofStatuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            spoofStatuses.push((await login(rlE.email, "Wrong-Password-1", rlE.devices[0], nextIp())).status);
        }
        const spoofed = await login(rlE.email, password, rlE.devices[0], nextIp());
        process.env.LOGIN_TRUSTED_IP_HEADER = "x-forwarded-for";
        check(
            "RL8. Without a trusted header, rotating X-Forwarded-For does not bypass limits (429)",
            spoofStatuses.every((s) => s === 401) && spoofed.status === 429,
            `${spoofStatuses.join(",")} then ${spoofed.status}`
        );
        // These attempts were recorded under ip=null.
        subjects.push({ ip: null, email: rlE.email });

        // ============================================== SESSIONS
        const s1 = await login(sUser.email, password, sUser.devices[0], nextIp());
        const t1 = cookieToken(s1.headers);
        check("S1. Login succeeds and sets a session cookie", s1.status === 200 && t1.length > 0);
        const setCookie = (s1.headers.get("set-cookie") ?? "").toLowerCase();
        check(
            "S1. Cookie is HttpOnly, SameSite=Lax, Path=/, 24-hour Max-Age (Secure only in production)",
            setCookie.includes("httponly") && setCookie.includes("samesite=lax") && setCookie.includes("path=/") &&
            setCookie.includes(`max-age=${24 * 60 * 60}`) && !setCookie.includes("secure")
        );
        check("S1. /api/auth/me works with the session (200)", (await me(t1)).status === 200);
        check("S1. Protected API works with the session (200)", (await listUsers(t1)).status === 200);

        const sid = String(decodeJwt(t1).sid ?? "");
        const sessionDoc = await Session.findOne({ tokenHash: hashSessionId(sid) }).lean();
        const sessionCollectionJson = JSON.stringify(await Session.find({ tenantId: tenantA }).lean());
        check("S2. Session ID is long and random (>= 43 chars base64url)", /^[A-Za-z0-9_-]{43,}$/.test(sid));
        check(
            "S2. Database stores only the SHA-256 hash, never the raw ID or token",
            Boolean(sessionDoc) && /^[a-f0-9]{64}$/.test(sessionDoc!.tokenHash) &&
            !sessionCollectionJson.includes(sid) && !sessionCollectionJson.includes(t1)
        );

        const t2 = cookieToken((await login(sUser.email, password, sUser.devices[1], nextIp())).headers);
        const tOther = cookieToken((await login(other.email, password, other.devices[0], nextIp())).headers);
        check("S3. Second session and unrelated user's session work", (await me(t2)).status === 200 && (await me(tOther)).status === 200);

        const out = await logout(t1);
        check("S4. Logout succeeds and clears the cookie", out.status === 200 && /session=;/.test(out.headers.get("set-cookie") ?? ""));
        check("S4. Session is revoked server-side (revokedAt set)", Boolean((await Session.findOne({ tokenHash: hashSessionId(sid) }).lean())?.revokedAt));
        check("S4. Copied token after logout: /api/auth/me returns 401", (await me(t1)).status === 401);
        check("S4. Copied token after logout: protected API returns 401", (await listUsers(t1)).status === 401);
        check("S4. Copied token after logout: offline sync upload returns 401", (await call(syncRoute.POST, { method: "POST", path: "/api/sync-operations", token: t1, body: {} })).status === 401);
        check("S5. User's other session is unaffected (200)", (await me(t2)).status === 200);
        check("S5. Unrelated user's session is unaffected (200)", (await me(tOther)).status === 200);

        // Restart: drop the connection and cache, reconnect, re-check.
        await mongoose.disconnect();
        global._mongooseCache = undefined;
        await connectDB();
        check("S6. Revocation survives a reconnect/restart (401)", (await me(t1)).status === 401);

        // A genuinely separate Node process acting as another app instance.
        const child = spawnSync(
            process.execPath,
            [path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), process.argv[1], "--child-check"],
            {
                env: { ...process.env, AUTH_TEST_TOKEN_1: t1, AUTH_TEST_TOKEN_2: t2 },
                encoding: "utf8",
                timeout: 120000,
            }
        );
        const childStatuses = /CHILD_STATUSES=([\d,]+)/.exec(child.stdout ?? "")?.[1];
        check(
            "S6. Separate process (other instance) sees revoked=401, active=200",
            childStatuses === "401,200",
            `child output: ${childStatuses ?? "none"} exit=${child.status}`
        );

        // Expiry is enforced by the database record, not only the JWT.
        const sid2 = String(decodeJwt(t2).sid ?? "");
        await Session.updateOne({ tokenHash: hashSessionId(sid2) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        check("S7. Expired server-side session is rejected (401)", (await me(t2)).status === 401);

        // Logout everywhere.
        const t3 = cookieToken((await login(sUser.email, password, sUser.devices[0], nextIp())).headers);
        const t4 = cookieToken((await login(sUser.email, password, sUser.devices[1], nextIp())).headers);
        check("S8. Logout-all requires authentication (401)", (await logoutAll()).status === 401);
        const all = await logoutAll(t3);
        check("S8. Logout-all succeeds", all.status === 200 && all.json.revokedSessions === 2, JSON.stringify(all.json));
        check("S8. All of the user's sessions are revoked (401, 401)", (await me(t3)).status === 401 && (await me(t4)).status === 401);
        check("S8. Other users' sessions are untouched (200)", (await me(tOther)).status === 200);

        // Account/tenant/device/role deactivation still block.
        const t5 = cookieToken((await login(sUser.email, password, sUser.devices[0], nextIp())).headers);
        await Device.updateOne({ _id: sUser.deviceDocIds[0] }, { $set: { status: "inactive" } });
        check("S9. Deactivated device is blocked (401)", (await listUsers(t5)).status === 401);
        await Device.updateOne({ _id: sUser.deviceDocIds[0] }, { $set: { status: "active" } });
        await Tenant.updateOne({ _id: tenantA }, { $set: { status: "inactive" } });
        check("S9. Deactivated tenant is blocked (401)", (await listUsers(t5)).status === 401);
        await Tenant.updateOne({ _id: tenantA }, { $set: { status: "active" } });
        await Role.updateOne({ _id: adminRoleA }, { $set: { status: "inactive" } });
        check("S9. Inactive role is denied (403)", (await listUsers(t5)).status === 403);
        await Role.updateOne({ _id: adminRoleA }, { $set: { status: "active" } });
        await User.updateOne({ _id: sUser.id }, { $set: { status: "inactive" } });
        check("S9. Deactivated user is blocked (401)", (await listUsers(t5)).status === 401);
        await User.updateOne({ _id: sUser.id }, { $set: { status: "active" } });
        check("S9. Session works again once everything is re-activated (200)", (await listUsers(t5)).status === 200);

        // Forged / invalid tokens.
        const wrongKey = new TextEncoder().encode("x".repeat(64));
        const forgedSigned = await new SignJWT({ sid, userId: sUser.id, tenantId: tenantA.toString(), deviceId: sUser.deviceDocIds[0] })
            .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(wrongKey);
        const exp = new Date(Date.now() + 3600 * 1000);
        const legacy = await createSessionToken({ userId: sUser.id, tenantId: tenantA.toString(), deviceId: sUser.deviceDocIds[0] } as never, exp);
        const unknownSid = await createSessionToken({ sid: "unknown-session-id-value-that-does-not-exist", userId: sUser.id, tenantId: tenantA.toString(), deviceId: sUser.deviceDocIds[0] }, exp);
        const sid5 = String(decodeJwt(t5).sid ?? "");
        const mismatched = await createSessionToken({ sid: sid5, userId: other.id, tenantId: tenantB.toString(), deviceId: other.deviceDocIds[0] }, exp);
        const badIds = await createSessionToken({ sid: sid5, userId: "not-an-id", tenantId: "$where", deviceId: "{}" }, exp);
        const algNone = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sid: sid5, userId: sUser.id, tenantId: tenantA.toString(), deviceId: sUser.deviceDocIds[0] })).toString("base64url")}.`;
        for (const [label, token] of [
            ["garbage string", "not-a-token"],
            ["token signed with a different key", forgedSigned],
            ["unsigned (alg=none) token", algNone],
            ["legacy token without session ID", legacy],
            ["validly signed token naming an unknown session", unknownSid],
            ["real session ID combined with another user's identity", mismatched],
            ["validly signed token with malformed IDs", badIds],
        ] as const) {
            const meRes = await me(token);
            const usersRes = await listUsers(token);
            check(`S10. ${label}: 401 with no internals`, meRes.status === 401 && usersRes.status === 401 && noInternals(meRes.json) && noInternals(usersRes.json), `${meRes.status}/${usersRes.status}`);
        }
        check("S10. Mismatched-identity attempt did not revoke or affect the real session (200)", (await me(t5)).status === 200);

        // Logout with no / forged token is harmless and revokes nothing.
        const sessionsBefore = await Session.countDocuments({ tenantId: { $in: createdTenantIds }, revokedAt: { $exists: false } });
        check("S11. Logout without a session cookie still returns 200", (await logout()).status === 200);
        check("S11. Logout with a forged token returns 200", (await logout(forgedSigned)).status === 200);
        const sessionsAfter = await Session.countDocuments({ tenantId: { $in: createdTenantIds }, revokedAt: { $exists: false } });
        check("S11. Forged logouts revoked no sessions", sessionsBefore === sessionsAfter, `${sessionsBefore} -> ${sessionsAfter}`);

        // Offline sync still authenticates with a valid session (auth passes;
        // the empty body is then rejected by validation, so nothing is written).
        const syncValid = await call(syncRoute.POST, { method: "POST", path: "/api/sync-operations", token: t5, body: {} });
        check("R1. Offline sync endpoint accepts a valid session (not 401)", syncValid.status !== 401, String(syncValid.status));
    } finally {
        LoginRateLimit.find = originalFind;
        LoginRateLimit.findOneAndUpdate = originalFindOneAndUpdate;

        const bucketKeys = new Set<string>();
        for (const subject of subjects) {
            for (const bucket of getLoginBuckets(subject)) bucketKeys.add(bucket.key);
        }
        await LoginRateLimit.deleteMany({ key: { $in: [...bucketKeys] } });

        if (createdTenantIds.length) {
            const filter = { tenantId: { $in: createdTenantIds } };
            await Promise.all([
                User.deleteMany(filter),
                Role.deleteMany(filter),
                Device.deleteMany(filter),
                Session.deleteMany(filter),
                AuditLog.deleteMany(filter),
                SyncOperation.deleteMany(filter),
                TenantAdminGuard.deleteMany(filter),
            ]);
            await Tenant.deleteMany({ _id: { $in: createdTenantIds } });
        }

        console.log(`\nCleaned up ${createdTenantIds.length} test tenants, their sessions and ${bucketKeys.size} rate-limit counters.`);
        await mongoose.disconnect();
    }

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

    if (failed.length) {
        console.log("Failed checks:");
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
        process.exitCode = 1;
    }
}

const run = process.argv.includes("--child-check") ? childCheck : main;

run().catch((error: unknown) => {
    console.error("Auth security tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
