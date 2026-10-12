
/*
 * Offline-sync claim ownership and type mapping (NO DATABASE).
 *
 * This test never connects to MongoDB: MONGODB_URI is removed, Mongoose
 * command buffering is disabled (an unstubbed call fails immediately), and
 * the SyncOperation calls used by SyncService.processOperation are replaced
 * by in-memory stubs. It checks:
 *   - the upload validation list equals the permission map (no drift);
 *   - unmapped types have no permission;
 *   - the atomic claim filter contains the session's tenant, device and
 *     user (or no user on legacy records);
 *   - a record whose owner changed between the ownership check and the claim
 *     is never claimed and is reported as OWNER_MISMATCH, and no business
 *     code runs.
 *
 * Run:
 *   npx tsx scripts/test-sync-claim-ownership.ts
 */

import { readFileSync } from "fs";
import path from "path";

delete process.env.MONGODB_URI;

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

async function main() {
    const mongoose = (await import("mongoose")).default;
    mongoose.set("bufferCommands", false);
    mongoose.set("autoIndex", false);
    mongoose.set("autoCreate", false);

    const { SYNC_ENTITY_PERMISSIONS, getSyncEntityPermission } = await import("../lib/auth/businessPermissions");
    const { SyncService } = await import("../lib/services/SyncService");
    const { SyncProcessError } = await import("../lib/services/SyncErrors");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { Device } = await import("../lib/models/Device");
    const { SalesService } = await import("../lib/services/SalesService");
    const { PurchaseService } = await import("../lib/services/PurchaseService");
    const { SalesReturnService } = await import("../lib/services/SalesReturnService");
    const { PurchaseReturnService } = await import("../lib/services/PurchaseReturnService");
    const { PaymentService } = await import("../lib/services/PaymentService");
    const { StockService } = await import("../lib/services/StockService");

    // ------------------------------------------------ 1. type mapping (static)
    const routeSource = readFileSync(path.join(process.cwd(), "app/api/sync-operations/route.ts"), "utf8");
    const enumMatch = routeSource.match(/entityType: z\.enum\(\[([^\]]*)\]\)/);
    const enumList = enumMatch ? (JSON.parse(`[${enumMatch[1]}]`) as string[]) : [];
    check("M1. The upload validation list equals the permission map's keys (no drift)",
        enumList.length > 0 && JSON.stringify([...enumList].sort()) === JSON.stringify(Object.keys(SYNC_ENTITY_PERMISSIONS).sort()),
        `${enumList.join(",")} vs ${Object.keys(SYNC_ENTITY_PERMISSIONS).join(",")}`);
    check("M2. Every mapped type has a permission",
        ["Sale", "SalesReturn", "Purchase", "PurchaseReturn", "Payment", "StockAdjustment"].every((t) => typeof getSyncEntityPermission(t) === "string"));
    check("M3. Unmapped names (incl. object built-ins, wrong case, empty) and non-strings have none",
        ["Product", "Customer", "Supplier", "Bogus", "", "sale", "constructor", "__proto__", "toString", "hasOwnProperty"].every((t) => getSyncEntityPermission(t) === null)
        && [undefined, null, 42, {}, ["Sale"]].every((v) => getSyncEntityPermission(v) === null));
    check("M4. The permission map cannot be modified at runtime", Object.isFrozen(SYNC_ENTITY_PERMISSIONS));

    // ------------------------------------------------ 2. claim ownership (stubbed)
    const { Types } = mongoose;
    const tenantId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const deviceId = new Types.ObjectId();
    const otherUser = new Types.ObjectId();
    const otherDevice = new Types.ObjectId();
    const session = { tenantId, userId, deviceId, roleId: new Types.ObjectId().toString() };

    // Spy on everything that could perform business work.
    const businessCalls: string[] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const spy = (target: any, method: string, label: string) => {
        target[method] = async () => {
            businessCalls.push(label);
            throw new Error(`business code must not run (${label})`);
        };
    };
    spy(SalesService, "createSale", "createSale");
    spy(PurchaseService, "createPurchase", "createPurchase");
    spy(SalesReturnService, "createSalesReturn", "createSalesReturn");
    spy(PurchaseReturnService, "createPurchaseReturn", "createPurchaseReturn");
    spy(PaymentService, "createPayment", "createPayment");
    spy(StockService, "changeStock", "changeStock");
    spy(Device, "findOne", "Device.findOne (step 6)");

    interface Scenario {
        // Record as read in step 1 (passes the ownership check of step 2).
        before: Record<string, unknown>;
        // Record as stored at claim time (re-read after a failed claim).
        atClaim: Record<string, unknown>;
    }

    async function runScenario({ before, atClaim }: Scenario) {
        let claimFilter: any = null;
        const writes: string[] = [];
        const model = SyncOperation as any;
        model.findOne = async () => ({ ...before });
        model.findOneAndUpdate = async (filter: any) => {
            claimFilter = filter;
            // The claim filter includes ownership, so a record whose owner
            // changed is not matched: MongoDB returns null.
            const ownerMatches =
                (atClaim.deviceId as any).equals(filter.deviceId)
                && filter.$and[0].$or.some((cond: any) =>
                    cond.userId === null ? atClaim.userId == null : atClaim.userId != null && (atClaim.userId as any).equals(cond.userId));
            if (ownerMatches) writes.push("claimed");
            return null; // never proceed into business code in this test
        };
        model.findById = () => ({ lean: async () => ({ ...atClaim }) });
        model.updateOne = async () => { writes.push("updateOne"); return { matchedCount: 0, modifiedCount: 0 }; };

        let error: unknown = null;
        try {
            await SyncService.processOperation(session, "op-test");
        } catch (caught) {
            error = caught;
        }
        return { claimFilter, error: error as InstanceType<typeof SyncProcessError> | null, writes };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const base = {
        _id: new Types.ObjectId(), tenantId, operationId: "op-test", operationType: "CREATE",
        entityType: "Sale", payload: {}, status: "PENDING", attempts: 0,
    };

    // Normal record owned by the session.
    const owned = await runScenario({
        before: { ...base, userId, deviceId },
        atClaim: { ...base, userId, deviceId },
    });
    const filter = owned.claimFilter;
    check("C1. The claim filter is scoped to the session's tenant and the record's _id",
        Boolean(filter?.tenantId?.equals?.(tenantId) && filter?._id?.equals?.(base._id)));
    check("C2. The claim filter requires the session's device", Boolean(filter?.deviceId?.equals?.(deviceId)));
    check("C3. The claim filter requires the session's user, or no user (legacy record) - nothing else",
        Array.isArray(filter?.$and?.[0]?.$or) && filter.$and[0].$or.length === 2
        && filter.$and[0].$or.some((c: { userId?: unknown }) => (c.userId as { equals?: (x: unknown) => boolean })?.equals?.(userId))
        && filter.$and[0].$or.some((c: { userId?: unknown }) => c.userId === null));
    check("C4. The claim filter still contains the claimable-status/lease conditions",
        Array.isArray(filter?.$and?.[1]?.$or) && filter.$and[1].$or.length === 3 && filter?.attempts?.$lt !== undefined);

    // Owner (user) changed between the ownership check and the claim.
    const userChanged = await runScenario({
        before: { ...base, userId, deviceId },
        atClaim: { ...base, userId: otherUser, deviceId },
    });
    check("C5. A record whose USER changed before the claim is not claimed",
        !userChanged.writes.includes("claimed"));
    check("C6. ...and is reported as 403 OWNER_MISMATCH (not retryable)",
        userChanged.error instanceof SyncProcessError && userChanged.error.httpStatus === 403
        && userChanged.error.code === "OWNER_MISMATCH" && userChanged.error.retryable === false,
        String((userChanged.error as Error | null)?.message));

    // Owner (device) changed between the ownership check and the claim.
    const deviceChanged = await runScenario({
        before: { ...base, userId, deviceId },
        atClaim: { ...base, userId, deviceId: otherDevice },
    });
    check("C7. A record whose DEVICE changed before the claim is not claimed and is OWNER_MISMATCH",
        !deviceChanged.writes.includes("claimed")
        && deviceChanged.error instanceof SyncProcessError && deviceChanged.error.code === "OWNER_MISMATCH");

    // A user ID added to a legacy record (no user) before the claim.
    const legacyTakenOver = await runScenario({
        before: { ...base, deviceId },
        atClaim: { ...base, userId: otherUser, deviceId },
    });
    check("C8. A legacy record that was assigned to another user before the claim is not claimed (OWNER_MISMATCH)",
        !legacyTakenOver.writes.includes("claimed")
        && legacyTakenOver.error instanceof SyncProcessError && legacyTakenOver.error.code === "OWNER_MISMATCH");

    // Legacy record (no user) on the session's own device: still claimable.
    const legacy = await runScenario({
        before: { ...base, deviceId },
        atClaim: { ...base, deviceId },
    });
    check("C9. Legacy compatibility kept: a record with no user on the session's device matches the claim filter",
        legacy.writes.includes("claimed") && (legacy.error as InstanceType<typeof SyncProcessError> | null)?.code !== "OWNER_MISMATCH");

    check("C10. No business code ran in any scenario (no sale, purchase, return, payment, stock change, device lookup)",
        businessCalls.length === 0, businessCalls.join(", "));

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((error: unknown) => {
    console.error("Sync claim ownership tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
