
import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
dns.setDefaultResultOrder("ipv4first");

import mongoose from "mongoose";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";

const TENANT_B_ID = "6ac62f56069cfae17a670203";
const TENANT_B_ROLE_ID = "6aca1bfe493e3f658237c99a";

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not defined");

    await mongoose.connect(uri);

    try {
        const role = await Role.findOne({
            _id: TENANT_B_ROLE_ID,
            tenantId: TENANT_B_ID,
        });

        if (!role) throw new Error("Tenant B test role not found");

        const permissions = await Permission.find({
            name: { $in: ["products.update", "products.delete"] },
        }).select("_id name");

        const temporaryIds = new Set(
            permissions.map((permission) => permission._id.toString())
        );

        role.permissions = role.permissions.filter(
            (id) => !temporaryIds.has(id.toString())
        );

        await role.save();

        console.log("Temporary test permissions removed.");
        console.log("Other role permissions were preserved.");
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error("Failed to remove test permissions:", error);
    process.exitCode = 1;
});
