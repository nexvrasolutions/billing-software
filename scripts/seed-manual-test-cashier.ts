
/*
 * Manual offline-test account for the ISOLATED test database (billing_test).
 *
 * Creates, in ONE MongoDB transaction (all or nothing), the minimum records a
 * person needs to try offline sales by hand on the test-mode server:
 *
 *   Tenant   "MANUAL-TEST-<runId>"  (businessType "manual-offline-test", the
 *            marker the cleanup checks)
 *   Role     "Offline Test Cashier" with the permissions sales.create and
 *            products.read
 *   User     "Manual Test Cashier", manual-cashier-<runId>@example.invalid,
 *            password typed with HIDDEN input, stored only as an argon2id hash
 *   Device   deviceId "manual-test-<runId>" (the "Device ID" on the login page)
 *   Category, Unit ("Piece"/"pc") and one Product (SKU MT-<RUNID>, selling
 *            price 100, stock 100): a sale needs an active product with an
 *            active unit; a customer is optional, so none is created.
 *
 * Permission names are shared records (not per business). Existing ones are
 * only read. A missing one is created (description "Created by
 * seed-manual-test-cashier <runId>") and is NEVER deleted by the cleanup.
 *
 * Safety:
 *  - Refuses unless NODE_ENV=test, refuses when MONGODB_URI or SESSION_SECRET
 *    are already set in the shell, and loads ONLY .env.test.local (it checks
 *    that this was the only file loaded; .env.local is never read).
 *  - The database must be exactly "billing_test" (shared guard), checked
 *    before any database module is loaded or any connection is made.
 *  - The password is asked for (twice) before connecting, never echoed,
 *    never printed, never logged; it is not accepted from arguments or files.
 *  - Aborts without writing when the business name, the email (in ANY
 *    business) or the device ID (in ANY business) already exists, or when a
 *    unique index rejects a record. Nothing existing is changed or deleted.
 *  - Prints only non-secret identifiers (run ID, email, device ID, product).
 *
 * Create (later, only with approval; an interactive terminal is required):
 *   $env:NODE_ENV = "test"; $env:ALLOW_MANUAL_TEST_SEED = "YES"; npx tsx scripts/seed-manual-test-cashier.ts
 *
 * Clean up everything of ONE run (the business and every record that carries
 * its tenantId, including sales, sessions, sync records and audit entries
 * made during manual testing, plus that email's login rate-limit counters):
 *   $env:NODE_ENV = "test"; $env:ALLOW_MANUAL_TEST_SEED = "YES"; npx tsx scripts/seed-manual-test-cashier.ts --cleanup <runId>
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { TEST_DATABASE_NAME, assertTestDatabaseUri } from "./lib/testDatabaseGuard";

const TENANT_MARKER = "manual-offline-test";
const RUN_ID_PATTERN = /^[a-z0-9]{10,24}$/;
const REQUIRED_PERMISSIONS = ["sales.create", "products.read"] as const;

// Every collection whose records carry a tenantId (same list as
// scripts/lib/testRunSafety.ts). Used only by --cleanup, only with the
// tenantId of a business that carries this script's marker.
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

const names = (runId: string) => ({
    tenant: `MANUAL-TEST-${runId}`,
    email: `manual-cashier-${runId}@example.invalid`,
    deviceId: `manual-test-${runId}`,
    sku: `MT-${runId.toUpperCase()}`,
});

// ------------------------------------------------------------ environment

/**
 * NODE_ENV=test and only .env.test.local. Runs before anything else; reads
 * no file when it refuses. Never prints a value.
 */
function loadTestEnvironmentOnly(): void {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("Refusing to run: set NODE_ENV=test (only .env.test.local is then loaded, never .env.local).");
    }
    if (process.env.ALLOW_MANUAL_TEST_SEED !== "YES") {
        throw new Error("Refusing to run: set ALLOW_MANUAL_TEST_SEED=YES to confirm this test-database setup.");
    }
    for (const key of ["MONGODB_URI", "SESSION_SECRET"]) {
        if (process.env[key] !== undefined) {
            throw new Error(`Refusing to run: ${key} is already set in this terminal; it must come from .env.test.local only.`);
        }
    }

    const { loadedEnvFiles } = loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
    const loaded = loadedEnvFiles.map((file) => path.basename(file.path));
    if (loaded.length !== 1 || loaded[0] !== ".env.test.local") {
        throw new Error(
            `Refusing to run: expected exactly one settings file (.env.test.local), but loaded: ${loaded.join(", ") || "none"}.`
        );
    }
    if (!process.env.SESSION_SECRET) {
        throw new Error("Refusing to run: .env.test.local has no SESSION_SECRET.");
    }
    // Exactly billing_test, before any database module is loaded.
    assertTestDatabaseUri(process.env.MONGODB_URI);
}

// ------------------------------------------------------------ hidden input

/** Read one line without echoing it. Requires an interactive terminal. */
function readHidden(prompt: string): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        return Promise.reject(new Error("Run this in an interactive terminal: the password is typed with hidden input."));
    }

    process.stdout.write(prompt);
    return new Promise((resolve, reject) => {
        let value = "";
        const stop = () => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write("\n");
        };
        const onData = (chunk: string) => {
            for (const char of chunk) {
                if (char === "\r" || char === "\n") {
                    stop();
                    resolve(value);
                    return;
                }
                if (char === "\u0003") { // Ctrl+C
                    stop();
                    reject(new Error("Cancelled. Nothing was connected to or written."));
                    return;
                }
                if (char === "\u007f" || char === "\b") {
                    value = value.slice(0, -1);
                } else if (char >= " ") {
                    value += char;
                }
            }
        };
        stdin.setRawMode(true);
        stdin.setEncoding("utf8");
        stdin.resume();
        stdin.on("data", onData);
    });
}

// ------------------------------------------------------------ create

