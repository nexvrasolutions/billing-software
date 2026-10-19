
/*
 * Audit-log API security tests.
 *
 * Calls the real route handlers (app/api/audit-logs/**, app/api/users/**)
 * with signed session cookies against the database in MONGODB_URI.
 *
 * Safety:
 * - Creates two brand-new, uniquely named test tenants and deletes only
 *   their records afterwards. Existing tenants, users and roles are not touched.
 * - The global "auditLogs.read" catalog permission is reused if it exists.
 *   If it does not exist, the test creates it temporarily and removes it
 *   again at the end (no real role references it in that case).
 *
 * Run:
 *   ALLOW_AUDIT_LOG_TESTS=YES npx tsx scripts/test-audit-log-security.ts
 */

import { loadEnvConfig } from "@next/env";
import { assertTestDatabaseUri } from "./lib/testDatabaseGuard";

loadEnvConfig(process.cwd());

type Json = Record<string, unknown> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
};

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function skip(name: string, reason: string) {
    console.log(`SKIP  ${name}  (${reason})`);
}

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Refusing to run in production.");
    }

    if (process.env.ALLOW_AUDIT_LOG_TESTS !== "YES") {
        throw new Error(
            "Set ALLOW_AUDIT_LOG_TESTS=YES after confirming MONGODB_URI is a development database."
        );
    }
    // Only the dedicated test database, checked before anything connects.
    assertTestDatabaseUri(process.env.MONGODB_URI);

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
    const { AuditLogService } = await import("../lib/services/AuditLogService");
    const { createUserSession } = await import("../lib/auth/sessionStore");
    const { Session } = await import("../lib/models/Session");
    const auditListRoute: Record<string, unknown> = await import("../app/api/audit-logs/route");
    const auditItemRoute: Record<string, unknown> = await import("../app/api/audit-logs/[id]/route");
    const usersRoute = await import("../app/api/users/route");
    const userRoute = await import("../app/api/users/[id]/route");

    type ObjectId = InstanceType<typeof Types.ObjectId>;

    await connectDB();

    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const createdTenantIds: ObjectId[] = [];
    let createdPermissionId: ObjectId | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Handler = (request: any, context?: any) => Promise<Response>;

    async function call(
        handler: Handler,
        options: { method?: string; path: string; token?: string; body?: unknown; params?: Record<string, string> }
    ): Promise<{ status: number; json: Json }> {
        const headers = new Headers({ "content-type": "application/json" });
        if (options.token) headers.set("cookie", `session=${options.token}`);

        const request = new NextRequest(new URL(options.path, "http://localhost:3000"), {
            method: options.method ?? "GET",
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });

        const response = options.params
            ? await handler(request, { params: Promise.resolve(options.params) })
            : await handler(request);

        return { status: response.status, json: (await response.json()) as Json };
    }

    const listLogs = (token: string | undefined, query = "") =>
        call(auditListRoute.GET as Handler, { path: `/api/audit-logs${query}`, token });
    const getLog = (token: string | undefined, id: string) =>
        call(auditItemRoute.GET as Handler, { path: `/api/audit-logs/${id}`, token, params: { id } });

    try {
        // ------------------------------------------------------------ fixtures
        const existingAuditPermission = await Permission.findOne({ name: "auditLogs.read" })
            .select("_id")
            .lean();

        let auditPermissionId: ObjectId;

        if (existingAuditPermission) {
            auditPermissionId = existingAuditPermission._id as ObjectId;
        } else {
            const created = await Permission.create({
                name: "auditLogs.read",
                description: "View audit logs",
            });
            auditPermissionId = created._id as ObjectId;
            createdPermissionId = auditPermissionId;
        }

        const permissions = await Permission.find({
            name: { $in: ["users.read", "users.create", "users.update", "users.delete", "products.read"] },
        }).select("_id name").lean();
        const perm = (name: string) => {
            const found = permissions.find((item) => item.name === name);
            if (!found) throw new Error(`Required permission missing: ${name}`);
            return found._id as ObjectId;
        };
        const usersAll = ["users.read", "users.create", "users.update", "users.delete"].map(perm);

        async function makeTenant(label: string) {
            const tenant = await Tenant.create({ name: `AUDIT-TEST-${label}-${suffix}`, status: "active" });
            createdTenantIds.push(tenant._id as ObjectId);
            return tenant._id as ObjectId;
        }

        async function makeRole(tenantId: ObjectId, name: string, perms: ObjectId[]) {
            return (await Role.create({ tenantId, name, permissions: perms, status: "active" }))._id as ObjectId;
        }

        async function makeUser(tenantId: ObjectId, label: string, roleId: ObjectId) {
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
                deviceId: `audit-test-${label}-${suffix}`,
                status: "active",
            });
            const { token } = await createUserSession({
                userId: user._id.toString(),
                tenantId: tenantId.toString(),
                deviceId: device._id.toString(),
                roleId: roleId.toString(),
            });
            return { id: user._id.toString(), deviceDocId: device._id.toString(), token };
        }

        const tenantA = await makeTenant("A");
        const tenantB = await makeTenant("B");

        // Owner admin WITHOUT audit permission: admins do not get it implicitly.
        const adminRoleA = await makeRole(tenantA, "Admin", [...usersAll, perm("products.read")]);
        const auditorRoleA = await makeRole(tenantA, "Auditor", [auditPermissionId]);
        const cashierRoleA = await makeRole(tenantA, "Cashier", [perm("products.read")]);
        const auditorRoleB = await makeRole(tenantB, "Auditor", [auditPermissionId]);

        const ownerA = await makeUser(tenantA, "owner-a", adminRoleA);
        const managerA = await makeUser(tenantA, "manager-a", adminRoleA);
        const auditorA = await makeUser(tenantA, "auditor-a", auditorRoleA);
        const cashierA = await makeUser(tenantA, "cashier-a", cashierRoleA);
        const auditorB = await makeUser(tenantB, "auditor-b", auditorRoleB);

        await Tenant.updateOne({ _id: tenantA }, { $set: { ownerUserId: new Types.ObjectId(ownerA.id) } });

        // ------------------------- 8/9. legitimate server-side audit events
        const createRes = await call(usersRoute.POST, {
            method: "POST",
            path: "/api/users",
            token: ownerA.token,
            body: {
                name: "Audited User",
                email: `audited-${suffix}@example.invalid`,
                password: "Long-Enough-Password-1",
                roleId: cashierRoleA.toString(),
            },
        });
        check("9. User Management create still works and audits (201)", createRes.status === 201, JSON.stringify(createRes.json));
        const auditedUserId: string = createRes.json.user?.id;

        const promoteRes = await call(userRoute.PATCH, {
            method: "PATCH",
            path: `/api/users/${auditedUserId}`,
            token: ownerA.token,
            body: { roleId: adminRoleA.toString() },
            params: { id: auditedUserId },
        });
        check("9. Owner promotion still works (200)", promoteRes.status === 200);

        const deniedRes = await call(userRoute.PATCH, {
            method: "PATCH",
            path: `/api/users/${cashierA.id}`,
            token: managerA.token,
            body: { roleId: adminRoleA.toString() },
            params: { id: cashierA.id },
        });
        check("9. Non-owner promotion still denied (403)", deniedRes.status === 403);

        await AuditLogService.createAuditLog(
            { userId: new Types.ObjectId(auditorB.id), tenantId: tenantB, deviceId: new Types.ObjectId(auditorB.deviceDocId) },
            { action: "test.server_event", entity: "Test", description: "Tenant B server-side event" }
        );
        check(
            "8. AuditLogService.createAuditLog (server-side) still writes records",
            Boolean(await AuditLog.exists({ tenantId: tenantB, action: "test.server_event" }))
        );

        const expectedActions = ["user.created", "user.role_changed", "user.admin_granted", "user.privilege_escalation_denied"];
        const tenantAActions = (await AuditLog.find({ tenantId: tenantA }).select("action").lean()).map((log) => log.action);
        check(
            "9. User Management events recorded (created, role_changed, admin_granted, escalation_denied)",
            expectedActions.every((action) => tenantAActions.includes(action)),
            tenantAActions.join(",")
        );

        const anyLogA = await AuditLog.findOne({ tenantId: tenantA }).select("_id").lean();
        const logB = await AuditLog.findOne({ tenantId: tenantB }).select("_id").lean();
        const logAId = String(anyLogA?._id);
        const logBId = String(logB?._id);

        // ------------------------------------------------ 1. unauthenticated
        check("1. Unauthenticated list rejected (401)", (await listLogs(undefined)).status === 401);
        check("1. Unauthenticated single read rejected (401)", (await getLog(undefined, logAId)).status === 401);
        check("1. Forged session rejected (401)", (await listLogs("forged.session.token")).status === 401);

        // ------------------------------------------- 2. no audit permission
        check("2. Cashier cannot list audit logs (403)", (await listLogs(cashierA.token)).status === 403);
        check("2. Cashier cannot read an audit log (403)", (await getLog(cashierA.token, logAId)).status === 403);
        check("2. Admin without auditLogs.read cannot list (403)", (await listLogs(ownerA.token)).status === 403);

        // ----------------------------------------------------- 3. authorized
        const listA = await listLogs(auditorA.token, "?limit=100");
        const tenantALogIds = (await AuditLog.find({ tenantId: tenantA }).select("_id").lean()).map((log) => String(log._id));
        check("3. Auditor can list own-tenant logs (200)", listA.status === 200, JSON.stringify(listA.json));
        check(
            "3. List returns exactly own-tenant logs",
            listA.json.auditLogs?.length === tenantALogIds.length &&
            listA.json.auditLogs.every((log: Json) => tenantALogIds.includes(log.id))
        );
        const single = await getLog(auditorA.token, logAId);
        check("3. Auditor can read a single own-tenant log (200)", single.status === 200 && single.json.auditLog?.id === logAId);
        const filtered = await listLogs(auditorA.token, "?action=user.admin_granted");
        check(
            "3. Filter by action works",
            filtered.status === 200 && filtered.json.auditLogs.length >= 1 &&
            filtered.json.auditLogs.every((log: Json) => log.action === "user.admin_granted")
        );
        const allowedKeys = ["id", "action", "entity", "entityId", "description", "actorUserId", "deviceId", "oldValues", "newValues", "createdAt"];
        check(
            "3. Only whitelisted fields returned (no tenantId, __v)",
            listA.json.auditLogs.every((log: Json) => Object.keys(log).every((key) => allowedKeys.includes(key)))
        );
        check("3. Invalid query rejected (400)", (await listLogs(auditorA.token, "?limit=1000")).status === 400);
        check("3. Invalid entityId rejected (400)", (await listLogs(auditorA.token, "?entityId=bad")).status === 400);
        check("3. Invalid audit log ID rejected (400)", (await getLog(auditorA.token, "123")).status === 400);

        // -------------------------------------------------- 4. cross-tenant
        check("4. Other tenant's log returns 404", (await getLog(auditorA.token, logBId)).status === 404);
        check("4. List never includes other tenant's logs", listA.json.auditLogs.every((log: Json) => log.id !== logBId));
        check(
            "4. Client-supplied tenantId is rejected (400)",
            (await listLogs(auditorA.token, `?tenantId=${tenantB}`)).status === 400
        );
        const listB = await listLogs(auditorB.token);
        check(
            "4. Tenant B auditor sees only tenant B logs",
            listB.status === 200 && listB.json.auditLogs.every((log: Json) => !tenantALogIds.includes(log.id))
        );

        // ------------------------------------- 5/6/7. creation is impossible
        check("5. Audit-log list route exports no POST handler", !("POST" in auditListRoute));
        check(
            "5. Audit-log routes export no write handlers",
            ["POST", "PUT", "PATCH", "DELETE"].every((method) => !(method in auditListRoute) && !(method in auditItemRoute))
        );
        // The HTTP-level 405/404 behavior is verified separately against a
        // running server (see final report), since Next.js produces it.

        // Ownership/device integrity of server-written records.
        const createdAudit = await AuditLog.findOne({
            tenantId: tenantA,
            action: "user.created",
            entityId: new Types.ObjectId(auditedUserId),
        }).lean();
        check(
            "7. Server-written record uses session actor and session device",
            createdAudit?.userId.toString() === ownerA.id &&
            createdAudit?.deviceId?.toString() === ownerA.deviceDocId
        );
        const grantByNonOwner = await AuditLog.exists({
            tenantId: tenantA,
            action: "user.admin_granted",
            userId: new Types.ObjectId(managerA.id),
        });
        check("6. No admin_granted event attributed to the non-owner", !grantByNonOwner);

        // ------------------------------------------- inactive role / fail closed
        await Role.updateOne({ _id: auditorRoleA }, { $set: { status: "inactive" } });
        check("2. Auditor with inactive role rejected (403)", (await listLogs(auditorA.token)).status === 403);
        await Role.updateOne({ _id: auditorRoleA }, { $set: { status: "active" } });

        if (createdPermissionId) {
            // Remove the catalog entry while a role still references its ID.
            await Permission.deleteOne({ _id: createdPermissionId });
            check(
                "2. Fails closed when auditLogs.read is missing from the catalog (403)",
                (await listLogs(auditorA.token)).status === 403
            );
            createdPermissionId = null;
        } else {
            skip(
                "2. Fail-closed when permission missing from catalog",
                "auditLogs.read already exists in this database and is not removed by tests"
            );
        }
    } finally {
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
        }

        if (createdPermissionId) {
            await Permission.deleteOne({ _id: createdPermissionId });
        }

        console.log(`\nCleaned up ${createdTenantIds.length} test tenants and their records.`);
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
    console.error("Audit log tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
