
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Tenant } from "../lib/models/Tenant";
import { User } from "../lib/models/User";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";
import { Device } from "../lib/models/Device";
import { hashPassword } from "../app/api/auth/password";

const TENANT_ID = "6abe48a86ae4b08a3e335303";

const ACCOUNTS = [
    {
        name: "Business Owner",
        email: "owner@testbusiness.com",
        passwordEnv: "TEST_BUSINESS_OWNER_PASSWORD",
        roleName: "Business Owner",
        description: "Demo business owner",
        permissions: [
            "products.read",
            "products.create",
            "products.update",
            "products.delete",
            "users.read",
            "users.create",
            "users.update",
            "users.delete",
        ],
        deviceId: "dev_test_business_owner_001",
        deviceName: "Test Business Owner Device",
    },
    {
        name: "Business Manager",
        email: "manager@testbusiness.com",
        passwordEnv: "TEST_BUSINESS_MANAGER_PASSWORD",
        roleName: "Manager",
        description: "Demo manager with product management access",
        permissions: [
            "products.read",
            "products.create",
            "products.update",
        ],
        deviceId: "dev_test_business_manager_001",
        deviceName: "Test Business Manager Device",
    },
    {
        name: "Business Staff",
        email: "staff@testbusiness.com",
        passwordEnv: "TEST_BUSINESS_STAFF_PASSWORD",
        roleName: "Staff",
        description: "Demo staff with read-only product access",
        permissions: ["products.read"],
        deviceId: "dev_test_business_staff_001",
        deviceName: "Test Business Staff Device",
    },
] as const;

function sameStrings(a: string[], b: readonly string[]) {
    return (
        [...a].sort().join("|") ===
        [...b].sort().join("|")
    );
}

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("This demo setup script cannot run in production.");
    }

    if (process.env.ALLOW_TEST_BUSINESS_DEMO_SETUP !== "YES") {
        throw new Error(
            "Set ALLOW_TEST_BUSINESS_DEMO_SETUP=YES to confirm this development setup."
        );
    }

    for (const account of ACCOUNTS) {
        const password = process.env[account.passwordEnv];

        if (!password || password.length < 12 || password.length > 128) {
            throw new Error(
                `${account.passwordEnv} must contain a password between 12 and 128 characters.`
            );
        }
    }

    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_ID);

    try {
        const tenant = await Tenant.findOne({
            _id: tenantId,
            status: "active",
        }).lean();

        if (!tenant) {
            throw new Error("Active Test Business tenant not found.");
        }

        // Verify the existing Administrator. Do not change this account.
        const admin = await User.findOne({
            tenantId,
            email: "admin@testbusiness.com",
            status: "active",
        }).select("_id roleId").lean();

        if (!admin?.roleId) {
            throw new Error(
                "Existing active admin@testbusiness.com account was not found, or it has no role. No demo accounts were processed."
            );
        }

        const adminRole = await Role.findOne({
            _id: admin.roleId,
            tenantId,
            status: "active",
        }).lean();

        if (!adminRole || adminRole.name !== "Admin") {
            throw new Error(
                "The existing admin account does not have the expected active Admin role."
            );
        }

        const permissionDocs = await Permission.find({
            name: {
                $in: [
                    "products.read",
                    "products.create",
                    "products.update",
                    "products.delete",
                    "users.read",
                    "users.create",
                    "users.update",
                    "users.delete",
                ],
            },
        }).select("_id name").lean();

        const permissionIdByName = new Map(
            permissionDocs.map((permission) => [
                permission.name,
                permission._id,
            ])
        );

        const requiredPermissions = [
            "products.read",
            "products.create",
            "products.update",
            "products.delete",
            "users.read",
            "users.create",
            "users.update",
            "users.delete",
        ];

        const missing = requiredPermissions.filter(
            (name) => !permissionIdByName.has(name)
        );

        if (missing.length) {
            throw new Error(
                `Missing required permissions: ${missing.join(", ")}. No demo accounts were processed.`
            );
        }

        // Confirm that the existing Admin has the expected eight permissions.
        const adminPermissionDocs = await Permission.find({
            _id: { $in: adminRole.permissions },
        }).select("name").lean();

        const adminPermissionNames = adminPermissionDocs.map((p) => p.name);

        if (!sameStrings(adminPermissionNames, requiredPermissions)) {
            throw new Error(
                "Existing Admin permissions differ from the expected eight. No demo accounts were processed."
            );
        }

        for (const account of ACCOUNTS) {
            const expectedPermissionIds = account.permissions.map((name) => {
                const id = permissionIdByName.get(name);
                if (!id) throw new Error(`Permission missing: ${name}`);
                return id;
            });

            let role = await Role.findOne({
                tenantId,
                name: account.roleName,
            });

            if (!role) {
                role = await Role.create({
                    tenantId,
                    name: account.roleName,
                    description: account.description,
                    permissions: expectedPermissionIds,
                    status: "active",
                });
                console.log(`Created role: ${account.roleName}`);
            } else {
                const currentPermissionDocs = await Permission.find({
                    _id: { $in: role.permissions },
                }).select("name").lean();

                const currentNames = currentPermissionDocs.map((p) => p.name);

                if (
                    role.status !== "active" ||
                    !sameStrings(currentNames, account.permissions)
                ) {
                    throw new Error(
                        `Role "${account.roleName}" already exists with different permissions or inactive status. It was not modified.`
                    );
                }

                console.log(`Reusing role: ${account.roleName}`);
            }

            let user = await User.findOne({
                tenantId,
                email: account.email,
            });

            if (!user) {
                const password = process.env[account.passwordEnv]!;
                const passwordHash = await hashPassword(password);

                user = await User.create({
                    tenantId,
                    name: account.name,
                    email: account.email,
                    passwordHash,
                    roleId: role._id,
                    status: "active",
                    mustChangePassword: true,
                });

                console.log(`Created user: ${account.email}`);
            } else {
                if (
                    user.status !== "active" ||
                    !user.roleId ||
                    !user.roleId.equals(role._id)
                ) {
                    throw new Error(
                        `User ${account.email} already exists but is inactive or has a different role. It was not modified.`
                    );
                }

                // Never reset an existing password or silently change its role.
                console.log(`Reusing existing user without changing password: ${account.email}`);
            }

            let device = await Device.findOne({
                tenantId,
                deviceId: account.deviceId,
            });

            if (!device) {
                await Device.create({
                    tenantId,
                    userId: user._id,
                    deviceName: account.deviceName,
                    deviceType: "desktop",
                    deviceId: account.deviceId,
                    status: "active",
                });
                console.log(`Registered device: ${account.deviceId}`);
            } else if (
                !device.userId.equals(user._id) ||
                device.status !== "active"
            ) {
                throw new Error(
                    `Device ID ${account.deviceId} already exists but is inactive or belongs to another user. It was not modified.`
                );
            } else {
                console.log(`Reusing registered device: ${account.deviceId}`);
            }

            console.log({
                email: account.email,
                userId: user._id.toString(),
                role: account.roleName,
                deviceId: account.deviceId,
                mustChangePassword: user.mustChangePassword ?? false,
            });
        }

        console.log(
            "\nDemo account setup finished. The existing Admin account and other tenants were not intentionally modified."
        );
        console.log(
            "Next: verify the accounts, then designate the owner using the separate owner-designation script."
        );
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error: unknown) => {
    console.error(
        "Test Business demo setup failed:",
        error instanceof Error ? error.message : "Unknown error"
    );
    process.exitCode = 1;
});