async function create(): Promise<void> {
    const { passwordSchema } = await import("../lib/users/userApi");
    const { hashPassword } = await import("../app/api/auth/password");

    // The password is asked for BEFORE connecting and kept only in memory.
    const password = await readHidden("Password for the test cashier (12-128 characters, hidden): ");
    const policy = passwordSchema.safeParse(password);
    if (!policy.success) {
        throw new Error(`${policy.error.issues[0]?.message ?? "Invalid password"}. Nothing was connected to or written.`);
    }
    if ((await readHidden("Type it again: ")) !== password) {
        throw new Error("The two passwords differ. Nothing was connected to or written.");
    }
    const passwordHash = await hashPassword(password);

    const runId = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const n = names(runId);

    const mongoose = (await import("mongoose")).default;
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { User } = await import("../lib/models/User");
    const { Device } = await import("../lib/models/Device");
    const { Category } = await import("../lib/models/Category");
    const { Unit } = await import("../lib/models/Unit");
    const { Product } = await import("../lib/models/Product");

    await connectDB();
    try {
        // Defence in depth: the live connection must be the test database.
        if (mongoose.connection.db?.databaseName !== TEST_DATABASE_NAME) {
            throw new Error("Refusing to continue: the connection is not to the test database. Nothing was written.");
        }

        // Collision checks (read-only): abort instead of touching anything.
        if (await Tenant.exists({ name: n.tenant })) throw new Error("A business with this test name already exists. Nothing was written.");
        if (await User.exists({ email: n.email })) throw new Error("A user with this test email already exists. Nothing was written.");
        if (await Device.exists({ deviceId: n.deviceId })) throw new Error("A device with this test device ID already exists. Nothing was written.");

        // All IDs are chosen up front so a transaction retry writes the same records.
        const ids = {
            tenant: new mongoose.Types.ObjectId(),
            role: new mongoose.Types.ObjectId(),
            user: new mongoose.Types.ObjectId(),
            device: new mongoose.Types.ObjectId(),
            category: new mongoose.Types.ObjectId(),
            unit: new mongoose.Types.ObjectId(),
            product: new mongoose.Types.ObjectId(),
        };
        const createdPermissions: string[] = [];

        // Shown BEFORE writing: if the run is interrupted right after the
        // commit, this is the ID the cleanup command needs.
        console.log(`Run ID ${runId}: creating the test business in one transaction...`);

        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                createdPermissions.length = 0;

                // Shared permission records: read; create only when missing.
                const permissionIds: InstanceType<typeof mongoose.Types.ObjectId>[] = [];
                for (const name of REQUIRED_PERMISSIONS) {
                    const existing = await Permission.findOne({ name }).select("_id").session(session).lean();
                    if (existing) {
                        permissionIds.push(existing._id as InstanceType<typeof mongoose.Types.ObjectId>);
                        continue;
                    }
                    const [created] = await Permission.create(
                        [{ name, description: `Created by seed-manual-test-cashier ${runId}` }],
                        { session }
                    );
                    permissionIds.push(created._id as InstanceType<typeof mongoose.Types.ObjectId>);
                    createdPermissions.push(name);
                }

                await Tenant.create([{ _id: ids.tenant, name: n.tenant, businessType: TENANT_MARKER, status: "active" }], { session });
                await Role.create([{
                    _id: ids.role, tenantId: ids.tenant, name: "Offline Test Cashier",
                    description: "Manual offline sale testing only", permissions: permissionIds, status: "active",
                }], { session });
                await User.create([{
                    _id: ids.user, tenantId: ids.tenant, name: "Manual Test Cashier", email: n.email,
                    passwordHash, roleId: ids.role, status: "active", mustChangePassword: false,
                }], { session });
                await Device.create([{
                    _id: ids.device, tenantId: ids.tenant, userId: ids.user, deviceName: "Manual offline test browser",
                    deviceType: "desktop", deviceId: n.deviceId, status: "active",
                }], { session });
                await Category.create([{ _id: ids.category, tenantId: ids.tenant, name: "Manual Test Category", status: "active" }], { session });
                await Unit.create([{ _id: ids.unit, tenantId: ids.tenant, name: "Piece", shortName: "pc", status: "active" }], { session });
                await Product.create([{
                    _id: ids.product, tenantId: ids.tenant, name: "Manual Test Item", SKU: n.sku,
                    categoryId: ids.category, unitId: ids.unit, purchasePrice: 50, sellingPrice: 100,
                    stockQuantity: 100, status: "active",
                }], { session });
            });
        } finally {
            await session.endSession();
        }

        // Read back (read-only) what the transaction committed.
        const committed = await Promise.all([
            Tenant.countDocuments({ _id: ids.tenant, businessType: TENANT_MARKER }),
            Role.countDocuments({ _id: ids.role, tenantId: ids.tenant }),
            User.countDocuments({ _id: ids.user, tenantId: ids.tenant, roleId: ids.role }),
            Device.countDocuments({ _id: ids.device, tenantId: ids.tenant, userId: ids.user, status: "active" }),
            Product.countDocuments({ _id: ids.product, tenantId: ids.tenant, status: "active" }),
        ]);
        if (committed.some((count) => count !== 1)) {
            throw new Error(`Read-back check failed after commit (run ${runId}); run the cleanup command for this run ID.`);
        }

        // Only non-secret identifiers. Never the password or its hash.
        console.log("\nManual offline-test account created in billing_test (one transaction).");
        console.log(`  Run ID (needed for cleanup): ${runId}`);
        console.log(`  Business:                    ${n.tenant}`);
        console.log(`  Login email:                 ${n.email}`);
        console.log(`  Device ID (login page):      ${n.deviceId}`);
        console.log("  Password:                    the one you just typed (not shown)");
        console.log(`  Product ID (offline test):   ${ids.product.toString()}  (Manual Test Item, SKU ${n.sku}, price 100, stock 100)`);
        console.log(`  Role:                        Offline Test Cashier (${REQUIRED_PERMISSIONS.join(", ")})`);
        console.log(`  Permission records created:  ${createdPermissions.length ? createdPermissions.join(", ") : "none (existing ones reused)"}`);
    } finally {
        await mongoose.disconnect().catch(() => undefined);
    }
}

