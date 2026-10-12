
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";

async function main() {
    try {
        await connectDB();

        const tenantId = new mongoose.Types.ObjectId(
            "6abe48a86ae4b08a3e335303"
        );

        const roleId = new mongoose.Types.ObjectId(
            "6abe4d3f6ae4b08a3e335462"
        );

        const permissionId = new mongoose.Types.ObjectId(
            "6ac8913ed2c476b904f1c0a8"
        );

        const permission = await Permission.findOne({
            _id: permissionId,
            name: "products.update",
        });

        if (!permission) {
            throw new Error(
                "The products.update permission was not found."
            );
        }

        const role = await Role.findOne({
            _id: roleId,
            tenantId,
            name: "Admin",
            status: "active",
        });

        if (!role) {
            throw new Error(
                "The active Admin role was not found for Test Business."
            );
        }

        const alreadyAssigned = role.permissions.some(
            (id) => id.toString() === permissionId.toString()
        );

        if (!alreadyAssigned) {
            role.permissions.push(permissionId);
            await role.save();
        }

        console.log("Permission assignment verified.");
        console.log("Role:", role.name);
        console.log(
            "Permissions:",
            await Permission.find({
                _id: { $in: role.permissions },
            }).select("name")
        );
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error("Permission assignment failed:", error);
    process.exitCode = 1;
});