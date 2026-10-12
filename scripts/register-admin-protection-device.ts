
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Device } from "../lib/models/Device";
import { User } from "../lib/models/User";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const TENANT_ID = "6abe48a86ae4b08a3e335303";
const USER_ID = "6ac9c048bc8d48ae104a7151";
const DEVICE_ID = "dev_admin_protection_test_001";

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("This test script cannot run in production.");
    }

    if (process.env.ALLOW_ADMIN_PROTECTION_TEST !== "YES") {
        throw new Error(
            "Set ALLOW_ADMIN_PROTECTION_TEST=YES to run this test script."
        );
    }

    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_ID);
    const userId = new mongoose.Types.ObjectId(USER_ID);

    const user = await User.findOne({
        _id: userId,
        tenantId,
        status: "active",
    }).select("_id email tenantId status");

    if (!user) {
        throw new Error(
            "The expected active test user was not found in Tenant A."
        );
    }

    const existingDevice = await Device.findOne({
        tenantId,
        deviceId: DEVICE_ID,
    });

    if (existingDevice) {
        if (!existingDevice.userId.equals(userId)) {
            throw new Error(
                "This device ID belongs to another user. No changes were made."
            );
        }

        if (existingDevice.status !== "active") {
            throw new Error(
                "The test device already exists but is inactive. No changes were made."
            );
        }

        console.log("The test device is already registered and active.");
        return;
    }

    await Device.create({
        tenantId,
        userId,
        deviceName: "Admin Protection Test Device",
        deviceType: "desktop",
        deviceId: DEVICE_ID,
        status: "active",
    });

    console.log("Test device registered successfully.");
    console.log("Test user:", user.email);
    console.log("Device ID:", DEVICE_ID);
}

main()
    .catch((error) => {
        console.error("Device registration failed:", error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
