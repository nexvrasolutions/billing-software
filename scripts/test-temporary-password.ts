
/*
 * Temporary-password restriction tests.
 *
 * After an administrator resets a password, the user must choose a new one
 * before using anything else. Calls the real route handlers against the
 * database in MONGODB_URI using brand-new test tenants that are deleted
 * afterwards. Passwords and tokens are never printed.
 *
 * Run:
 *   ALLOW_TEMP_PASSWORD_TESTS=YES npx tsx scripts/test-temporary-password.ts
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
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_TEMP_PASSWORD_TESTS !== "YES") {
        throw new Error("Set ALLOW_TEMP_PASSWORD_TESTS=YES after confirming MONGODB_URI is a development database.");
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
    const logoutRoute = await import("../app/api/auth/logout/route");
    const logoutAllRoute = await import("../app/api/auth/logout-all/route");
    const meRoute = await import("../app/api/auth/me/route");
    const changeRoute = await import("../app/api/auth/change-password/route");
    const resetRoute = await import("../app/api/users/[id]/password/route");
    const usersRoute = await import("../app/api/users/route");
    const userRoute = await import("../app/api/users/[id]/route");
    const rolesRoute = await import("../app/api/users/roles/route");
    const auditRoute = await import("../app/api/audit-logs/route");
    const productsRoute = await import("../app/api/products/route");
    const taxesRoute = await import("../app/api/taxes/route");
    const syncRoute = await import("../app/api/sync-operations/route");

    type ObjectId = InstanceType<typeof mongoose.Types.ObjectId>;

    await runTestSafely({
        name: "Temporary-password tests",
        tenantNamePrefix: "TMPPW-TEST-",
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
            const nextIp = () => `192.0.${(ipBase + Math.floor(++ipCounter / 250)) % 256}.${(ipCounter % 250) + 1}`;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type Handler = (request: any, context?: any) => Promise<Response>;

            async function call(
                handler: Handler,
                options: { method?: string; path: string; token?: string; body?: unknown; ip?: string; params?: Record<string, string> }
            ): Promise<{ status: number; json: Json; headers: Headers; text: string }> {
                const headers = new Headers({ "content-type": "application/json" });
                if (options.token) headers.set("cookie", `session=${options.token}`);
                if (options.ip) headers.set("x-forwarded-for", options.ip);
                const request = new NextRequest(new URL(options.path, "http://localhost:3000"), {
                    method: options.method ?? "GET",
                    headers,
                    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
            const login = (email: string, password: string, deviceId: string) => {
                const ip = nextIp();
                registerAttempt(ip, email);
                return call(loginRoute.POST, { method: "POST", path: "/api/auth/login", body: { email, password, deviceId }, ip });
            };
            const me = (token: string) => call(meRoute.GET, { path: "/api/auth/me", token });
            const changePassword = (token: string, currentPassword: string, newPassword: string) =>
                call(changeRoute.POST, { method: "POST", path: "/api/auth/change-password", token, body: { currentPassword, newPassword }, ip: nextIp() });
            const resetPassword = (token: string, id: string, newPassword: string) =>
                call(resetRoute.POST, { method: "POST", path: `/api/users/${id}/password`, token, body: { newPassword }, params: { id } });

            const responseTexts: string[] = [];

            {
                const permissions = await Permission.find({
                    name: { $in: ["users.read", "users.create", "users.update", "users.delete", "products.read"] },
                }).select("_id name").lean();
                const perm = (name: string) => {
                    const found = permissions.find((p) => p.name === name);
                    if (!found) throw new Error(`Missing permission ${name}`);
                    return found._id as ObjectId;
                };
                const usersAll = ["users.read", "users.create", "users.update", "users.delete"].map(perm);

                const tenantA = run.newTenantId(); // registered before insert
                await Tenant.create({ _id: tenantA, name: run.tenantName("A"), status: "active" });
                const tenantB = run.newTenantId(); // registered before insert
                await Tenant.create({ _id: tenantB, name: run.tenantName("B"), status: "active" });

                const adminRole = (await Role.create({ tenantId: tenantA, name: "Admin", permissions: [...usersAll, perm("products.read")] }))._id as ObjectId;
                // The reset target can normally read users and products, so a later
                // 401 can only come from the restriction, not from missing permissions.
                const staffRole = (await Role.create({ tenantId: tenantA, name: "Staff", permissions: [perm("users.read"), perm("products.read")] }))._id as ObjectId;
                const adminRoleB = (await Role.create({ tenantId: tenantB, name: "Admin", permissions: usersAll }))._id as ObjectId;

                const originalPassword = `Original-${suffix}-Pw1!`;
                const tempPassword = `Temporary-${suffix}-Pw2!`;
                const chosenPassword = `Chosen-${suffix}-Pw3!`;
                const originalHash = await hashPassword(originalPassword);

                async function makeUser(tenantId: ObjectId, label: string, roleId: ObjectId, devices = 1) {
                    const email = `${label}-${suffix}@example.invalid`;
                    const user = await User.create({ tenantId, name: `Test ${label}`, email, passwordHash: originalHash, roleId, status: "active" });
                    const deviceIds: string[] = [];
                    const deviceDocIds: string[] = [];
                    for (let i = 1; i <= devices; i++) {
                        const device = await Device.create({ tenantId, userId: user._id, deviceName: `${label} ${i}`, deviceType: "desktop", deviceId: `tmppw-${label}-${i}-${suffix}`, status: "active" });
                        deviceIds.push(device.deviceId);
                        deviceDocIds.push(device._id.toString());
                    }
                    const session = async (deviceIndex = 0) =>
                        (await createUserSession({ userId: user._id.toString(), tenantId: tenantId.toString(), deviceId: deviceDocIds[deviceIndex], roleId: roleId.toString() })).token;
                    return { id: user._id.toString(), email, deviceIds, deviceDocIds, session };
                }

                const owner = await makeUser(tenantA, "owner", adminRole);
                const manager = await makeUser(tenantA, "manager", adminRole);
                const staff = await makeUser(tenantA, "staff", staffRole, 2);
                const admin2 = await makeUser(tenantA, "admin2", adminRole);
                const ownerB = await makeUser(tenantB, "owner-b", adminRoleB);
                await Tenant.updateOne({ _id: tenantA }, { $set: { ownerUserId: new mongoose.Types.ObjectId(owner.id) } });
                await Tenant.updateOne({ _id: tenantB }, { $set: { ownerUserId: new mongoose.Types.ObjectId(ownerB.id) } });

                // ------------------------------------------------------ normal login
                const normalLogin = await login(staff.email, originalPassword, staff.deviceIds[0]);
                responseTexts.push(normalLogin.text);
                const normalToken = cookieToken(normalLogin.headers);
                check("N1. Normal login succeeds with mustChangePassword=false", normalLogin.status === 200 && normalLogin.json.user?.mustChangePassword === false, JSON.stringify(normalLogin.json.user));
                check("N1. Normal user can use protected routes (users, products, taxes)", (await call(usersRoute.GET, { path: "/api/users", token: normalToken })).status === 200
                    && (await call(productsRoute.GET, { path: "/api/products", token: normalToken })).status === 200
                    && (await call(taxesRoute.GET, { path: "/api/taxes", token: normalToken })).status === 200);

                // A legacy record without the field at all is not restricted.
                const legacyEmail = `legacy-${suffix}@example.invalid`;
                const legacyInsert = await User.collection.insertOne({ tenantId: tenantA, name: "Legacy", email: legacyEmail, passwordHash: originalHash, roleId: staffRole, status: "active", createdAt: new Date(), updatedAt: new Date() });
                const legacyDevice = await Device.create({ tenantId: tenantA, userId: legacyInsert.insertedId, deviceName: "legacy", deviceType: "desktop", deviceId: `tmppw-legacy-${suffix}`, status: "active" });
                const legacyLogin = await login(legacyEmail, originalPassword, legacyDevice.deviceId);
                check("N2. Existing users without the field are unrestricted (no migration needed)", legacyLogin.status === 200 && legacyLogin.json.user?.mustChangePassword === false
                    && (await call(usersRoute.GET, { path: "/api/users", token: cookieToken(legacyLogin.headers) })).status === 200);

                // -------------------------------------------------- admin permissions
                const managerToken = await manager.session();
                const ownerToken = await owner.session();
                const staffToken = await staff.session(1);
                check("A1. User without users.update cannot reset passwords (403)", (await resetPassword(staffToken, admin2.id, tempPassword)).status === 403);
                check("A1. Non-owner admin cannot reset another admin (403) and no flag is set", (await resetPassword(managerToken, admin2.id, tempPassword)).status === 403
                    && (await User.findById(admin2.id).lean())?.mustChangePassword === false);
                check("A1. Cross-tenant reset returns 404 and sets no flag", (await resetPassword(await ownerB.session(), staff.id, tempPassword)).status === 404
                    && (await User.findById(staff.id).lean())?.mustChangePassword === false);
                check(
                    "A2. The flag cannot be set or cleared through user APIs (strict schema, 400)",
                    (await call(userRoute.PATCH, { method: "PATCH", path: `/api/users/${staff.id}`, token: ownerToken, body: { mustChangePassword: false }, params: { id: staff.id } })).status === 400
                    && (await call(usersRoute.POST, { method: "POST", path: "/api/users", token: ownerToken, body: { name: "X Y", email: `x-${suffix}@example.invalid`, password: tempPassword, roleId: staffRole.toString(), mustChangePassword: false } })).status === 400
                );

                // ---------------------------------------------------- admin reset
                const reset = await resetPassword(managerToken, staff.id, tempPassword);
                responseTexts.push(reset.text);
                check("R1. Admin reset succeeds (200)", reset.status === 200, JSON.stringify(reset.json));
                check("R1. User is marked as requiring a password change", (await User.findById(staff.id).lean())?.mustChangePassword === true);
                check("R1. All of the user's previous sessions were revoked (401)", (await me(normalToken)).status === 401 && (await me(staffToken)).status === 401);
                check("R2. Owner resetting an admin also sets the flag", (await resetPassword(ownerToken, admin2.id, tempPassword)).status === 200
                    && (await User.findById(admin2.id).lean())?.mustChangePassword === true);

                // ------------------------------------------------ restricted session
                const tempLogin = await login(staff.email, tempPassword, staff.deviceIds[0]);
                responseTexts.push(tempLogin.text);
                const restricted = cookieToken(tempLogin.headers);
                check("L1. Login with the temporary password succeeds and reports mustChangePassword=true", tempLogin.status === 200 && tempLogin.json.user?.mustChangePassword === true && restricted.length > 0);
                const meRestricted = await me(restricted);
                check("L1. /api/auth/me is allowed and reports the restriction", meRestricted.status === 200 && meRestricted.json.user?.mustChangePassword === true);
                const restricted2 = cookieToken((await login(staff.email, tempPassword, staff.deviceIds[1])).headers);

                const blocked: [string, Promise<{ status: number }>][] = [
                    ["GET /api/users", call(usersRoute.GET, { path: "/api/users", token: restricted })],
                    ["GET /api/users/roles", call(rolesRoute.GET, { path: "/api/users/roles", token: restricted })],
                    ["GET /api/users/[id]", call(userRoute.GET, { path: `/api/users/${staff.id}`, token: restricted, params: { id: staff.id } })],
                    ["PATCH /api/users/[self]", call(userRoute.PATCH, { method: "PATCH", path: `/api/users/${staff.id}`, token: restricted, body: { name: "Changed" }, params: { id: staff.id } })],
                    ["POST /api/users", call(usersRoute.POST, { method: "POST", path: "/api/users", token: restricted, body: {} })],
                    ["POST /api/users/[id]/password", call(resetRoute.POST, { method: "POST", path: `/api/users/${owner.id}/password`, token: restricted, body: { newPassword: chosenPassword }, params: { id: owner.id } })],
                    ["GET /api/products", call(productsRoute.GET, { path: "/api/products", token: restricted })],
                    ["GET /api/taxes", call(taxesRoute.GET, { path: "/api/taxes", token: restricted })],
                    ["GET /api/audit-logs", call(auditRoute.GET, { path: "/api/audit-logs", token: restricted })],
                    ["POST /api/sync-operations", call(syncRoute.POST, { method: "POST", path: "/api/sync-operations", token: restricted, body: {} })],
                ];
                for (const [label, pending] of blocked) {
                    const status = (await pending).status;
                    check(`L2. Restricted session blocked on ${label} (401)`, status === 401, String(status));
                }
                check("L2. Restricted user's name was not changed", (await User.findById(staff.id).lean())?.name === "Test staff");

                // --------------------------------------------- password change flow
                const short = await call(changeRoute.POST, { method: "POST", path: "/api/auth/change-password", token: restricted, body: { currentPassword: tempPassword, newPassword: "short" } });
                check("C1. Change-password endpoint is reachable while restricted (validation 400, not 401)", short.status === 400);
                check("C1. Wrong temporary password is rejected (400) and the restriction stays",
                    (await changePassword(restricted, "Not-The-Temp-Pass-1", chosenPassword)).status === 400 && (await User.findById(staff.id).lean())?.mustChangePassword === true);

                const changed = await changePassword(restricted, tempPassword, chosenPassword);
                responseTexts.push(changed.text);
                const fresh = cookieToken(changed.headers);
                check("C2. Changing the temporary password succeeds (200) with a new session", changed.status === 200 && fresh.length > 0 && fresh !== restricted, JSON.stringify(changed.json));
                check("C2. Restriction removed in the database", (await User.findById(staff.id).lean())?.mustChangePassword === false);
                check("C3. Restricted token used for the change is revoked (401)", (await me(restricted)).status === 401);
                check("C3. Other restricted session (second device) is revoked (401)", (await me(restricted2)).status === 401);
                const meFresh = await me(fresh);
                check("C4. New session works and reports mustChangePassword=false", meFresh.status === 200 && meFresh.json.user?.mustChangePassword === false);
                check("C4. New session can use protected routes again (users, products, taxes)", (await call(usersRoute.GET, { path: "/api/users", token: fresh })).status === 200
                    && (await call(productsRoute.GET, { path: "/api/products", token: fresh })).status === 200
                    && (await call(taxesRoute.GET, { path: "/api/taxes", token: fresh })).status === 200);
                check("C5. The temporary password no longer works (401)", (await login(staff.email, tempPassword, staff.deviceIds[0])).status === 401);
                const chosenLogin = await login(staff.email, chosenPassword, staff.deviceIds[0]);
                check("C5. The chosen password works and the user is unrestricted", chosenLogin.status === 200 && chosenLogin.json.user?.mustChangePassword === false);
                const auditActions = (await AuditLog.find({ tenantId: tenantA, entityId: new mongoose.Types.ObjectId(staff.id) }).select("action").lean()).map((a) => a.action);
                check("C6. Reset and change are both audited", auditActions.includes("user.password_reset") && auditActions.includes("user.password_changed"), auditActions.join(","));

                // ------------------------------------- logout endpoints while restricted
                const admin2Restricted = cookieToken((await login(admin2.email, tempPassword, admin2.deviceIds[0])).headers);
                const admin2Second = await admin2.session();
                check("O1. Restricted user is blocked from admin APIs despite an Admin role (401)", (await call(usersRoute.GET, { path: "/api/users", token: admin2Restricted })).status === 401);
                const logoutAll = await call(logoutAllRoute.POST, { method: "POST", path: "/api/auth/logout-all", token: admin2Restricted });
                check("O2. Logout-all is allowed while restricted and revokes every session", logoutAll.status === 200
                    && (await me(admin2Restricted)).status === 401 && (await me(admin2Second)).status === 401);
                const admin2Again = cookieToken((await login(admin2.email, tempPassword, admin2.deviceIds[0])).headers);
                check("O3. Logout is allowed while restricted", (await call(logoutRoute.POST, { method: "POST", path: "/api/auth/logout", token: admin2Again })).status === 200
                    && (await me(admin2Again)).status === 401);
                check("O3. Logging out does not lift the restriction", (await User.findById(admin2.id).lean())?.mustChangePassword === true);

                // ----------------------------------------------------------- leaks
                const allText = responseTexts.join("\n");
                check("S1. No password or hash in any checked response",
                    ![originalPassword, tempPassword, chosenPassword].some((p) => allText.includes(p)) && !allText.includes("$argon2") && !allText.includes("passwordHash"));
            }
        },
    });
}

main().catch((error: unknown) => {
    console.error("Temporary-password tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
