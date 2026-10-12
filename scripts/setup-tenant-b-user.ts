
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { User } from "../lib/models/User";
import { Role } from "../lib/models/Role";
import { Device } from "../lib/models/Device";
import { hashPassword } from "../app/api/auth/password";

const TENANT_B_ID = "6ac62f56069cfae17a670203";
const ROLE_ID = "6aca1bfe493e3f658237c99a";

const EMAIL = "tenant-b-isolation@testbusiness.com";
const PASSWORD = "TenantB-Test-2026-Secure";

const DEVICE_ID = "dev_tenant_b_isolation_001";

async function main() {
    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_B_ID);
    const roleId = new mongoose.Types.ObjectId(ROLE_ID);

    // Confirm the role belongs to Tenant B.
    const role = await Role.findOne({
        _id: roleId,
        tenantId,
        status: "active",
    }).lean();

    if (!role) {
        throw new Error("Tenant B role not found or inactive");
    }

    // Reuse the test user if it already exists.
    let user = await User.findOne({ tenantId, email: EMAIL });

    if (!user) {
        const passwordHash = await hashPassword(PASSWORD);

        user = await User.create({
            tenantId,
            name: "Tenant B Isolation Tester",
            email: EMAIL,
            passwordHash,
            roleId,
            status: "active",
        });
    } else {
        // Ensure the existing test user has the intended role.
        user.roleId = roleId;
        user.status = "active";
        await user.save();
    }

    // Ensure this device belongs to the test user and Tenant B.
    let device = await Device.findOne({
        tenantId,
        deviceId: DEVICE_ID,
    });

    if (!device) {
        device = await Device.create({
            tenantId,
            userId: user._id,
            deviceName: "Tenant B Isolation Test Device",
            deviceType: "desktop",
            deviceId: DEVICE_ID,
            status: "active",
        });
    } else {
        device.userId = user._id;
        device.status = "active";
        await device.save();
    }

    console.log("Tenant B test setup completed:");
    console.log({
        tenantId: String(tenantId),
        userId: String(user._id),
        email: EMAIL,
        roleId: String(user.roleId),
        deviceId: DEVICE_ID,
    });
    console.log("Test password:", PASSWORD);
}

main()
    .catch((error) => {
        console.error("Tenant B user setup failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
