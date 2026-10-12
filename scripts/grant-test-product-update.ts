
import mongoose from "mongoose";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";
import dns from "node:dns";

dns.setServers([
    "8.8.8.8",
    "1.1.1.1",
    "8.8.4.4",
]);

dns.setDefaultResultOrder("ipv4first");
const TENANT_B_ID = "6ac62f56069cfae17a670203";
const TENANT_B_ROLE_ID = "6aca1bfe493e3f658237c99a";

async function main() {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
        throw new Error("MONGODB_URI is not defined");
    }

    await mongoose.connect(uri);

    try {
        const role = await Role.findOne({
            _id: TENANT_B_ROLE_ID,
            tenantId: TENANT_B_ID,
            status: "active",
        });

        if (!role) {
            throw new Error("Tenant B test role not found");
        }

        const permission = await Permission.findOne({
            name: "products.delete",
        }).select("_id");

        if (!permission) {
            throw new Error("products.update permission not found");
        }

        const alreadyHasPermission = role.permissions.some(
            (id) => id.toString() === permission._id.toString()
        );

        if (alreadyHasPermission) {
            console.log("Role already has products.update.");
            return;
        }

        role.permissions.push(permission._id);
        await role.save();

        console.log("Permission added successfully.");
        console.log("Role:", role.name);
        console.log("Permission: products.update");
        console.log("Existing permissions were preserved.");
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error("Failed to grant test permission:", error);
    process.exitCode = 1;
});
