
import { config } from "dotenv";
config({ path: ".env.local" });

import mongoose from "mongoose";
import { randomUUID } from "crypto";

import { connectDB } from "../lib/db/mongodb";
import { User } from "../lib/models/User";
import { Role } from "../lib/models/Role";
import { Device } from "../lib/models/Device";
import { hashPassword } from "../app/api/auth/password";

async function main() {
    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(
        "6abe48a86ae4b08a3e335303"
    );

    const roleId = new mongoose.Types.ObjectId(
        "6ac88705ee5f0bc9bc078c35"
    );

    const email = "permission-test@testbusiness.com";

    // Stop if this test user already exists.
    const existingUser = await User.findOne({
        tenantId,
        email,
    });

    if (existingUser) {
        throw new Error(
            "Test user already exists. No changes were made."
        );
    }

    // Verify that the role is active and has no permissions.
    const role = await Role.findOne({
        _id: roleId,
        tenantId,
        status: "active",
    }).lean();

    if (!role || role.permissions.length !== 0) {
        throw new Error(
            "The test role is missing, inactive, or has permissions."
        );
    }

    const password = "PermissionTest-482!ChangeMe";

    const user = await User.create({
        tenantId,
        name: "Permission Test User",
        email,
        passwordHash: await hashPassword(password),
        roleId,
        status: "active",
    });

    try {
        const deviceId = `permission-test-${randomUUID()}`;

        const device = await Device.create({
            tenantId,
            userId: user._id,
            deviceName: "Permission Test Device",
            deviceType: "desktop",
            deviceId,
            status: "active",
        });

        console.log("Test user and device created successfully.");
        console.log("User ID:", user._id.toString());
        console.log("Email:", email);
        console.log("Role:", role.name);
        console.log("Device ID:", device.deviceId);
        console.log("Temporary password:", password);
    } catch (error) {
        // Roll back the user if device creation fails.
        await User.deleteOne({ _id: user._id });
        throw error;
    }
}

main()
    .catch((error) => {
        console.error("Test setup failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });