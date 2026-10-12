
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";

const TENANT_ID = "6abe48a86ae4b08a3e335303";
const ADMIN_ROLE_ID = "6abe4d3f6ae4b08a3e335462";
const PERMISSION_ID = "6ac89eb3493e3f65823723d9";

async function main() {
    try {
        await connectDB();

        const permission = await Permission.findById(PERMISSION_ID);

        if (!permission || permission.name !== "products.delete") {
            throw new Error("products.delete permission was not found");
        }

        const role = await Role.findOne({
            _id: new mongoose.Types.ObjectId(ADMIN_ROLE_ID),
            tenantId: new mongoose.Types.ObjectId(TENANT_ID),
            name: "Admin",
            status: "active",
        });

        if (!role) {
            throw new Error("Active Admin role was not found");
        }

        const alreadyAssigned = role.permissions.some(
            (id) => id.toString() === permission._id.toString()
        );

        if (!alreadyAssigned) {
            role.permissions.push(permission._id);
            await role.save();
        }

        const verifiedRole = await Role.findById(role._id)
            .populate("permissions", "name description")
            .lean();

        console.log("Permission assignment verified.");
        console.dir(verifiedRole, { depth: null });
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error("Failed to assign permission:", error);
    process.exitCode = 1;
});