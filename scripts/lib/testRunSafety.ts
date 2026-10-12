
/*
 * Safe execution wrapper for database-backed test scripts.
 *
 * Guarantees:
 *  - Every temporary tenant ID is generated and registered BEFORE it is
 *    inserted, so cleanup knows it even if the insert's reply is lost.
 *  - The whole run has an overall time limit. On timeout the main database
 *    connection is force-closed, so operations that were still pending can
 *    never run later (Mongoose buffers them on the closed connection and
 *    they fail). After a settle delay for commands already on the wire,
 *    cleanup runs.
 *  - Cleanup ALWAYS runs (after success, failed assertions, thrown errors
 *    or a timeout) on a separate, fresh connection whose operations are
 *    bounded by the driver's timeoutMS (enforced client- AND server-side).
 *  - Cleanup deletes only documents whose tenantId is one of this run's
 *    registered IDs, and refuses any tenant whose name is not this run's
 *    test name. It then re-checks after a delay to catch late writes.
 *  - Every timeout or cleanup problem is reported loudly and makes the
 *    process exit with a non-zero code, listing what needs manual cleanup.
 */

import mongoose, { Types } from "mongoose";

// Every test record type in these scripts carries a required tenantId.
// Business collections are included for sync tests that create sales.
const TENANT_SCOPED_COLLECTIONS = [
    "users",
    "roles",
    "devices",
    "sessions",
    "auditlogs",
    "syncoperations",
    "tenantadminguards",
    "sales",
    "salesreturns",
    "purchases",
    "purchasereturns",
    "stockmovements",
    "ledgerentries",
    "payments",
    "customers",
    "suppliers",
    "products",
    "units",
    "categories",
    "taxes",
] as const;

const SETTLE_DELAY_MS = 3000;
const RECHECK_DELAY_MS = 3000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 90_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TestRun {
    /** Unique suffix for this run; every tenant name must end with it. */
    readonly runId: string;
    /** Generate and register a tenant ID before inserting the tenant. */
    newTenantId(): Types.ObjectId;
    /** Expected name for a tenant of this run, e.g. "PW-TEST-A-<runId>". */
    tenantName(label: string): string;
    /** Register rate-limit counter keys BEFORE the request that creates them. */
    addRateLimitKeys(keys: string[]): void;
    /** Register non-database cleanup (e.g. killing a browser). */
    onCleanup(label: string, fn: () => void | Promise<void>): void;
    /**
     * Generate and register the _id of a shared Permission record BEFORE
     * inserting it. Cleanup deletes only registered IDs, only while the
     * record still has this name, and never while a role outside this run
     * uses it. Pre-existing permissions are never registered or deleted.
     */
    newSharedPermissionId(name: string): Types.ObjectId;
    /** True once the overall timeout fired; steps should stop. */
    readonly aborted: boolean;
}

interface Options {
    name: string;
    /** Tenant names of this test start with this prefix. */
    tenantNamePrefix: string;
    /** Overall limit; can be overridden with TEST_RUN_TIMEOUT_MS. */
    overallTimeoutMs: number;
    run: (run: TestRun) => Promise<void>;
    /** Print the check results; return true when every check passed. */
    summarize: () => boolean;
}

class RunState implements TestRun {
    readonly runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    readonly tenantIds: Types.ObjectId[] = [];
    readonly rateLimitKeys = new Set<string>();
    readonly cleanups: { label: string; fn: () => void | Promise<void> }[] = [];
    readonly sharedPermissions: { id: Types.ObjectId; name: string }[] = [];
    aborted = false;

    constructor(private readonly prefix: string) {}

    newTenantId() {
        const id = new Types.ObjectId();
        this.tenantIds.push(id);
        return id;
    }

    tenantName(label: string) {
        return `${this.prefix}${label}-${this.runId}`;
    }

    addRateLimitKeys(keys: string[]) {
        keys.forEach((key) => this.rateLimitKeys.add(key));
    }

    onCleanup(label: string, fn: () => void | Promise<void>) {
        this.cleanups.push({ label, fn });
    }

    newSharedPermissionId(name: string) {
        const id = new Types.ObjectId();
        this.sharedPermissions.push({ id, name });
        return id;
    }

    isThisRunsTenantName(name: unknown) {
        return typeof name === "string" && name.startsWith(this.prefix) && name.endsWith(`-${this.runId}`);
    }
}

async function countRemaining(db: mongoose.mongo.Db, state: RunState) {
    const counts: Record<string, number> = {};
    for (const collection of TENANT_SCOPED_COLLECTIONS) {
        counts[collection] = await db.collection(collection).countDocuments({ tenantId: { $in: state.tenantIds } });
    }
    counts.tenants = await db.collection("tenants").countDocuments({ _id: { $in: state.tenantIds } });
    counts.loginratelimits = await db.collection("loginratelimits").countDocuments({ key: { $in: [...state.rateLimitKeys] } });
    return counts;
}

/** Deletes this run's records. Returns a list of problems (empty = clean). */
async function cleanupRecords(state: RunState): Promise<string[]> {
    const problems: string[] = [];

    if (!state.tenantIds.length && !state.rateLimitKeys.size && !state.sharedPermissions.length) {
        return problems;
    }

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        return ["MONGODB_URI is not set; cannot clean up"];
    }

    // Fresh connection, independent of the (possibly force-closed) main one.
    // timeoutMS bounds each operation on the client AND the server.
    const connection = mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: 15_000,
        socketTimeoutMS: CLEANUP_OPERATION_TIMEOUT_MS,
        timeoutMS: CLEANUP_OPERATION_TIMEOUT_MS,
        maxPoolSize: 2,
    });

    try {
        await connection.asPromise();
        const db = connection.db;
        if (!db) throw new Error("cleanup connection has no database handle");

        // Safety: refuse to touch any tenant that is not this run's test tenant.
        const existing = await db.collection("tenants")
            .find({ _id: { $in: state.tenantIds } }, { projection: { name: 1 } })
            .toArray();
        const refused = existing.filter((tenant) => !state.isThisRunsTenantName(tenant.name));
        if (refused.length) {
            problems.push(`REFUSED to delete ${refused.length} tenant(s) whose name is not this run's test name: ${refused.map((t) => t._id).join(", ")}`);
        }
        const refusedIds = new Set(refused.map((t) => String(t._id)));
        const safeIds = state.tenantIds.filter((id) => !refusedIds.has(String(id)));

        const deleteAll = async () => {
            // Tenant-scoped records first, tenants last: if cleanup stops
            // midway, the tenant remains as a visible marker of what is left.
            for (const collection of TENANT_SCOPED_COLLECTIONS) {
                try {
                    await db.collection(collection).deleteMany({ tenantId: { $in: safeIds } });
                } catch (error) {
                    problems.push(`delete from ${collection} failed: ${(error as Error).message}`);
                }
            }
            if (state.rateLimitKeys.size) {
                try {
                    await db.collection("loginratelimits").deleteMany({ key: { $in: [...state.rateLimitKeys] } });
                } catch (error) {
                    problems.push(`delete from loginratelimits failed: ${(error as Error).message}`);
                }
            }
            try {
                await db.collection("tenants").deleteMany({ _id: { $in: safeIds } });
            } catch (error) {
                problems.push(`delete from tenants failed: ${(error as Error).message}`);
            }
        };

        await deleteAll();

        // Catch writes that were still in flight when the run ended.
        await sleep(RECHECK_DELAY_MS);
        let remaining = await countRemaining(db, state);
        if (Object.values(remaining).some((count) => count > 0) && !refused.length) {
            console.error(`CLEANUP: late records found after first pass ${JSON.stringify(remaining)}; deleting again`);
            await deleteAll();
            remaining = await countRemaining(db, state);
        }

        const leftovers = Object.entries(remaining).filter(([, count]) => count > 0);
        if (leftovers.length && !refused.length) {
            problems.push(`records remain after cleanup: ${leftovers.map(([c, n]) => `${c}=${n}`).join(", ")}`);
        }

        // Shared permission records this run created (after this run's roles
        // are gone). Only registered IDs; never a pre-existing record.
        for (const { id, name } of state.sharedPermissions) {
            try {
                const record = await db.collection("permissions").findOne({ _id: id }, { projection: { name: 1 } });
                if (!record) continue; // never inserted (e.g. it already existed)
                if (record.name !== name) {
                    problems.push(`REFUSED to delete permission ${id}: its name is no longer "${name}"`);
                    continue;
                }
                const usedBy = await db.collection("roles").countDocuments({ permissions: id });
                if (usedBy > 0) {
                    problems.push(`kept test-created permission "${name}" (${id}): ${usedBy} role(s) outside this run now use it; review manually`);
                    continue;
                }
                const result = await db.collection("permissions").deleteOne({ _id: id, name });
                if (result.deletedCount !== 1) {
                    problems.push(`test-created permission "${name}" (${id}) could not be deleted`);
                }
            } catch (error) {
                problems.push(`cleanup of permission "${name}" failed: ${(error as Error).message}`);
            }
        }
    } catch (error) {
        problems.push(`cleanup could not run: ${(error as Error).message}`);
    } finally {
        await connection.close(true).catch((error: Error) =>
            problems.push(`closing cleanup connection failed: ${error.message}`)
        );
    }

    return problems;
}

export async function runTestSafely(options: Options): Promise<never> {
    const state = new RunState(options.tenantNamePrefix);
    const overallTimeoutMs = Number(process.env.TEST_RUN_TIMEOUT_MS) || options.overallTimeoutMs;
    let failure: string | null = null;

    console.log(`${options.name}: run ${state.runId} (tenants named ${options.tenantNamePrefix}*-${state.runId}), overall timeout ${Math.round(overallTimeoutMs / 1000)}s`);

    // --- run with an overall timeout ------------------------------------
    let timer: NodeJS.Timeout | undefined;
    const runPromise = options.run(state).then(
        () => "completed" as const,
        (error: unknown) => {
            // After a timeout the abandoned run fails because its connection
            // was force-closed; keep the timeout as the reported cause.
            if (!state.aborted) {
                failure = `test run threw: ${error instanceof Error ? error.message : String(error)}`;
            }
            return "threw" as const;
        }
    );
    const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), overallTimeoutMs);
    });

    const outcome = await Promise.race([runPromise, timeoutPromise]);
    clearTimeout(timer);

    if (outcome === "timeout") {
        state.aborted = true;
        failure = `TIMEOUT: ${options.name} did not finish within ${Math.round(overallTimeoutMs / 1000)}s and was aborted`;
        console.error(failure);
        // The race only stopped WAITING. To make sure the unfinished run can
        // no longer write, force-close its connection: pending operations
        // fail and nothing buffered is ever sent.
        await mongoose.connection.close(true).catch((error: Error) =>
            console.error(`TIMEOUT: force-closing the test connection failed: ${error.message}`)
        );
        // Give commands that were already sent time to finish server-side.
        await sleep(SETTLE_DELAY_MS);
    } else {
        await mongoose.disconnect().catch((error: Error) =>
            console.error(`Closing the test connection failed: ${error.message}`)
        );
    }

    // --- cleanup (always), with its own time limit -----------------------
    const cleanupProblems: string[] = [];
    const cleanupWork = (async () => {
        for (const { label, fn } of state.cleanups) {
            try {
                await fn();
            } catch (error) {
                cleanupProblems.push(`${label} failed: ${(error as Error).message}`);
            }
        }
        cleanupProblems.push(...(await cleanupRecords(state)));
        return "done" as const;
    })();
    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanupOutcome = await Promise.race([
        cleanupWork,
        new Promise<"timeout">((resolve) => {
            cleanupTimer = setTimeout(() => resolve("timeout"), DEFAULT_CLEANUP_TIMEOUT_MS);
        }),
    ]);
    clearTimeout(cleanupTimer);

    if (cleanupOutcome === "timeout") {
        cleanupProblems.push(`cleanup did not finish within ${DEFAULT_CLEANUP_TIMEOUT_MS / 1000}s`);
    }

    if (cleanupProblems.length) {
        console.error("\nCLEANUP ERRORS:");
        cleanupProblems.forEach((problem) => console.error(`  - ${problem}`));
        console.error(`Manual cleanup needed for tenant IDs: ${state.tenantIds.join(", ") || "(none)"} (names ${options.tenantNamePrefix}*-${state.runId})`);
    } else {
        console.log(`\nCleanup OK: ${state.tenantIds.length} test tenant(s) and their records, ${state.rateLimitKeys.size} rate-limit counter key(s), ${state.sharedPermissions.length} test-created permission record(s) considered; verified none remain.`);
    }

    // --- summary and exit ---------------------------------------------------
    const allChecksPassed = options.summarize();
    if (state.aborted) {
        console.error("Note: checks recorded around the abort may have failed only because the run was stopped.");
    }
    if (failure) console.error(`\nRUN FAILED: ${failure}`);

    const ok = allChecksPassed && !failure && !cleanupProblems.length && cleanupOutcome === "done";
    // Exit explicitly: an aborted run may still hold pending promises/handles.
    process.exit(ok ? 0 : 1);
}