// ------------------------------------------------------------ cleanup

async function cleanup(runId: string): Promise<void> {
    if (!RUN_ID_PATTERN.test(runId)) {
        throw new Error("Refusing to clean up: that is not a run ID printed by this script. Nothing was connected to or changed.");
    }
    const n = names(runId);

    const mongoose = (await import("mongoose")).default;
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");

    await connectDB();
    try {
        const db = mongoose.connection.db;
        if (!db || db.databaseName !== TEST_DATABASE_NAME) {
            throw new Error("Refusing to continue: the connection is not to the test database. Nothing was changed.");
        }

        // Only the business this script created for THIS run: exact name AND marker.
        const tenants = await Tenant.find({ name: n.tenant }).select("_id businessType").lean();
        if (tenants.length !== 1 || tenants[0].businessType !== TENANT_MARKER) {
            throw new Error(
                tenants.length === 0
                    ? "No business of this run exists (already cleaned up?). Nothing was changed."
                    : "Refusing to clean up: the business name does not match exactly one record created by this script. Nothing was changed."
            );
        }
        const tenantId = tenants[0]._id;

        // Every record of that business (including those made while testing).
        const removed: Record<string, number> = {};
        for (const collection of TENANT_SCOPED_COLLECTIONS) {
            const result = await db.collection(collection).deleteMany({ tenantId });
            if (result.deletedCount) removed[collection] = result.deletedCount;
        }
        // That email's login rate-limit counters (keyed by an HMAC, not the email itself).
        const keys = getLoginBuckets({ ip: null, email: n.email }).map((bucket) => bucket.key);
        const limits = await db.collection("loginratelimits").deleteMany({ key: { $in: keys } });
        if (limits.deletedCount) removed.loginratelimits = limits.deletedCount;
        // The business itself last (it stays as a visible marker if anything above failed).
        await db.collection("tenants").deleteOne({ _id: tenantId, name: n.tenant, businessType: TENANT_MARKER });
        removed.tenants = 1;

        // Read-only re-check.
        const left = (await Promise.all(
            TENANT_SCOPED_COLLECTIONS.map((collection) => db.collection(collection).countDocuments({ tenantId }))
        )).reduce((sum, count) => sum + count, 0) + await db.collection("tenants").countDocuments({ _id: tenantId });

        console.log(`\nCleanup of run ${runId}: removed ${JSON.stringify(removed)}.`);
        console.log(left === 0
            ? "Verified: nothing of this run remains. Shared permission records were not touched."
            : `WARNING: ${left} record(s) of this run remain; run the same cleanup command again.`);
        if (left !== 0) process.exitCode = 1;
    } finally {
        await mongoose.disconnect().catch(() => undefined);
    }
}

// ------------------------------------------------------------ entry

async function main(): Promise<void> {
    loadTestEnvironmentOnly();

    const cleanupIndex = process.argv.indexOf("--cleanup");
    if (cleanupIndex >= 0) {
        await cleanup(process.argv[cleanupIndex + 1] ?? "");
        return;
    }
    if (process.argv.length > 2) {
        throw new Error("Unexpected arguments: the password is never accepted on the command line. Nothing was connected to or written.");
    }
    await create();
}

main().catch((error: unknown) => {
    // Only our own messages or an error name: never a URI, value or stack.
    const message = error instanceof Error ? error.message : "Unknown error";
    const safe = /mongodb(\+srv)?:\/\/|mongodb\.net|password=|E11000/i.test(message)
        ? `${error instanceof Error ? error.name : "Error"} (details hidden)`
        : message;
    console.error(`Manual test setup stopped: ${safe}`);
    process.exitCode = 1;
});
