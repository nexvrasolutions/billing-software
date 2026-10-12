
/*
 * Set up the "auditLogs.read" permission.
 *
 * Nothing is granted automatically. Each step must be requested explicitly.
 *
 * 1. Show status (read-only): does the permission exist, which roles have it?
 *      npx tsx scripts/setup-audit-log-permission.ts --status
 *
 * 2. Add the permission to the global permission catalog (grants it to nobody):
 *      CONFIRM_AUDIT_PERMISSION_SETUP=YES npx tsx scripts/setup-audit-log-permission.ts --create
 *
 * 3. Grant it to ONE role of ONE tenant (e.g. the owner's Admin role):
 *      CONFIRM_AUDIT_PERMISSION_SETUP=YES npx tsx scripts/setup-audit-log-permission.ts --grant --tenant <tenantId> --role <roleId>
 *
 * 4. Revoke it from a role:
 *      CONFIRM_AUDIT_PERMISSION_SETUP=YES npx tsx scripts/setup-audit-log-permission.ts --revoke --tenant <tenantId> --role <roleId>
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const PERMISSION_NAME = "auditLogs.read";

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
    const mongoose = (await import("mongoose")).default;
    const { connectDB } = await import("../lib/db/mongodb");
    const { Permission } = await import("../lib/models/Permission");
    const { Role } = await import("../lib/models/Role");
    const { Tenant } = await import("../lib/models/Tenant");

    const mode = ["--status", "--create", "--grant", "--revoke"].find((flag) =>
        process.argv.includes(flag)
    );

    if (!mode) {
        throw new Error("Choose one of: --status, --create, --grant, --revoke");
    }

    if (mode !== "--status" && process.env.CONFIRM_AUDIT_PERMISSION_SETUP !== "YES") {
        throw new Error(
            "Set CONFIRM_AUDIT_PERMISSION_SETUP=YES to confirm this change."
        );
    }

    try {
        await connectDB();

        if (mode === "--status") {
            const permission = await Permission.findOne({ name: PERMISSION_NAME })
                .select("_id")
                .lean();

            if (!permission) {
                console.log(`${PERMISSION_NAME}: NOT in the permission catalog (nobody can read audit logs).`);
                return;
            }

            console.log(`${PERMISSION_NAME}: exists (${permission._id}).`);

            const roles = await Role.find({ permissions: permission._id })
                .select("_id name tenantId status")
                .lean();

            if (!roles.length) {
                console.log("No role has this permission yet.");
            }

            for (const role of roles) {
                console.log(`  granted to role ${role._id} "${role.name}" (${role.status}) in tenant ${role.tenantId}`);
            }

            return;
        }

        if (mode === "--create") {
            const permission = await Permission.findOneAndUpdate(
                { name: PERMISSION_NAME },
                {
                    $setOnInsert: {
                        name: PERMISSION_NAME,
                        description: "View audit logs",
                    },
                },
                { upsert: true, returnDocument: "after" }
            );

            console.log(`${PERMISSION_NAME} is in the catalog (${permission?._id}). It is not granted to any role.`);
            return;
        }

        // --grant / --revoke
        const tenantIdArg = readArg("--tenant");
        const roleIdArg = readArg("--role");

        if (
            !tenantIdArg ||
            !roleIdArg ||
            !mongoose.Types.ObjectId.isValid(tenantIdArg) ||
            !mongoose.Types.ObjectId.isValid(roleIdArg)
        ) {
            throw new Error("Usage: --grant|--revoke --tenant <tenantId> --role <roleId>");
        }

        const tenantId = new mongoose.Types.ObjectId(tenantIdArg);
        const roleId = new mongoose.Types.ObjectId(roleIdArg);

        const [permission, tenant, role] = await Promise.all([
            Permission.findOne({ name: PERMISSION_NAME }).select("_id").lean(),
            Tenant.findById(tenantId).select("_id name").lean(),
            Role.findOne({ _id: roleId, tenantId }).select("_id name").lean(),
        ]);

        if (!permission) {
            throw new Error(`${PERMISSION_NAME} is not in the catalog. Run --create first. No changes made.`);
        }

        if (!tenant || !role) {
            throw new Error("Role not found in that tenant. No changes made.");
        }

        const update =
            mode === "--grant"
                ? { $addToSet: { permissions: permission._id } }
                : { $pull: { permissions: permission._id } };

        const result = await Role.updateOne({ _id: roleId, tenantId }, update);

        console.log(
            `${mode === "--grant" ? "Granted" : "Revoked"} ${PERMISSION_NAME} ${mode === "--grant" ? "to" : "from"} role "${role.name}" in tenant "${tenant.name}"` +
            (result.modifiedCount ? "." : " (no change was needed).")
        );
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error: unknown) => {
    console.error(
        "Audit permission setup failed:",
        error instanceof Error ? error.message : "Unknown error"
    );
    process.exitCode = 1;
});
