
/*
 * Password change / admin password reset tests.
 *
 * Calls the real route handlers against the database in MONGODB_URI using
 * two brand-new test tenants; only their records (and this run's
 * rate-limit counters) are deleted afterwards. Passwords and tokens are
 * never printed.
 *
 * Run:
 *   ALLOW_PASSWORD_TESTS=YES npx tsx scripts/test-password-management.ts
 */

import { loadEnvConfig } from "@next/env";

import { runTestSafely } from "./lib/testRunSafety";

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

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    return failed.length === 0;
}

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Refusing to run in production.");
    }

    if (process.env.ALLOW_PASSWORD_TESTS !== "YES") {
        throw new Error("Set ALLOW_PASSWORD_TESTS=YES after confirming MONGODB_URI is a development database.");
    }

    process.env.LOGIN_TRUSTED_IP_HEADER = "x-forwarded-for";

    const mongoose = (await import("mongoose")).default;
    const { NextRequest } = await import("next/server");
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Device } = await import("../lib/models/Device");
    const { AuditLog } = await import("../lib/models/AuditLog");
    const { hashPassword } = await import("../app/api/auth/password");
    const { createUserSession } = await import("../lib/auth/sessionStore");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");
    const loginRoute = await import("../app/api/auth/login/route");
    const meRoute = await import("../app/api/auth/me/route");
    const changeRoute = await import("../app/api/auth/change-password/route");
    const resetRoute = await import("../app/api/users/[id]/password/route");

    type ObjectId = InstanceType<typeof mongoose.Types.ObjectId>;

    await runTestSafely({
        name: "Password management tests",
        tenantNamePrefix: "PW-TEST-",
        overallTimeoutMs: 180_000,
        summarize,
        run: async (run) => {
            await connectDB();

            const suffix = run.runId;
            // Register rate-limit counter keys BEFORE each request creates them.
            const registerAttempt = (ip: string | null, email: string) =>
                run.addRateLimitKeys(getLoginBuckets({ ip, email }).map((bucket) => bucket.key));
            let ipCounter = 0;
            const ipBase = Math.floor(Math.random() * 200);
            const nextIp = () => `203.0.${(ipBase + Math.floor(++ipCounter / 250)) % 256}.${(ipCounter % 250) + 1}`;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type Handler = (request: any, context?: any) => Promise<Response>;

            async function call(
                handler: Handler,
                options: { method?: string; path: string; token?: string; body?: unknown; rawBody?: string; ip?: string; params?: Record<string, string> }
            ): Promise<{ status: number; json: Json; headers: Headers; text: string }> {
                const headers = new Headers({ "content-type": "application/json" });
                if (options.token) headers.set("cookie", `session=${options.token}`);
                if (options.ip) headers.set("x-forwarded-for", options.ip);
                const request = new NextRequest(new URL(options.path, "http://localhost:3000"), {
                    method: options.method ?? "GET",
                    headers,
                    body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
                });
                const response = options.params
                    ? await handler(request, { params: Promise.resolve(options.params) })
                    : await handler(request);
                const text = await response.text();
                let json: Json = {};
                try { json = JSON.parse(text); } catch { /* non-JSON */ }
                return { status: response.status, json, headers: response.headers, text };
            }

            const cookieToken = (headers: Headers) => /(?:^|,\s*)session=([^;]*)/.exec(headers.get("set-cookie") ?? "")?.[1] ?? "";
            const me = (token: string) => call(meRoute.GET, { path: "/api/auth/me", token });
            const login = (email: string, password: string, deviceId: string) => {
                const ip = nextIp();
                registerAttempt(ip, email);
                return call(loginRoute.POST, { method: "POST", path: "/api/auth/login", body: { email, password, deviceId }, ip });
            };
            const change = (token: string | undefined, body: unknown, ip?: string, rawBody?: string) =>
                call(changeRoute.POST, { method: "POST", path: "/api/auth/change-password", token, body, ip, rawBody });
            const reset = (token: string | undefined, id: string, body: unknown, rawBody?: string) =>
                call(resetRoute.POST, { method: "POST", path: `/api/users/${id}/password`, token, body, rawBody, params: { id } });

            const responseTexts: string[] = [];
            const track = <T extends { text: string }>(r: T) => { responseTexts.push(r.text); return r; };

            {
                const perms = await Permission.find({ name: { $in: ["users.read", "users.create", "users.update", "users.delete", "products.read"] } })
                    .select("_id name").lean();
                const perm = (name: string) => {
                    const found = perms.find((p) => p.name === name);
                    if (!found) throw new Error(`Missing permission ${name}`);
                    return found._id as ObjectId;
                };
                const usersAll = ["users.read", "users.create", "users.update", "users.delete"].map(perm);

                const tenantA = run.newTenantId(); // registered before insert
                await Tenant.create({ _id: tenantA, name: run.tenantName("A"), status: "active" });
                const tenantB = run.newTenantId(); // registered before insert
                await Tenant.create({ _id: tenantB, name: run.tenantName("B"), status: "active" });

                const adminRole = (await Role.create({ tenantId: tenantA, name: "Admin", permissions: [...usersAll, perm("products.read")] }))._id as ObjectId;
                const readerRole = (await Role.create({ tenantId: tenantA, name: "Reader", permissions: [perm("users.read")] }))._id as ObjectId;
                const cashierRole = (await Role.create({ tenantId: tenantA, name: "Cashier", permissions: [perm("products.read")] }))._id as ObjectId;
                const adminRoleB = (await Role.create({ tenantId: tenantB, name: "Admin", permissions: usersAll }))._id as ObjectId;

                const oldPassword = `Old-Pass-${suffix}-A1!`;
                const newPassword = `New-Pass-${suffix}-B2!`;
                const oldHash = await hashPassword(oldPassword);

                async function makeUser(tenantId: ObjectId, label: string, roleId: ObjectId, devices = 1) {
                    const email = `${label}-${suffix}@example.invalid`;
                    const user = await User.create({ tenantId, name: `Test ${label}`, email, passwordHash: oldHash, roleId, status: "active" });
                    const deviceIds: string[] = [];
                    const deviceDocIds: string[] = [];
                    for (let i = 1; i <= devices; i++) {
                        const device = await Device.create({ tenantId, userId: user._id, deviceName: `${label} ${i}`, deviceType: "desktop", deviceId: `pw-${label}-${i}-${suffix}`, status: "active" });
                        deviceIds.push(device.deviceId);
                        deviceDocIds.push(device._id.toString());
                    }
                    const session = async (deviceIndex = 0) =>
                        (await createUserSession({ userId: user._id.toString(), tenantId: tenantId.toString(), deviceId: deviceDocIds[deviceIndex], roleId: roleId.toString() })).token;
                    return { id: user._id.toString(), email, deviceIds, deviceDocIds, session };
                }

                const owner = await makeUser(tenantA, "owner", adminRole);
                const manager = await makeUser(tenantA, "manager", adminRole);   // ordinary admin, not owner
                const reader = await makeUser(tenantA, "reader", readerRole);
                const cashier = await makeUser(tenantA, "cashier", cashierRole, 2);
                const changer = await makeUser(tenantA, "changer", cashierRole, 2);
                const guesser = await makeUser(tenantA, "guesser", cashierRole);
                const ownerB = await makeUser(tenantB, "owner-b", adminRoleB);
                await Tenant.updateOne({ _id: tenantA }, { $set: { ownerUserId: new mongoose.Types.ObjectId(owner.id) } });
                await Tenant.updateOne({ _id: tenantB }, { $set: { ownerUserId: new mongoose.Types.ObjectId(ownerB.id) } });

                // ===================================================== CHANGE PASSWORD
                check("C1. Change password requires authentication (401)", track(await change(undefined, { currentPassword: oldPassword, newPassword })).status === 401);

                const changerT1 = await changer.session(0);
                const changerT2 = await changer.session(1);
                check("C2. Malformed JSON rejected (400)", track(await change(changerT1, undefined, nextIp(), "{bad")).status === 400);
                check("C2. New password under 12 characters rejected (400)", track(await change(changerT1, { currentPassword: oldPassword, newPassword: "short" })).status === 400);
                check("C2. New password equal to current rejected (400)", track(await change(changerT1, { currentPassword: oldPassword, newPassword: oldPassword })).status === 400);
                check("C2. Unknown fields (e.g. userId) rejected (400)", track(await change(changerT1, { currentPassword: oldPassword, newPassword, userId: owner.id })).status === 400);
                const wrongIp = nextIp();
                registerAttempt(wrongIp, changer.email);
                const wrong = track(await change(changerT1, { currentPassword: "Not-The-Password-1", newPassword }, wrongIp));
                check("C3. Wrong current password rejected (400) and nothing changed", wrong.status === 400 && (await User.findById(changer.id).lean())?.passwordHash === oldHash);

                const changed = track(await change(changerT1, { currentPassword: oldPassword, newPassword }, nextIp()));
                const freshToken = cookieToken(changed.headers);
                check("C4. Correct current password changes it (200) and issues a new session cookie", changed.status === 200 && freshToken.length > 0 && freshToken !== changerT1, JSON.stringify(changed.json));
                const storedHash = (await User.findById(changer.id).lean())?.passwordHash ?? "";
                check("C4. New password stored as a new argon2id hash", storedHash !== oldHash && storedHash.startsWith("$argon2id$"));
                check("C4. Old token used for the change is revoked (401)", (await me(changerT1)).status === 401);
                check("C4. Session on another device is revoked (401)", (await me(changerT2)).status === 401);
                check("C4. New session cookie works (200)", (await me(freshToken)).status === 200);
                check("C4. Login with the old password fails (401)", track(await login(changer.email, oldPassword, changer.deviceIds[0])).status === 401);
                check("C4. Login with the new password succeeds (200)", track(await login(changer.email, newPassword, changer.deviceIds[0])).status === 200);
                const changeAudit = await AuditLog.findOne({ tenantId: tenantA, action: "user.password_changed", entityId: new mongoose.Types.ObjectId(changer.id) }).lean();
                check("C5. Password change is audited (actor = user, sessions revoked count)", changeAudit?.userId.toString() === changer.id && changeAudit?.newValues?.revokedSessions === 2, JSON.stringify(changeAudit?.newValues));

                // Brute-forcing the current password through a valid session is rate limited.
                const guesserToken = await guesser.session();
                const guessIp = nextIp();
                registerAttempt(guessIp, guesser.email);
                const guessStatuses: number[] = [];
                for (let i = 0; i < 6; i++) {
                    guessStatuses.push(track(await change(guesserToken, { currentPassword: `Wrong-Guess-${i}-xx`, newPassword }, guessIp)).status);
                }
                const correctWhileLocked = track(await change(guesserToken, { currentPassword: oldPassword, newPassword }, guessIp));
                check(
                    "C6. Repeated wrong current passwords are rate limited (5x 400, then 429 with Retry-After)",
                    guessStatuses.slice(0, 5).every((s) => s === 400) && guessStatuses[5] === 429 && correctWhileLocked.status === 429 && Boolean(correctWhileLocked.headers.get("retry-after")),
                    guessStatuses.join(",") + ` then ${correctWhileLocked.status}`
                );
                check("C6. Password unchanged while locked", (await User.findById(guesser.id).lean())?.passwordHash === oldHash);

                // ======================================================= ADMIN RESET
                const ownerToken = await owner.session();
                const managerToken = await manager.session();
                const readerToken = await reader.session();
                const cashierT1 = await cashier.session(0);
                const cashierT2 = await cashier.session(1);

                check("R1. Reset requires authentication (401)", track(await reset(undefined, cashier.id, { newPassword })).status === 401);
                check("R1. Reset requires users.update (403)", track(await reset(readerToken, cashier.id, { newPassword })).status === 403);
                check("R2. Validation: short password rejected (400)", track(await reset(ownerToken, cashier.id, { newPassword: "short" })).status === 400);
                check("R2. Validation: unknown fields rejected (400)", track(await reset(ownerToken, cashier.id, { newPassword, tenantId: tenantB.toString() })).status === 400);
                check("R2. Validation: invalid user ID rejected (400)", track(await reset(ownerToken, "123", { newPassword })).status === 400);
                check("R2. Validation: malformed JSON rejected (400)", track(await reset(ownerToken, cashier.id, undefined, "{")).status === 400);
                check("R3. Cannot reset your own password here (400)", track(await reset(managerToken, manager.id, { newPassword })).status === 400);
                check("R4. Nobody else can reset the owner's password (409)", track(await reset(managerToken, owner.id, { newPassword })).status === 409);
                // A second ordinary admin to target:
                const admin2 = await makeUser(tenantA, "admin2", adminRole);
                const admin2Token = await admin2.session();
                const nonOwnerOnAdmin = track(await reset(managerToken, admin2.id, { newPassword }));
                check("R5. Ordinary admin cannot reset another administrator's password (403)", nonOwnerOnAdmin.status === 403, String(nonOwnerOnAdmin.status));
                check("R5. Denied reset is audited", Boolean(await AuditLog.exists({ tenantId: tenantA, action: "user.privilege_escalation_denied", entityId: new mongoose.Types.ObjectId(admin2.id) })));
                check("R5. Target admin's password and session untouched", (await User.findById(admin2.id).lean())?.passwordHash === oldHash && (await me(admin2Token)).status === 200);
                check("R6. Cross-tenant reset returns 404", track(await reset(await ownerB.session(), cashier.id, { newPassword })).status === 404);

                const resetByManager = track(await reset(managerToken, cashier.id, { newPassword }));
                check("R7. Admin resets a lower-privileged user's password (200)", resetByManager.status === 200 && resetByManager.json.revokedSessions === 2, JSON.stringify(resetByManager.json));
                check("R7. All of the target's sessions are revoked (401, 401)", (await me(cashierT1)).status === 401 && (await me(cashierT2)).status === 401);
                check("R7. Admin's own session unaffected (200)", (await me(managerToken)).status === 200);
                check("R7. Target cannot log in with the old password (401)", track(await login(cashier.email, oldPassword, cashier.deviceIds[0])).status === 401);
                check("R7. Target can log in with the new password (200)", track(await login(cashier.email, newPassword, cashier.deviceIds[0])).status === 200);
                const resetAudit = await AuditLog.findOne({ tenantId: tenantA, action: "user.password_reset", entityId: new mongoose.Types.ObjectId(cashier.id) }).lean();
                check("R7. Reset is audited with the acting admin and device", resetAudit?.userId.toString() === manager.id && Boolean(resetAudit?.deviceId));
                check("R8. Owner can reset an administrator's password (200)", track(await reset(ownerToken, admin2.id, { newPassword })).status === 200);
                check("R8. Reset administrator's session revoked (401)", (await me(admin2Token)).status === 401);

                // ======================================================= NO LEAKS
                const auditJson = JSON.stringify(await AuditLog.find({ tenantId: { $in: [tenantA, tenantB] } }).lean());
                check(
                    "S1. Audit logs contain no passwords or hashes",
                    !auditJson.includes(oldPassword) && !auditJson.includes(newPassword) && !auditJson.includes("$argon2") && !auditJson.includes("passwordHash")
                );
                const allResponses = responseTexts.join("\n");
                check(
                    "S2. No API response contains a password or hash",
                    !allResponses.includes(oldPassword) && !allResponses.includes(newPassword) && !allResponses.includes("$argon2") && !/passwordHash/.test(allResponses)
                );
            }
        },
    });
}

main().catch((error: unknown) => {
    console.error("Password tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
