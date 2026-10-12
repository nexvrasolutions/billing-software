
import { config } from "dotenv";
config({ path: ".env.local" });

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Device } from "../lib/models/Device";
import { User } from "../lib/models/User";

async function main() {
    await connectDB();

    const user = await User.findOne({
        email: "permission-test@testbusiness.com",
        tenantId: new mongoose.Types.ObjectId(
            "6abe48a86ae4b08a3e335303"
        ),
    }).select("_id email").lean();

    if (!user) {
        console.log("Test user not found.");
        return;
    }

    const device = await Device.findOne({
        userId: user._id,
        tenantId: new mongoose.Types.ObjectId(
            "6abe48a86ae4b08a3e335303"
        ),
        status: "active",
    }).select("deviceId deviceName status").lean();

    if (!device) {
        console.log("No active device found for this test user.");
        return;
    }

    console.log("Test email:", user.email);
    console.log("Device name:", device.deviceName);
    console.log("Device ID:", device.deviceId);
    console.log("Device status:", device.status);
}

main()
    .catch((error) => {
        console.error("Lookup failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });