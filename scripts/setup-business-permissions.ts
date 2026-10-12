
/*
 * Set up the business permissions (Stage 0) for ONE tenant.
 *
 * DRY RUN BY DEFAULT: without --apply nothing is written; the script only
 * shows what it would change.
 *
 *   Preview (read-only), --tenant is REQUIRED:
 *     npx tsx scripts/setup-business-permissions.ts --tenant <tenantId>
 *
 *   Apply (writes; requires the flag AND the confirmation):
 *     CONFIRM_BUSINESS_PERMISSIONS_SETUP=APPLY npx tsx scripts/setup-business-permissions.ts --tenant <tenantId> --apply
 *
 * What it targets:
 *   - Only the tenant given with --tenant (it must exist).
 *   - Only roles of that tenant whose name EXACTLY matches a key of
 *     ROLE_GRANTS ("Business Owner", "Admin", "Manager", "Staff"; case and
 *     spaces must match). A tenant has at most one role per name (unique
 *     index tenantId + name).
 *   - Only roles whose status is exactly "active". Inactive roles, and roles
 *     with a missing or unknown status, are skipped and reported.
 *
 * What --apply does:
 *   1. Adds missing permission names to the shared permission catalogue
 *      (catalogue records are global, not per tenant; existing records are
 *      never modified).
 *   2. Adds permissions to the targeted roles with $addToSet. Every role
 *      write is filtered by role _id, tenantId, name and status "active".
 *      It never removes a permission and never touches users, other roles,
 *      other tenants or business records.
 *   Writes are not one transaction: if it stops halfway, re-running it
 *   completes the rest (every step is idempotent).
 *
 * Deploy the Stage 0 code and apply this together: until the roles have
 * these permissions, nobody can create sales, purchases, payments, returns,
 * stock adjustments or ledger entries, or read/delete taxes.
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const PERMISSIONS: Record<string, string> = {
    "sales.create": "Create sales",
    "sales.priceOverride": "Sell at a price other than the selling price, or give discounts",
    "sales.backdate": "Record sales dated earlier than the allowed window",
    "salesReturns.create": "Create sales returns",
    "purchases.create": "Create purchases",
    "purchaseReturns.create": "Create purchase returns",
    "payments.create": "Record payments and receipts",
    "stock.adjust": "Adjust stock quantities",
    "ledger.create": "Create manual ledger entries",
    "taxes.read": "View taxes",
    "taxes.delete": "Deactivate taxes",
};

const ALL = Object.keys(PERMISSIONS);

// Role name (exact match) -> permissions to add. Roles not listed are untouched.
const ROLE_GRANTS: Record<string, string[]> = {
    "Business Owner": ALL,
    Admin: ALL,
    Manager: [
        "sales.create",
        "sales.priceOverride",
        "salesReturns.create",
        "purchases.create",
        "purchaseReturns.create",
        "payments.create",
        "stock.adjust",
        "taxes.read",
    ],
    Staff: ["sales.create", "taxes.read"],
};

const TARGET_ROLE_NAMES = Object.keys(ROLE_GRANTS);

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
    const apply = process.argv.includes("--apply");
    const tenantArg = readArg("--tenant")?.trim();

    // Checks that need no database: stop before connecting.
    if (!tenantArg || !/^[a-f\d]{24}$/i.test(tenantArg)) {
        throw new Error("--tenant <tenantId> is required (a 24-character tenant ID). Nothing was changed.");
    }

    if (apply && process.env.CONFIRM_BUSINESS_PERMISSIONS_SETUP !== "APPLY") {
        throw new Error("--apply also requires CONFIRM_BUSINESS_PERMISSIONS_SETUP=APPLY. Nothing was changed.");
    }

    const mongoose = (await import("mongoose")).default;
    // This script must never build or change indexes or create collections.
    mongoose.set("autoIndex", false);
    mongoose.set("autoCreate", false);

    const { connectDB } = await import("../lib/db/mongodb");
    const { Permission } = await import("../lib/models/Permission");
    const { Role } = await import("../lib/models/Role");
    const { Tenant } = await import("../lib/models/Tenant");

    const tenantId = new mongoose.Types.ObjectId(tenantArg);

    await connectDB();

    try {
        console.log(apply ? "MODE: APPLY (writes)" : "MODE: DRY RUN (no changes)");

        // 1. The tenant must exist; show which business this is.
        const tenant = await Tenant.findById(tenantId).select("_id name status").lean();
        if (!tenant) {
            throw new Error(`Tenant ${tenantArg} was not found. Nothing was changed.`);
        }
        console.log(`Tenant: "${tenant.name}" (${tenant._id}), status: ${tenant.status ?? "(missing)"}`);

        if (apply && tenant.status !== "active") {
            throw new Error(`Tenant status is "${tenant.status ?? "(missing)"}", not "active". Nothing was changed.`);
        }

        // 2. Permission catalogue: names -> ids (and the reverse for display).
        const catalogue = await Permission.find({ name: { $in: ALL } }).select("_id name").lean();
        const idByName = new Map(catalogue.map((p) => [p.name, p._id]));
        const missing = ALL.filter((name) => !idByName.has(name));
        console.log(`Permission catalogue: ${catalogue.length}/${ALL.length} present; missing: ${missing.join(", ") || "none"}`);

        // 3. Roles of THIS tenant with exactly one of the target names.
        const roles = await Role.find({ tenantId, name: { $in: TARGET_ROLE_NAMES } })
            .select("_id tenantId name status permissions")
            .lean();

        const existingPermissionIds = roles.flatMap((role) => role.permissions ?? []);
        const existingNames = new Map(
            (await Permission.find({ _id: { $in: existingPermissionIds } }).select("_id name").lean())
                .map((p) => [p._id.toString(), p.name])
        );

        const plan: { roleId: InstanceType<typeof mongoose.Types.ObjectId>; name: string; toAdd: string[] }[] = [];
        console.log("\nMatching roles:");
        for (const role of roles) {
            const current = (role.permissions ?? []).map((id) => existingNames.get(id.toString()) ?? `?${id}`);
            const toAdd = (ROLE_GRANTS[role.name] ?? []).filter((name) => {
                const id = idByName.get(name);
                return !id || !(role.permissions ?? []).some((existing) => existing.toString() === id.toString());
            });
            const status = role.status as unknown;

            let decision: string;
            if (status === "active") {
                decision = toAdd.length ? `WILL ADD: ${toAdd.join(", ")}` : "nothing to add";
                if (toAdd.length) plan.push({ roleId: role._id, name: role.name, toAdd });
            } else if (status === "inactive") {
                decision = "SKIPPED (inactive role)";
            } else {
                // Never treat a missing or unknown status as active.
                decision = `SKIPPED (status "${String(status ?? "(missing)")}" is not "active"; review manually)`;
            }

            console.log(`  - "${role.name}" (${role._id}), status: ${String(status ?? "(missing)")}`);
            console.log(`      current permissions: ${current.join(", ") || "(none)"}`);
            console.log(`      ${decision}`);
        }

        const notFound = TARGET_ROLE_NAMES.filter((name) => !roles.some((role) => role.name === name));
        if (notFound.length) {
            console.log(`Target role names not present in this tenant (nothing to do): ${notFound.join(", ")}`);
        }

        const otherRoles = await Role.find({ tenantId, name: { $nin: TARGET_ROLE_NAMES } }).select("name").lean();
        if (otherRoles.length) {
            console.log(`Other roles in this tenant (never changed by this script): ${otherRoles.map((r) => `"${r.name}"`).join(", ")}`);
        }

        if (!apply) {
            console.log(`\nDRY RUN: ${plan.length} role(s) would be updated; nothing was changed.`);
            return;
        }

        // 4. Apply: catalogue entries needed by the plan, then the roles.
        const neededMissing = [...new Set(plan.flatMap((p) => p.toAdd))].filter((name) => !idByName.has(name));
        for (const name of neededMissing) {
            // Upsert by unique name: never modifies an existing record.
            await Permission.updateOne(
                { name },
                { $setOnInsert: { name, description: PERMISSIONS[name] } },
                { upsert: true }
            );
        }
        if (neededMissing.length) {
            const now = await Permission.find({ name: { $in: neededMissing } }).select("_id name").lean();
            now.forEach((p) => idByName.set(p.name, p._id));
            console.log(`Created ${neededMissing.length} permission catalogue record(s).`);
        }

        let updated = 0;
        for (const item of plan) {
            const addIds = item.toAdd.map((name) => idByName.get(name));
            if (addIds.some((id) => !id)) {
                throw new Error(`Permission records missing for role "${item.name}"; stopped. Earlier roles may already be updated; re-run to finish.`);
            }

            const result = await Role.updateOne(
                // Tenant, name and active status are part of every write.
                { _id: item.roleId, tenantId, name: item.name, status: "active" },
                { $addToSet: { permissions: { $each: addIds } } }
            );

            if (result.matchedCount !== 1) {
                console.log(`  ! "${item.name}" was not updated (it changed since the preview); re-run to review.`);
                continue;
            }
            updated++;
            console.log(`  updated "${item.name}": added ${item.toAdd.join(", ")}`);
        }

        console.log(`\nAPPLIED: ${updated}/${plan.length} role(s) updated in tenant "${tenant.name}" (${tenant._id}).`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error: unknown) => {
    console.error("Setup failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
