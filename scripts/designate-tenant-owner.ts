
/*
 * Designate (or list) the verified owner of a business (tenant).
 *
 * The owner is the only user who can grant administrator-level roles
 * through the User Management API. This is deliberately NOT exposed via
 * any API route: run it from a trusted machine after verifying, outside
 * the application, who actually owns the business.
 *
 * List tenants, current owners and administrator candidates:
 *   npx tsx scripts/designate-tenant-owner.ts --list
 *
 * Designate an owner:
 *   CONFIRM_OWNER_DESIGNATION=YES npx tsx scripts/designate-tenant-owner.ts --tenant <tenantId> --user <userId>
 *
 * Replace an existing owner (requires --replace):
 *   CONFIRM_OWNER_DESIGNATION=YES npx tsx scripts/designate-tenant-owner.ts --tenant <tenantId> --user <userId> --replace
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
    const mongoose = (await import("mongoose")).default;
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Role } = await import("../lib/models/Role");
    const { getAdministratorRoleIds } = await import(
        "../lib/auth/isAdministratorRole"
    );
    const { AuditLogService } = await import(
        "../lib/services/AuditLogService"
    );

    try {
        await connectDB();

        if (process.argv.includes("--list")) {
            const tenants = await Tenant.find()
                .select("_id name status ownerUserId")
                .lean();

            for (const tenant of tenants) {
                console.log(
                    `\nTenant ${tenant._id} "${tenant.name}" (${tenant.status}) owner: ${tenant.ownerUserId ?? "NOT DESIGNATED"}`
                );

                const adminRoleIds = await getAdministratorRoleIds(
                    tenant._id as InstanceType<typeof mongoose.Types.ObjectId>
                ).catch(() => []);

                const admins = await User.find({
                    tenantId: tenant._id,
                    status: "active",
                    roleId: { $in: adminRoleIds },
                })
                    .select("_id email roleId")
                    .lean();

                for (const admin of admins) {
                    const role = await Role.findById(admin.roleId)
                        .select("name")
                        .lean();
                    console.log(
                        `  admin candidate: ${admin._id} ${admin.email} (role: ${role?.name ?? "?"})`
                    );
                }
            }

            return;
        }

        const tenantIdArg = readArg("--tenant");
        const userIdArg = readArg("--user");
        const replace = process.argv.includes("--replace");

        if (
            !tenantIdArg ||
            !userIdArg ||
            !mongoose.Types.ObjectId.isValid(tenantIdArg) ||
            !mongoose.Types.ObjectId.isValid(userIdArg)
        ) {
            throw new Error(
                "Usage: --tenant <tenantId> --user <userId> [--replace]  (or --list)"
            );
        }

        if (process.env.CONFIRM_OWNER_DESIGNATION !== "YES") {
            throw new Error(
                "Set CONFIRM_OWNER_DESIGNATION=YES after verifying the real owner of this business."
            );
        }

        const tenantId = new mongoose.Types.ObjectId(tenantIdArg);
        const userId = new mongoose.Types.ObjectId(userIdArg);

        const session = await mongoose.startSession();

        try {
            await session.withTransaction(async () => {
                const tenant = await Tenant.findOne({
                    _id: tenantId,
                    status: "active",
                }).session(session);

                if (!tenant) {
                    throw new Error("Active tenant not found. No changes made.");
                }

                const user = await User.findOne({
                    _id: userId,
                    tenantId,
                    status: "active",
                })
                    .select("_id email")
                    .session(session);

                if (!user) {
                    throw new Error(
                        "Active user not found in this tenant. No changes made."
                    );
                }

                const previousOwner =
                    tenant.ownerUserId?.toString() ?? null;

                if (previousOwner === userId.toString()) {
                    console.log("This user is already the owner. No changes made.");
                    return;
                }

                if (previousOwner && !replace) {
                    throw new Error(
                        `Tenant already has owner ${previousOwner}. Use --replace to change it. No changes made.`
                    );
                }

                tenant.ownerUserId = userId;
                await tenant.save({ session });

                await AuditLogService.createAuditLog(
                    { userId, tenantId },
                    {
                        action: "tenant.owner_designated",
                        entity: "Tenant",
                        entityId: tenantId,
                        description: `Owner designated by server-side script: ${user.email}`,
                        oldValues: { ownerUserId: previousOwner },
                        newValues: { ownerUserId: userId.toString() },
                    },
                    session
                );

                console.log(
                    `Owner of tenant ${tenantId} set to ${user.email} (${userId}).`
                );
            });
        } finally {
            await session.endSession();
        }
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error: unknown) => {
    console.error(
        "Owner designation failed:",
        error instanceof Error ? error.message : "Unknown error"
    );
    process.exitCode = 1;
});
