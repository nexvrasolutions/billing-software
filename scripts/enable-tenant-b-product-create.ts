
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";

const TENANT_B_ID = "6ac62f56069cfae17a670203";
const ROLE_ID = "6aca1bfe493e3f658237c99a";

async function main() {
    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_B_ID);
    const roleId = new mongoose.Types.ObjectId(ROLE_ID);

    const permission = await Permission.findOne({
        name: "products.create",
    }).lean();

    if (!permission) {
        throw new Error("Global products.create permission not found");
    }

    const role = await Role.findOne({
        _id: roleId,
        tenantId,
        status: "active",
    });

    if (!role) {
        throw new Error("Active Tenant B test role not found");
    }

    const alreadyAssigned = role.permissions.some(
        (id) => id.toString() === permission._id.toString()
    );

    if (!alreadyAssigned) {
        role.permissions.push(permission._id);
        await role.save();
    }

    console.log("Tenant B test role updated.");
    console.log("Role:", role.name);
    console.log("Added permission: products.create");
}

main()
    .catch((error) => {
        console.error("Failed to update test role:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
