
import mongoose from "mongoose";
import { connectDB } from "../lib/db/mongodb";
import { Role } from "../lib/models/Role";
import { Permission } from "../lib/models/Permission";

const TENANT_B_ID = "6ac62f56069cfae17a670203";

const REQUIRED_PERMISSIONS = [
    "products.read",
    "users.create",
    "users.read",
];

async function main() {
    await connectDB();

    const tenantId = new mongoose.Types.ObjectId(TENANT_B_ID);

    const permissions = await Permission.find({
        name: { $in: REQUIRED_PERMISSIONS },
    }).select("_id name").lean();

    const foundNames = new Set(permissions.map((p) => p.name));
    const missing = REQUIRED_PERMISSIONS.filter(
        (name) => !foundNames.has(name)
    );

    if (missing.length > 0) {
        throw new Error(
            `Missing permissions: ${missing.join(", ")}`
        );
    }

    const role = await Role.findOneAndUpdate(
        {
            tenantId,
            name: "Tenant B Isolation Tester",
        },
        {
            $setOnInsert: {
                tenantId,
                name: "Tenant B Isolation Tester",
                description: "Temporary role for tenant-isolation testing",
                permissions: permissions.map((p) => p._id),
                status: "active",
            },
        },
        {
            upsert: true,
            new: true,
            runValidators: true,
        }
    );

    console.log("Tenant B test role ready:");
    console.log({
        roleId: String(role._id),
        tenantId: String(role.tenantId),
        name: role.name,
        permissions: REQUIRED_PERMISSIONS,
    });
}

main()
    .catch((error) => {
        console.error("Role setup failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
