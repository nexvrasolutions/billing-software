
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";

const TENANT_ID = "6abe48a86ae4b08a3e335303";
const ADMIN_ROLE_ID = "6abe4d3f6ae4b08a3e335462";
const READ_PERMISSION_ID = "6ac8a5ab493e3f6582372a26";

async function main() {
    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_ID);
    const roleId = new mongoose.Types.ObjectId(ADMIN_ROLE_ID);
    const permissionId = new mongoose.Types.ObjectId(READ_PERMISSION_ID);

    const permission = await Permission.findOne({
        _id: permissionId,
        name: "products.read",
    });

    if (!permission) {
        throw new Error("products.read permission was not found.");
    }

    const role = await Role.findOne({
        _id: roleId,
        tenantId,
        name: "Admin",
        status: "active",
    });

    if (!role) {
        throw new Error("Active Admin role was not found for Tenant A.");
    }

    const alreadyAssigned = role.permissions.some(
        (id) => id.toString() === permissionId.toString()
    );

    if (!alreadyAssigned) {
        role.permissions.push(permissionId);
        await role.save();
    }

    console.log("Product read permission assigned successfully.");
    console.log({
        role: role.name,
        tenantId: role.tenantId.toString(),
        permission: permission.name,
        alreadyAssigned,
    });

    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error("Failed to assign product read permission:", error);
    await mongoose.disconnect();
    process.exitCode = 1;
});