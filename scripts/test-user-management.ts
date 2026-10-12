
/*
 * User Management integration tests.
 *
 * Calls the real Next.js route handlers (app/api/users/**, app/api/auth/login)
 * with signed session cookies, against the database in MONGODB_URI.
 *
 * Safety:
 * - Creates three brand-new, uniquely named test tenants with their own
 *   roles, users and devices. Never reads or modifies existing tenants' users.
 * - Deletes only the records belonging to those new tenants at the end.
 * - Refuses to run with NODE_ENV=production or without the opt-in flag.
 *
 * Run:
 *   ALLOW_USER_MANAGEMENT_TESTS=YES npx tsx scripts/test-user-management.ts
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

type Json = Record<string, unknown> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
};

const results: { name: string; passed: boolean; detail?: string }[] = [];
const secretLeaks: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const SECRET_KEYS = new Set(["password", "passwordHash", "sessionToken", "token"]);

function scanForSecrets(value: unknown, path: string) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
            // Validation errors are keyed by field name (e.g. fieldErrors.password
            // holds messages, not secrets), so only string values count.
            if (SECRET_KEYS.has(key) && typeof inner === "string") {
                secretLeaks.push(`${path}.${key}`);
            }
            scanForSecrets(inner, `${path}.${key}`);
        }
    } else if (typeof value === "string" && value.startsWith("$argon2")) {
        secretLeaks.push(`${path} (argon2 hash)`);
    }
}

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Refusing to run in production.");
    }

    if (process.env.ALLOW_USER_MANAGEMENT_TESTS !== "YES") {
        throw new Error(
            "Set ALLOW_USER_MANAGEMENT_TESTS=YES after confirming MONGODB_URI is a development database."
        );
    }

    // Load modules after the environment is ready.
    const mongoose = (await import("mongoose")).default;
    const { Types } = mongoose;
    const { NextRequest } = await import("next/server");
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Device } = await import("../lib/models/Device");
    const { AuditLog } = await import("../lib/models/AuditLog");
    const { TenantAdminGuard } = await import("../lib/models/TenantAdminGuard");
    const { getAdministratorRoleIds } = await import("../lib/auth/isAdministratorRole");
    const { createUserSession } = await import("../lib/auth/sessionStore");
    const { Session } = await import("../lib/models/Session");
    const { hashPassword } = await import("../app/api/auth/password");
    const usersRoute = await import("../app/api/users/route");
    const userRoute = await import("../app/api/users/[id]/route");
    const rolesRoute = await import("../app/api/users/roles/route");
    const loginRoute = await import("../app/api/auth/login/route");

    type ObjectId = InstanceType<typeof Types.ObjectId>;

    await connectDB();

    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const createdTenantIds: ObjectId[] = [];

    // ---------------------------------------------------------------- helpers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Handler = (request: any, context?: any) => Promise<Response>;

    async function call(
        handler: Handler,
        options: {
            method?: string;
            path: string;
            token?: string;
            body?: unknown;
            rawBody?: string;
            params?: Record<string, string>;
        }
    ): Promise<{ status: number; json: Json; headers: Headers }> {
        const headers = new Headers({ "content-type": "application/json" });

        if (options.token) {
            headers.set("cookie", `session=${options.token}`);
        }

        const request = new NextRequest(new URL(options.path, "http://localhost:3000"), {
            method: options.method ?? "GET",
            headers,
            body:
                options.rawBody ??
                (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        });

        const response = options.params
            ? await handler(request, { params: Promise.resolve(options.params) })
            : await handler(request);

        const json = (await response.json()) as Json;
        scanForSecrets(json, `${options.method ?? "GET"} ${options.path}`);

        return { status: response.status, json, headers: response.headers };
    }

    const listUsers = (token: string | undefined, query = "") =>
        call(usersRoute.GET, { path: `/api/users${query}`, token });
    const createUser = (token: string | undefined, body: unknown, rawBody?: string) =>
        call(usersRoute.POST, { method: "POST", path: "/api/users", token, body, rawBody });
    const getUser = (token: string, id: string) =>
        call(userRoute.GET, { path: `/api/users/${id}`, token, params: { id } });
    const patchUser = (token: string, id: string, body: unknown, rawBody?: string) =>
        call(userRoute.PATCH, {
            method: "PATCH",
            path: `/api/users/${id}`,
            token,
            body,
            rawBody,
            params: { id },
        });
    const listRoles = (token: string) => call(rolesRoute.GET, { path: "/api/users/roles", token });

    try {
        // ------------------------------------------------------------ fixtures
        const permissionNames = [
            "users.read",
            "users.create",
            "users.update",
            "users.delete",
            "products.read",
            "products.create",
        ];
        const permissions = await Permission.find({ name: { $in: permissionNames } })
            .select("_id name")
            .lean();
        const perm = (name: string) => {
            const found = permissions.find((item) => item.name === name);
            if (!found) throw new Error(`Required permission missing: ${name}`);
            return found._id as ObjectId;
        };
        const usersAll = ["users.read", "users.create", "users.update", "users.delete"].map(perm);

        async function makeTenant(label: string) {
            const tenant = await Tenant.create({
                name: `UM-TEST-${label}-${suffix}`,
                businessType: "test",
                status: "active",
            });
            createdTenantIds.push(tenant._id as ObjectId);
            return tenant._id as ObjectId;
        }

        async function makeRole(
            tenantId: ObjectId,
            name: string,
            perms: ObjectId[],
            status: "active" | "inactive" = "active"
        ) {
            const role = await Role.create({ tenantId, name, permissions: perms, status });
            return role._id as ObjectId;
        }

        interface Actor {
            id: string;
            tenantId: ObjectId;
            token: string;
            deviceDocId: ObjectId;
        }

        async function makeUser(tenantId: ObjectId, label: string, roleId: ObjectId): Promise<Actor> {
            const user = await User.create({
                tenantId,
                name: `Test ${label}`,
                email: `${label}-${suffix}@example.invalid`,
                passwordHash: "NOT_A_REAL_HASH_TEST_ONLY",
                roleId,
                status: "active",
            });
            const device = await Device.create({
                tenantId,
                userId: user._id,
                deviceName: `Test device ${label}`,
                deviceType: "desktop",
                deviceId: `um-test-${label}-${suffix}`,
                status: "active",
            });
            const { token } = await createUserSession({
                userId: user._id.toString(),
                tenantId: tenantId.toString(),
                deviceId: device._id.toString(),
                roleId: roleId.toString(),
            });
            return {
                id: user._id.toString(),
                tenantId,
                token,
                deviceDocId: device._id as ObjectId,
            };
        }

        const tenantA = await makeTenant("A");
        const tenantB = await makeTenant("B");
        const tenantC = await makeTenant("C");

        const adminRoleA = await makeRole(tenantA, "Admin", [...usersAll, perm("products.read")]);
        const updaterRoleA = await makeRole(tenantA, "User Updater", [perm("users.read"), perm("users.update")]);
        const readerRoleA = await makeRole(tenantA, "User Reader", [perm("users.read")]);
        const cashierRoleA = await makeRole(tenantA, "Cashier", [perm("products.read")]);
        const superCashierRoleA = await makeRole(tenantA, "Senior Cashier", [perm("products.read"), perm("products.create")]);
        const inactiveRoleA = await makeRole(tenantA, "Retired Role", [perm("products.read")], "inactive");

        const adminRoleB = await makeRole(tenantB, "Admin", usersAll);
        const cashierRoleB = await makeRole(tenantB, "Cashier", [perm("products.read")]);

        // Tenant C: the owner's role deliberately lacks users.create, so the
        // owner is NOT a full administrator. This lets us test the
        // last-active-administrator rule through the owner.
        const ownerRoleC = await makeRole(tenantC, "Owner Limited", [perm("users.read"), perm("users.update"), perm("users.delete")]);
        const adminRoleC = await makeRole(tenantC, "Admin", usersAll);
        const cashierRoleC = await makeRole(tenantC, "Cashier", [perm("products.read")]);

        const ownerA = await makeUser(tenantA, "owner-a", adminRoleA);
        const managerA = await makeUser(tenantA, "manager-a", adminRoleA); // ordinary admin, NOT owner
        const updaterA = await makeUser(tenantA, "updater-a", updaterRoleA);
        const readerA = await makeUser(tenantA, "reader-a", readerRoleA);
        const cashierA = await makeUser(tenantA, "cashier-a", cashierRoleA);
        const ownerB = await makeUser(tenantB, "owner-b", adminRoleB);
        const ownerC = await makeUser(tenantC, "owner-c", ownerRoleC);
        const adminC1 = await makeUser(tenantC, "admin-c1", adminRoleC);
        const adminC2 = await makeUser(tenantC, "admin-c2", adminRoleC);

        // Owners are designated directly in the database, exactly as the
        // server-side scripts/designate-tenant-owner.ts does.
        await Tenant.updateOne({ _id: tenantA }, { $set: { ownerUserId: new Types.ObjectId(ownerA.id) } });
        await Tenant.updateOne({ _id: tenantB }, { $set: { ownerUserId: new Types.ObjectId(ownerB.id) } });
        await Tenant.updateOne({ _id: tenantC }, { $set: { ownerUserId: new Types.ObjectId(ownerC.id) } });

        const newEmail = `new-user-${suffix}@example.invalid`;
        const passwordA = "Correct-Horse-Battery-A1";
        const passwordB = "Different-Staple-Pass-B2";

        // ------------------------------------------------- 1. create succeeds
        const created = await createUser(ownerA.token, {
            name: "New Cashier",
            email: newEmail.toUpperCase(),
            password: passwordA,
            roleId: cashierRoleA.toString(),
        });
        check("1. Authorized user creation succeeds (201)", created.status === 201, JSON.stringify(created.json));
        const newUserId: string = created.json.user?.id;
        const storedNewUser = await User.findById(newUserId).lean();
        check("1. Email normalized to lowercase", storedNewUser?.email === newEmail);
        check("1. Password stored as argon2id hash", Boolean(storedNewUser?.passwordHash.startsWith("$argon2id$")));
        check("1. Response has role name, no password fields", created.json.user?.roleName === "Cashier" && !("passwordHash" in (created.json.user ?? {})));

        const managerCreatesCashier = await createUser(managerA.token, {
            name: "Cashier Two",
            email: `cashier-two-${suffix}@example.invalid`,
            password: passwordA,
            roleId: cashierRoleA.toString(),
        });
        check("1. Non-owner admin can create user with a lower role (201)", managerCreatesCashier.status === 201, JSON.stringify(managerCreatesCashier.json));

        // ------------------------------------------- 2. unauthorized creation
        const validBody = {
            name: "Nope",
            email: `nope-${suffix}@example.invalid`,
            password: passwordA,
            roleId: cashierRoleA.toString(),
        };
        check("2. Creation without users.create rejected (403)", (await createUser(readerA.token, validBody)).status === 403);
        check("2. Creation by cashier rejected (403)", (await createUser(cashierA.token, validBody)).status === 403);
        check("2. Creation without session rejected (401)", (await createUser(undefined, validBody)).status === 401);
        check("2. Creation with forged token rejected (401)", (await createUser("forged.token.value", validBody)).status === 401);
        check("2. No user created by rejected requests", !(await User.exists({ email: validBody.email })));

        // ------------------------------------------------------- 3. list users
        check("3. List without users.read rejected (403)", (await listUsers(cashierA.token)).status === 403);
        check("3. List without session rejected (401)", (await listUsers(undefined)).status === 401);
        const listA = await listUsers(readerA.token, "?limit=100");
        const tenantAUserIds = (await User.find({ tenantId: tenantA }).select("_id").lean()).map((u) => u._id.toString());
        check("3. List with users.read succeeds (200)", listA.status === 200);
        check(
            "3. List returns only own-tenant users",
            listA.json.users?.length === tenantAUserIds.length &&
            listA.json.users.every((u: Json) => tenantAUserIds.includes(u.id))
        );
        const searched = await listUsers(readerA.token, `?search=${encodeURIComponent("new-user-" + suffix)}`);
        check("3. Search filters by email", searched.json.users?.length === 1 && searched.json.users[0].id === newUserId);
        const regexSearch = await listUsers(readerA.token, "?search=.*");
        check("3. Search input is treated literally (no regex injection)", regexSearch.status === 200 && regexSearch.json.users.length === 0);
        const paged = await listUsers(readerA.token, "?limit=2&page=2");
        check(
            "3. Pagination works",
            paged.status === 200 && paged.json.users.length === 2 && paged.json.pagination.totalPages === Math.ceil(tenantAUserIds.length / 2)
        );
        check("3. Capabilities reflect reader (no create)", listA.json.capabilities?.canCreate === false && listA.json.capabilities?.isOwner === false);

        // ---------------------------------------------------- 4. read a user
        check("4. Read without users.read rejected (403)", (await getUser(cashierA.token, newUserId)).status === 403);
        const readOne = await getUser(readerA.token, newUserId);
        check("4. Read with users.read succeeds (200)", readOne.status === 200 && readOne.json.user?.id === newUserId);

        // -------------------------------------------------- 5. update a user
        check("5. Update without users.update rejected (403)", (await patchUser(readerA.token, cashierA.id, { name: "Hacked" })).status === 403);
        check(
            "5. Status change without users.delete rejected (403)",
            (await patchUser(updaterA.token, cashierA.id, { status: "inactive" })).status === 403
        );
        // updaterA lacks products.read, which the cashier holds, so the
        // policy forbids updaterA from editing that more-privileged user.
        check(
            "5. Cannot edit a user holding permissions the caller lacks (403)",
            (await patchUser(updaterA.token, cashierA.id, { name: "Cashier Renamed" })).status === 403
        );
        const renamed = await patchUser(managerA.token, cashierA.id, { name: "Cashier Renamed" });
        check("5. Update with users.update succeeds (200)", renamed.status === 200 && renamed.json.user?.name === "Cashier Renamed", JSON.stringify(renamed.json));

        // -------------------------------------------------- 6. invalid input
        const invalidCreates: [string, unknown, string?][] = [
            ["bad email", { ...validBody, email: "not-an-email" }],
            ["short password", { ...validBody, password: "short" }],
            ["missing name", { ...validBody, name: undefined }],
            ["invalid role ObjectId", { ...validBody, roleId: "xyz" }],
            ["unknown field tenantId", { ...validBody, tenantId: tenantB.toString() }],
            ["unknown field passwordHash", { ...validBody, passwordHash: "x" }],
            ["array body", [validBody]],
            ["malformed JSON", undefined, "{bad json"],
        ];
        for (const [label, body, raw] of invalidCreates) {
            const result = await createUser(ownerA.token, body, raw);
            check(`6. Create rejects ${label} (400)`, result.status === 400, `${result.status} ${JSON.stringify(result.json)}`);
        }
        const invalidPatches: [string, unknown, string?][] = [
            ["empty update", {}],
            ["passwordHash", { passwordHash: "x" }],
            ["tenantId", { tenantId: tenantB.toString() }],
            ["ownerUserId", { ownerUserId: ownerA.id }],
            ["invalid status", { status: "deleted" }],
            ["invalid roleId", { roleId: "123" }],
            ["malformed JSON", undefined, "{"],
        ];
        for (const [label, body, raw] of invalidPatches) {
            const result = await patchUser(ownerA.token, cashierA.id, body, raw);
            check(`6. Update rejects ${label} (400)`, result.status === 400, `${result.status} ${JSON.stringify(result.json)}`);
        }
        check("6. Invalid user ID in path rejected (400)", (await getUser(ownerA.token, "123")).status === 400);
        check("6. Invalid list query rejected (400)", (await listUsers(ownerA.token, "?page=0")).status === 400);
        check("6. Unknown list query param rejected (400)", (await listUsers(ownerA.token, "?tenantId=" + tenantB)).status === 400);
        check("6. Validation error responses carry field errors", (await createUser(ownerA.token, { ...validBody, email: "x" })).json.errors?.fieldErrors?.email?.length > 0);

        // --------------------------------------------- 7. duplicate email
        const dup = await createUser(ownerA.token, { ...validBody, email: newEmail });
        check("7. Duplicate email in same tenant rejected (409)", dup.status === 409);
        const dupCase = await createUser(ownerA.token, { ...validBody, email: `  ${newEmail.toUpperCase()} ` });
        check("7. Duplicate email (different case/whitespace) rejected (409)", dupCase.status === 409);
        const dupPatch = await patchUser(ownerA.token, cashierA.id, { email: newEmail });
        check("7. Changing email to an existing one rejected (409)", dupPatch.status === 409);
        check("7. Duplicate response does not reveal DB internals", !JSON.stringify(dup.json).includes("E11000"));

        // ---------------------------------------- 8. same email, other tenant
        const createdB = await createUser(ownerB.token, {
            name: "Same Email Other Business",
            email: newEmail,
            password: passwordB,
            roleId: cashierRoleB.toString(),
        });
        check("8. Same email in another tenant allowed (201)", createdB.status === 201, JSON.stringify(createdB.json));
        const newUserBId: string = createdB.json.user?.id;

        // Login must pick the right business for a shared email.
        const deviceA = await Device.create({
            tenantId: tenantA, userId: new Types.ObjectId(newUserId), deviceName: "Login A",
            deviceType: "pos", deviceId: `login-a-${suffix}`, status: "active",
        });
        const deviceB = await Device.create({
            tenantId: tenantB, userId: new Types.ObjectId(newUserBId), deviceName: "Login B",
            deviceType: "pos", deviceId: `login-b-${suffix}`, status: "active",
        });
        const login = (body: unknown) =>
            call(loginRoute.POST, { method: "POST", path: "/api/auth/login", body });
        const loginA = await login({ email: newEmail, password: passwordA, deviceId: deviceA.deviceId });
        check("8. Login resolves tenant A account for shared email", loginA.status === 200 && loginA.json.user?.tenantId === tenantA.toString(), JSON.stringify(loginA.json));
        const loginB = await login({ email: newEmail, password: passwordB, deviceId: deviceB.deviceId });
        check("8. Login resolves tenant B account for shared email", loginB.status === 200 && loginB.json.user?.tenantId === tenantB.toString(), JSON.stringify(loginB.json));
        check("8. Login sets HttpOnly session cookie", (loginB.headers.get("set-cookie") ?? "").toLowerCase().includes("httponly"));
        const loginMismatch = await login({ email: newEmail, password: passwordA, deviceId: deviceB.deviceId });
        check("8. Password of tenant A + device of tenant B rejected", loginMismatch.status === 403 || loginMismatch.status === 401);
        const loginWrong = await login({ email: newEmail, password: "Wrong-Password-123", deviceId: deviceA.deviceId });
        check("8. Wrong password rejected (401)", loginWrong.status === 401);

        // ------------------------------------------------ 9. cross-tenant
        check("9. Cross-tenant read returns 404", (await getUser(ownerB.token, cashierA.id)).status === 404);
        check("9. Cross-tenant update returns 404", (await patchUser(ownerB.token, cashierA.id, { name: "Pwned" })).status === 404);
        check("9. Cross-tenant deactivate returns 404", (await patchUser(ownerB.token, cashierA.id, { status: "inactive" })).status === 404);
        const listB = await listUsers(ownerB.token, "?limit=100");
        check("9. Tenant B list excludes tenant A users", listB.json.users.every((u: Json) => !tenantAUserIds.includes(u.id)));
        const cashierAfter = await User.findById(cashierA.id).lean();
        check("9. Tenant A user unchanged by tenant B", cashierAfter?.name === "Cashier Renamed" && cashierAfter.status === "active");

        // -------------------------------------------- 10. cross-tenant role
        check(
            "10. Create with another tenant's role rejected (400)",
            (await createUser(ownerA.token, { ...validBody, roleId: adminRoleB.toString() })).status === 400
        );
        check(
            "10. Update to another tenant's role rejected (400)",
            (await patchUser(ownerA.token, cashierA.id, { roleId: cashierRoleB.toString() })).status === 400
        );
        check(
            "10. Assigning an inactive role rejected (400)",
            (await patchUser(ownerA.token, cashierA.id, { roleId: inactiveRoleA.toString() })).status === 400
        );

        // ----------------------------------- 11. arbitrary role escalation
        check(
            "11. Non-owner cannot create user with role exceeding own permissions (403)",
            (await createUser(managerA.token, { ...validBody, roleId: superCashierRoleA.toString() })).status === 403
        );
        check(
            "11. Non-owner cannot assign role exceeding own permissions (403)",
            (await patchUser(managerA.token, cashierA.id, { roleId: superCashierRoleA.toString() })).status === 403
        );
        check(
            "11. User cannot change own role (403)",
            (await patchUser(updaterA.token, updaterA.id, { roleId: adminRoleA.toString() })).status === 403
        );
        check(
            "11. Admin cannot change own role (403)",
            (await patchUser(managerA.token, managerA.id, { roleId: cashierRoleA.toString() })).status === 403
        );
        const managerRoles = await listRoles(managerA.token);
        const roleView = (list: Json, id: ObjectId) => list.json.roles?.find((r: Json) => r.id === id.toString());
        check(
            "11. Roles endpoint marks escalating roles unassignable for non-owner",
            roleView(managerRoles, adminRoleA)?.assignable === false &&
            roleView(managerRoles, superCashierRoleA)?.assignable === false &&
            roleView(managerRoles, cashierRoleA)?.assignable === true &&
            roleView(managerRoles, adminRoleA)?.isAdministrator === true &&
            !roleView(managerRoles, inactiveRoleA) &&
            managerRoles.json.roles.every((r: Json) => !("permissions" in r))
        );

        // ---------------------- 12. admin promotion on create (non-owner)
        const deniedCreateEmail = `would-be-admin-${suffix}@example.invalid`;
        const deniedCreate = await createUser(managerA.token, { ...validBody, email: deniedCreateEmail, roleId: adminRoleA.toString() });
        check("12. Ordinary admin cannot create an administrator (403)", deniedCreate.status === 403, JSON.stringify(deniedCreate.json));
        check("12. No user created by denied admin creation", !(await User.exists({ email: deniedCreateEmail })));
        check(
            "12. Denied creation is audited",
            Boolean(await AuditLog.exists({
                tenantId: tenantA,
                userId: new Types.ObjectId(managerA.id),
                action: "user.privilege_escalation_denied",
                "newValues.email": deniedCreateEmail,
            }))
        );

        // ---------------------- 13. admin promotion on update (non-owner)
        check(
            "13. Ordinary admin cannot promote a user to administrator (403)",
            (await patchUser(managerA.token, cashierA.id, { roleId: adminRoleA.toString() })).status === 403
        );
        check(
            "13. users.update-only user cannot promote to a user-management role (403)",
            (await patchUser(updaterA.token, cashierA.id, { roleId: updaterRoleA.toString() })).status === 403
        );
        check(
            "13. Ordinary admin cannot modify another administrator (403)",
            (await patchUser(managerA.token, updaterA.id, { name: "Changed by manager" })).status === 403
        );
        check(
            "13. Owner cannot be deactivated by an admin (409)",
            (await patchUser(managerA.token, ownerA.id, { status: "inactive" })).status === 409
        );
        check(
            "13. Owner role cannot be changed by an admin (409)",
            (await patchUser(managerA.token, ownerA.id, { roleId: cashierRoleA.toString() })).status === 409
        );
        check("13. Target role unchanged after denied promotions", (await User.findById(cashierA.id).lean())?.roleId?.toString() === cashierRoleA.toString());
        check(
            "13. Denied promotion is audited",
            Boolean(await AuditLog.exists({
                tenantId: tenantA,
                action: "user.privilege_escalation_denied",
                entityId: new Types.ObjectId(cashierA.id),
            }))
        );

        // ------------------------------------- 14. owner grants admin access
        const ownerRoles = await listRoles(ownerA.token);
        check("14. Roles endpoint marks admin role assignable for owner", roleView(ownerRoles, adminRoleA)?.assignable === true);
        const promoted = await patchUser(ownerA.token, cashierA.id, { roleId: adminRoleA.toString() });
        check("14. Owner can promote a user to administrator (200)", promoted.status === 200 && promoted.json.user?.roleId === adminRoleA.toString(), JSON.stringify(promoted.json));
        const ownerCreatedAdmin = await createUser(ownerA.token, {
            ...validBody,
            email: `owner-made-admin-${suffix}@example.invalid`,
            roleId: adminRoleA.toString(),
        });
        check("14. Owner can create an administrator (201)", ownerCreatedAdmin.status === 201, JSON.stringify(ownerCreatedAdmin.json));
        const demoted = await patchUser(ownerA.token, cashierA.id, { roleId: cashierRoleA.toString() });
        check("14. Owner can demote an administrator (200)", demoted.status === 200);

        // -------------------------------------------- 15. self-deactivation
        const selfDeactivate = await patchUser(managerA.token, managerA.id, { status: "inactive" });
        check("15. Admin cannot deactivate own account (400)", selfDeactivate.status === 400, JSON.stringify(selfDeactivate.json));
        check("15. Owner cannot deactivate own account (400)", (await patchUser(ownerA.token, ownerA.id, { status: "inactive" })).status === 400);
        check("15. Self-edit of own name still allowed (200)", (await patchUser(managerA.token, managerA.id, { name: "Manager Renamed" })).status === 200);

        // ------------------------------------ 16. last active administrator
        const demoteC1 = await patchUser(ownerC.token, adminC1.id, { roleId: cashierRoleC.toString() });
        check("16. Demoting one of two administrators allowed (200)", demoteC1.status === 200, JSON.stringify(demoteC1.json));
        const lastAdmin = await patchUser(ownerC.token, adminC2.id, { status: "inactive" });
        check("16. Deactivating last active administrator rejected (409)", lastAdmin.status === 409, JSON.stringify(lastAdmin.json));
        const lastAdminDemote = await patchUser(ownerC.token, adminC2.id, { roleId: cashierRoleC.toString() });
        check("16. Demoting last active administrator rejected (409)", lastAdminDemote.status === 409);
        check("16. Last administrator still active", (await User.findById(adminC2.id).lean())?.status === "active");

        // ------------------------------- 17. concurrent administrator removal
        for (let round = 1; round <= 3; round++) {
            // Reset: two active administrators.
            const reset = await patchUser(ownerC.token, adminC1.id, { roleId: adminRoleC.toString(), status: "active" });
            const resetOk = reset.status === 200;
            const [first, second] = await Promise.all([
                patchUser(ownerC.token, adminC1.id, { status: "inactive" }),
                patchUser(ownerC.token, adminC2.id, { roleId: cashierRoleC.toString() }),
            ]);
            const statuses = [first.status, second.status].sort();
            const adminRoleIds = await getAdministratorRoleIds(tenantC);
            const activeAdmins = await User.countDocuments({ tenantId: tenantC, status: "active", roleId: { $in: adminRoleIds } });
            check(
                `17. Concurrent admin removal round ${round}: one succeeds, one blocked, 1 admin remains`,
                resetOk && statuses[0] === 200 && statuses[1] === 409 && activeAdmins === 1,
                `reset=${reset.status} statuses=${statuses.join(",")} activeAdmins=${activeAdmins}`
            );
            // Restore both for the next round.
            await User.updateMany(
                { _id: { $in: [adminC1.id, adminC2.id].map((id) => new Types.ObjectId(id)) } },
                { $set: { status: "active", roleId: adminRoleC } }
            );
        }

        // ------------------------------------------------ 18. inactive caller
        const deactivateReader = await patchUser(ownerA.token, readerA.id, { status: "inactive" });
        check("18. Owner deactivates a user (200)", deactivateReader.status === 200);
        check("18. Deactivated user loses API access immediately (401)", (await listUsers(readerA.token)).status === 401);
        const reactivate = await patchUser(ownerA.token, readerA.id, { status: "active" });
        check("18. Owner reactivates a user (200)", reactivate.status === 200);
        // Deactivation revoked every session of that user, so the old token
        // stays dead after reactivation; a fresh login (new session) works.
        check("18. Old token stays revoked after reactivation (401)", (await listUsers(readerA.token)).status === 401);
        readerA.token = (await createUserSession({
            userId: readerA.id,
            tenantId: tenantA.toString(),
            deviceId: readerA.deviceDocId.toString(),
            roleId: readerRoleA.toString(),
        })).token;
        check("18. Reactivated user regains access after new login (200)", (await listUsers(readerA.token)).status === 200);

        await Tenant.updateOne({ _id: tenantB }, { $set: { status: "inactive" } });
        check("18. Users of an inactive tenant are rejected (401)", (await listUsers(ownerB.token)).status === 401);
        await Tenant.updateOne({ _id: tenantB }, { $set: { status: "active" } });

        await Role.updateOne({ _id: readerRoleA }, { $set: { status: "inactive" } });
        check("18. User with an inactive role is rejected (403)", (await listUsers(readerA.token)).status === 403);
        await Role.updateOne({ _id: readerRoleA }, { $set: { status: "active" } });

        await Device.updateOne({ _id: managerA.deviceDocId }, { $set: { status: "inactive" } });
        check("18. Session from a deactivated device is rejected (401)", (await listUsers(managerA.token)).status === 401);
        await Device.updateOne({ _id: managerA.deviceDocId }, { $set: { status: "active" } });

        // A role change takes effect on the next request; the old session's
        // roleId claim is ignored because roles are re-read from the database.
        await patchUser(ownerA.token, readerA.id, { roleId: cashierRoleA.toString() });
        check("18. Role downgrade takes effect on existing session (403)", (await listUsers(readerA.token)).status === 403);

        // --------------------------------------- 21. transaction consistency
        process.env.TEST_AUDIT_LOG_FAILURE = "true";
        const failedEmail = `tx-fail-${suffix}@example.invalid`;
        const failedCreate = await createUser(ownerA.token, { ...validBody, email: failedEmail });
        const failedPatch = await patchUser(ownerA.token, cashierA.id, { name: "Should Roll Back" });
        delete process.env.TEST_AUDIT_LOG_FAILURE;
        check("21. Create with failing audit write returns 500", failedCreate.status === 500);
        check("21. No user persisted when audit write fails", !(await User.exists({ email: failedEmail })));
        check("21. Update with failing audit write returns 500", failedPatch.status === 500);
        check("21. User change rolled back when audit write fails", (await User.findById(cashierA.id).lean())?.name === "Cashier Renamed");

        // ------------------------------------------------- 20. audit logs
        const createdAudit = await AuditLog.findOne({
            tenantId: tenantA,
            action: "user.created",
            entityId: new Types.ObjectId(newUserId),
        }).lean();
        check(
            "20. user.created audit identifies actor, device, target",
            createdAudit?.userId.toString() === ownerA.id &&
            createdAudit?.deviceId?.toString() === ownerA.deviceDocId.toString() &&
            Boolean(createdAudit?.createdAt)
        );
        const actionsFor = async (entityId: string) =>
            (await AuditLog.find({ tenantId: tenantA, entityId: new Types.ObjectId(entityId) }).select("action").lean()).map((a) => a.action);
        const cashierActions = await actionsFor(cashierA.id);
        check(
            "20. Role change / admin grant / admin revoke audited",
            ["user.updated", "user.role_changed", "user.admin_granted", "user.admin_revoked"].every((a) => cashierActions.includes(a)),
            cashierActions.join(",")
        );
        const readerActions = await actionsFor(readerA.id);
        check(
            "20. Deactivation / activation audited",
            readerActions.includes("user.deactivated") && readerActions.includes("user.activated"),
            readerActions.join(",")
        );
        check(
            "20. Owner-created admin audited as admin grant",
            (await actionsFor(ownerCreatedAdmin.json.user.id)).includes("user.admin_granted")
        );
        const allAudit = JSON.stringify(await AuditLog.find({ tenantId: { $in: createdTenantIds } }).lean());
        check(
            "20. Audit logs contain no passwords or hashes",
            !allAudit.includes(passwordA) && !allAudit.includes(passwordB) && !allAudit.includes("$argon2") && !allAudit.includes("passwordHash")
        );

        // ------------------------------------------ 19. no secrets in output
        check("19. No password, hash or token in any API response", secretLeaks.length === 0, secretLeaks.join("; "));

        // Sanity: hashing helper still produces argon2id (used by creation).
        check("19. hashPassword produces argon2id", (await hashPassword("Throwaway-Pass-123")).startsWith("$argon2id$"));
    } finally {
        // Remove only the records of the tenants created by this run.
        if (createdTenantIds.length) {
            const filter = { tenantId: { $in: createdTenantIds } };
            await Promise.all([
                User.deleteMany(filter),
                Role.deleteMany(filter),
                Device.deleteMany(filter),
                AuditLog.deleteMany(filter),
                TenantAdminGuard.deleteMany(filter),
                Session.deleteMany(filter),
            ]);
            await Tenant.deleteMany({ _id: { $in: createdTenantIds } });
            console.log(`\nCleaned up ${createdTenantIds.length} test tenants and their records.`);
        }

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

main().catch((error: unknown) => {
    console.error("User management tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
