
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
    const mongoose = (await import("mongoose")).default;
    const { connectDB } = await import("../lib/db/mongodb");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");

    try {
        await connectDB();

        const tenantId = new mongoose.Types.ObjectId(
            "6abe48a86ae4b08a3e335303"
        );

        const roles = await Role.find({ tenantId })
            .select("_id name description permissions status")
            .lean();

        for (const role of roles) {
            const permissions = await Permission.find({
                _id: { $in: role.permissions },
            })
                .select("name")
                .lean();

            console.log(
                JSON.stringify(
                    {
                        roleId: role._id.toString(),
                        name: role.name,
                        description: role.description,
                        status: role.status,
                        permissions: permissions.map((p) => p.name).sort(),
                    },
                    null,
                    2
                )
            );
        }

        const catalog = await Permission.find({})
            .select("name")
            .sort({ name: 1 })
            .lean();

        console.log(
            "ALL PERMISSIONS:",
            catalog.map((p) => p.name)
        );
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error("Role inspection failed:", error);
    process.exitCode = 1;
});
