
import { loadEnvConfig } from "@next/env";
import { assertTestDatabaseUri } from "./lib/testDatabaseGuard";
loadEnvConfig(process.cwd());

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { User } from "../lib/models/User";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";
import { Tenant } from "../lib/models/Tenant";
import { hasPermission } from "../lib/auth/hasPermission";

async function main() {
    // Only the dedicated test database, checked before anything connects
    // (this script has no allow flag and creates and deletes records).
    assertTestDatabaseUri(process.env.MONGODB_URI);

    const createdUserIds: mongoose.Types.ObjectId[] = [];
    const createdRoleIds: mongoose.Types.ObjectId[] = [];
    const createdTenantIds: mongoose.Types.ObjectId[] = [];

    try {
        await connectDB();
        console.log("Connected to database.");

        // Use an existing permission without modifying it.
        const permission = await Permission.findOne().select("_id name").lean();
        if (!permission) {
            throw new Error("No permission exists. Seed permissions first.");
        }

        // Create two dedicated temporary tenants so no real tenant
        // is ever touched. They are deleted in the finally block.
        const suffix = Date.now().toString(36);
        const [tenantADoc, tenantBDoc] = await Tenant.create([
            { name: `PERM-TEST-A-${suffix}`, status: "active" },
            { name: `PERM-TEST-B-${suffix}`, status: "active" },
        ]);
        createdTenantIds.push(tenantADoc._id, tenantBDoc._id);

        const tenantA = tenantADoc._id;
        const tenantB = tenantBDoc._id;

        // Create a temporary role in tenant A with one existing permission.
        const roleA = await Role.create({
            tenantId: tenantA,
            name: `TEMP_PERMISSION_TEST_${Date.now()}`,
            permissions: [permission._id],
            status: "active",
        });
        createdRoleIds.push(roleA._id);

        // Create a temporary active user assigned to that role.
        const userA = await User.create({
            tenantId: tenantA,
            name: "Temporary Permission Test User",
            email: `permission-test-${Date.now()}@example.invalid`,
            passwordHash: "NOT_FOR_LOGIN_TEST",
            roleId: roleA._id,
            status: "active",
        });
        createdUserIds.push(userA._id);

        // Test 1: correct role and permission should be allowed.
        const correctRoleResult = await hasPermission({
            userId: userA._id.toString(),
            tenantId: tenantA.toString(),
            roleId: roleA._id.toString(),
            permission: permission.name,
        });

        console.log(
            "TEST 1 — Actual role permission:",
            correctRoleResult ? "PASS" : "FAIL"
        );

        // Test 2: a different valid ObjectId must be rejected.
        const otherRoleId = new mongoose.Types.ObjectId().toString();
        const wrongRoleResult = await hasPermission({
            userId: userA._id.toString(),
            tenantId: tenantA.toString(),
            roleId: otherRoleId,
            permission: permission.name,
        });

        console.log(
            "TEST 2 — Different role ID denied:",
            !wrongRoleResult ? "PASS" : "FAIL"
        );

        // Test 3: the same user cannot be checked under tenant B.
        const crossTenantResult = await hasPermission({
            userId: userA._id.toString(),
            tenantId: tenantB.toString(),
            roleId: roleA._id.toString(),
            permission: permission.name,
        });

        console.log(
            "TEST 3 — Cross-tenant access denied:",
            !crossTenantResult ? "PASS" : "FAIL"
        );

        // Test 4: an inactive user must be denied.
        await User.updateOne(
            { _id: userA._id },
            { $set: { status: "inactive" } }
        );

        const inactiveUserResult = await hasPermission({
            userId: userA._id.toString(),
            tenantId: tenantA.toString(),
            roleId: roleA._id.toString(),
            permission: permission.name,
        });

        console.log(
            "TEST 4 — Inactive user denied:",
            !inactiveUserResult ? "PASS" : "FAIL"
        );

        // Reactivate only the temporary user so we can test the inactive role.
        await User.updateOne(
            { _id: userA._id },
            { $set: { status: "active" } }
        );

        await Role.updateOne(
            { _id: roleA._id },
            { $set: { status: "inactive" } }
        );

        const inactiveRoleResult = await hasPermission({
            userId: userA._id.toString(),
            tenantId: tenantA.toString(),
            roleId: roleA._id.toString(),
            permission: permission.name,
        });

        console.log(
            "TEST 5 — Inactive role denied:",
            !inactiveRoleResult ? "PASS" : "FAIL"
        );
    } finally {
        // Remove only the temporary records created by this script.
        if (createdUserIds.length) {
            await User.deleteMany({ _id: { $in: createdUserIds } });
        }

        if (createdRoleIds.length) {
            await Role.deleteMany({ _id: { $in: createdRoleIds } });
        }

        if (createdTenantIds.length) {
            await Tenant.deleteMany({ _id: { $in: createdTenantIds } });
        }

        await mongoose.disconnect();
        console.log("Temporary test records cleaned up.");
    }
}

main().catch((error) => {
    console.error("Permission security test failed:", error);
    process.exitCode = 1;
});
