
/*
 * Offline sync reliability tests.
 *
 * Part 1: pure queue/retry rules (lib/offline/syncPolicy.ts) and server
 *         failure classification (lib/services/SyncErrors.ts).
 * Part 2: the real sync API route handlers against MONGODB_URI, using two
 *         brand-new temporary tenants (with their own products, sales, stock
 *         movements, ...) that are removed afterwards by runTestSafely.
 *
 * Run:
 *   ALLOW_OFFLINE_SYNC_TESTS=YES npx tsx scripts/test-offline-sync.ts
 */

import { loadEnvConfig } from "@next/env";

import { runTestSafely } from "./lib/testRunSafety";
import { ensureTestPermissions } from "./lib/testPermissions";

loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

type Json = Record<string, unknown> & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
};

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    return failed.length === 0;
}

async function main() {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_OFFLINE_SYNC_TESTS !== "YES") {
        throw new Error("Set ALLOW_OFFLINE_SYNC_TESTS=YES after confirming MONGODB_URI is a development database.");
    }

    const mongoose = (await import("mongoose")).default;
    const { NextRequest } = await import("next/server");
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Device } = await import("../lib/models/Device");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Category } = await import("../lib/models/Category");
    const { Unit } = await import("../lib/models/Unit");
    const { Product } = await import("../lib/models/Product");
    const { Sale } = await import("../lib/models/Sale");
    const { StockMovement } = await import("../lib/models/StockMovement");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { SalesService } = await import("../lib/services/SalesService");
    const { createUserSession } = await import("../lib/auth/sessionStore");
    const policy = await import("../lib/offline/syncPolicy");
    const syncErrors = await import("../lib/services/SyncErrors");
    const uploadRoute = await import("../app/api/sync-operations/route");
    const processRoute = await import("../app/api/sync-operations/process/route");

    type ObjectId = InstanceType<typeof mongoose.Types.ObjectId>;

    await runTestSafely({
        name: "Offline sync tests",
        tenantNamePrefix: "SYNC-TEST-",
        overallTimeoutMs: 240_000,
        summarize,
        run: async (run) => {
            // ================================================ PART 1: pure rules
            const me = { tenantId: "t1", userId: "u1", deviceId: "d1" };
            const now = new Date("2026-01-01T12:00:00Z");
            const past = "2026-01-01T11:00:00.000Z";
            const future = "2026-01-01T13:00:00.000Z";
            const item = (over: Partial<import("../lib/offline/syncPolicy").QueueItemState> & { tag: string }) => ({
                status: "PENDING" as const, attempts: 0, localSeq: 1, owner: me, ...over,
            });
            const queue = [
                item({ tag: "own-pending-2", localSeq: 2 }),
                item({ tag: "own-failed-due", status: "FAILED", nextAttemptAt: past, localSeq: 1 }),
                item({ tag: "own-failed-later", status: "FAILED", nextAttemptAt: future }),
                item({ tag: "own-needs-attention", status: "NEEDS_ATTENTION" }),
                item({ tag: "own-synced", status: "SYNCED" }),
                item({ tag: "own-syncing", status: "SYNCING" }),
                item({ tag: "other-user", owner: { ...me, userId: "u2" } }),
                item({ tag: "other-tenant", owner: { ...me, tenantId: "t2" } }),
                item({ tag: "other-device", owner: { ...me, deviceId: "d2" } }),
                item({ tag: "legacy-no-owner", owner: undefined }),
            ];
            const selected = policy.selectSyncable(queue, me, now).map((i) => i.tag);
            check("Q1. Only this account's due PENDING/FAILED items are selected, in queue order",
                JSON.stringify(selected) === JSON.stringify(["own-failed-due", "own-pending-2"]), selected.join(","));
            check("Q1. Other users, tenants, devices and legacy unowned items are never selected",
                !selected.some((t) => /other|legacy/.test(t)));

            check("Q2. With the sync lock held, any SYNCING item is an interrupted one",
                policy.isStaleSyncing(item({ tag: "s", status: "SYNCING", syncingSince: now.toISOString() }), now, true));
            check("Q2. Without the lock, a recent SYNCING item is not touched",
                !policy.isStaleSyncing(item({ tag: "s", status: "SYNCING", syncingSince: new Date(now.getTime() - 10_000).toISOString() }), now, false));
            check("Q2. Without the lock, an old SYNCING item is recovered",
                policy.isStaleSyncing(item({ tag: "s", status: "SYNCING", syncingSince: past }), now, false));

            const half = () => 0.5;
            const delays = [1, 2, 3, 10, 20].map((a) => policy.backoffDelayMs(a, half));
            check("Q3. Backoff grows exponentially and is capped at 30 minutes",
                delays[0] === 15_000 && delays[1] === 30_000 && delays[2] === 60_000 && delays[3] === 1_800_000 && delays[4] === 1_800_000,
                delays.join(","));
            const jittered = [0, 1].map((r) => policy.backoffDelayMs(2, () => r));
            check("Q3. Backoff has bounded +/-20% jitter", jittered[0] === 24_000 && jittered[1] === 36_000, jittered.join(","));

            const interpret = policy.interpretResponse;
            check("Q4. 2xx success is success", interpret(200, { success: true }).kind === "success" && interpret(201, { success: true }).kind === "success");
            check("Q4. 401 and OWNER_MISMATCH stop the run without touching items",
                interpret(401, {}).kind === "stop" && interpret(403, { code: "OWNER_MISMATCH", retryable: false }).kind === "stop");
            const inProgress = interpret(409, { code: "IN_PROGRESS", retryable: true, retryAfterSeconds: 42 });
            check("Q4. 409 IN_PROGRESS is retryable and carries Retry-After",
                inProgress.kind === "retryable" && inProgress.retryAfterSeconds === 42);
            check("Q4. 400, 422 and OPERATION_ID_CONFLICT are permanent",
                interpret(400, { retryable: false }).kind === "permanent" && interpret(422, { retryable: false }).kind === "permanent"
                && interpret(409, { code: "OPERATION_ID_CONFLICT", retryable: false }).kind === "permanent");
            check("Q4. 404, 500, 503 and unknown errors are retryable",
                ["404", "500", "503", "502"].every((s) => interpret(Number(s), {}).kind === "retryable"));
            check("Q4. HTTP 200 with success:false is not treated as success", interpret(200, { success: false }).kind !== "success");

            const retryable = { kind: "retryable" as const, message: "x" };
            const permanent = { kind: "permanent" as const, message: "x" };
            const s1 = policy.stateAfterFailure(retryable, 1, now, half);
            check("Q5. A retryable failure schedules a later attempt (FAILED + nextAttemptAt)",
                s1.status === "FAILED" && new Date(s1.nextAttemptAt!).getTime() === now.getTime() + 15_000);
            check("Q5. Retry-After longer than the backoff is respected",
                new Date(policy.stateAfterFailure({ ...retryable, retryAfterSeconds: 120 }, 1, now, half).nextAttemptAt!).getTime() === now.getTime() + 120_000);
            check("Q5. Reaching the attempt limit gives NEEDS_ATTENTION",
                policy.stateAfterFailure(retryable, policy.MAX_CLIENT_ATTEMPTS, now).status === "NEEDS_ATTENTION");
            check("Q5. A permanent failure gives NEEDS_ATTENTION immediately (never retried)",
                policy.stateAfterFailure(permanent, 1, now).status === "NEEDS_ATTENTION");

            const ids = new Set(Array.from({ length: 1000 }, () => policy.newOperationId()));
            check("Q6. Operation IDs are random v4 UUIDs (1000 unique)",
                ids.size === 1000 && [...ids].every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));

            const m = mongoose.mongo;
            const labelled = new m.MongoServerError({ message: "conflict", code: 251 });
            const transientLabel = new m.MongoServerError({ message: "x", code: 999 });
            transientLabel.addErrorLabel("TransientTransactionError");
            const classify = syncErrors.classifySyncError;
            check("Q7. Network, write-conflict, transaction-label and buffering errors are RETRYABLE",
                classify(new m.MongoNetworkError("down")) === "RETRYABLE"
                && classify(new m.MongoNetworkTimeoutError("slow")) === "RETRYABLE"
                && classify(new m.MongoServerError({ message: "WriteConflict", code: 112 })) === "RETRYABLE"
                && classify(labelled) === "RETRYABLE"
                && classify(transientLabel) === "RETRYABLE"
                && classify(new Error("Operation `sales.findOne()` buffering timed out after 10000ms")) === "RETRYABLE");
            check("Q7. Business, validation and duplicate-key errors are PERMANENT",
                classify(new Error("Insufficient stock for product X")) === "PERMANENT"
                && classify(new mongoose.Error.ValidationError()) === "PERMANENT"
                && classify(new m.MongoServerError({ message: "dup", code: 11000 })) === "PERMANENT"
                && classify(new TypeError("bug")) === "PERMANENT");
            const max = syncErrors.MAX_SYNC_ATTEMPTS;
            check("Q8. Server: permanent -> NEEDS_ATTENTION; retryable -> FAILED until the limit, then NEEDS_ATTENTION",
                syncErrors.statusAfterFailure("PERMANENT", 1).status === "NEEDS_ATTENTION"
                && syncErrors.statusAfterFailure("RETRYABLE", max - 1).status === "FAILED"
                && syncErrors.statusAfterFailure("RETRYABLE", max).failureKind === "RETRIES_EXHAUSTED");

            // ============================================== PART 2: API routes
            await connectDB();
            const suffix = run.runId;

            const tenantA = run.newTenantId();
            await Tenant.create({ _id: tenantA, name: run.tenantName("A"), status: "active" });
            const tenantB = run.newTenantId();
            await Tenant.create({ _id: tenantB, name: run.tenantName("B"), status: "active" });

            // Processing a queued sale requires sales.create (role at processing time).
            const salesCreateId = (await ensureTestPermissions(run, Permission, ["sales.create"])).get("sales.create")!;
            const sellerRoles = new Map<string, ObjectId>();
            for (const tenantId of [tenantA, tenantB]) {
                const role = await Role.create({ tenantId, name: `Seller ${suffix}`, permissions: [salesCreateId], status: "active" });
                sellerRoles.set(tenantId.toString(), role._id as ObjectId);
            }

            async function makeUser(tenantId: ObjectId, label: string) {
                const user = await User.create({
                    tenantId, name: `Sync ${label}`, email: `sync-${label}-${suffix}@example.invalid`,
                    passwordHash: "NOT_A_REAL_HASH_TEST_ONLY", status: "active",
                    roleId: sellerRoles.get(tenantId.toString()),
                });
                const device = await Device.create({
                    tenantId, userId: user._id, deviceName: `sync ${label}`, deviceType: "pos",
                    deviceId: `sync-${label}-${suffix}`, status: "active",
                });
                const owner = { tenantId: tenantId.toString(), userId: user._id.toString(), deviceId: device._id.toString() };
                const token = (await createUserSession(owner)).token;
                return { ...owner, token, userObjectId: user._id as ObjectId, deviceObjectId: device._id as ObjectId };
            }

            const u1 = await makeUser(tenantA, "u1");
            const u2 = await makeUser(tenantA, "u2");
            const b1 = await makeUser(tenantB, "b1");

            const category = await Category.create({ tenantId: tenantA, name: "Sync Test" });
            const unit = await Unit.create({ tenantId: tenantA, name: "Piece", shortName: "pc" });
            const product = await Product.create({
                tenantId: tenantA, name: "Sync Widget", SKU: `SYNC-${suffix}`, categoryId: category._id,
                unitId: unit._id, purchasePrice: 50, sellingPrice: 100, stockQuantity: 10,
            });
            const stock = async () => (await Product.findById(product._id).lean())?.stockQuantity;

            const salePayload = (invoiceNo: string, quantity = 1) => ({
                invoiceNo,
                warehouse: { name: "Main Warehouse" },
                items: [{ productId: product._id.toString(), quantity, unitPrice: 100 }],
                paymentMethod: "cash",
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type Handler = (request: any) => Promise<Response>;
            async function call(handler: Handler, path: string, token: string | undefined, body?: unknown, rawBody?: string) {
                const headers = new Headers({ "content-type": "application/json" });
                if (token) headers.set("cookie", `session=${token}`);
                const response = await handler(new NextRequest(new URL(path, "http://localhost:3000"), {
                    method: "POST", headers,
                    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
                }));
                const text = await response.text();
                let json: Json = {};
                try { json = JSON.parse(text); } catch { /* non-JSON */ }
                return { status: response.status, json, headers: response.headers };
            }
            const ownerOf = (u: typeof u1) => ({ tenantId: u.tenantId, userId: u.userId, deviceId: u.deviceId });
            const upload = (u: typeof u1, body: Record<string, unknown>) =>
                call(uploadRoute.POST, "/api/sync-operations", u.token, { operationType: "CREATE", entityType: "Sale", owner: ownerOf(u), ...body });
            const processOp = (u: typeof u1, operationId: string) =>
                call(processRoute.POST, "/api/sync-operations/process", u.token, { operationId });
            const newOp = () => policy.newOperationId();
            const salesFor = (operationId: string) => Sale.countDocuments({ tenantId: tenantA, operationId });
            // A sale's stock movements reference the sale (they are protected by
            // the sale's transaction and its unique operationId, not their own).
            const movementsFor = async (operationId: string) => {
                const sales = await Sale.find({ tenantId: tenantA, operationId }).select("_id").lean();
                return StockMovement.countDocuments({ tenantId: tenantA, referenceId: { $in: sales.map((s) => s._id) } });
            };

            // ---------------------------------------------- validation
            check("V1. Unauthenticated upload and process are rejected (401)",
                (await call(uploadRoute.POST, "/api/sync-operations", undefined, {})).status === 401
                && (await call(processRoute.POST, "/api/sync-operations/process", undefined, {})).status === 401);
            const badJsonUpload = await call(uploadRoute.POST, "/api/sync-operations", u1.token, undefined, "{bad");
            const badJsonProcess = await call(processRoute.POST, "/api/sync-operations/process", u1.token, undefined, "{bad");
            check("V2. Malformed JSON returns 400 with a structured error (not 500)",
                badJsonUpload.status === 400 && badJsonUpload.json.code === "INVALID_REQUEST" && badJsonUpload.json.retryable === false
                && badJsonProcess.status === 400 && badJsonProcess.json.code === "INVALID_REQUEST");
            const invalid: [string, Record<string, unknown>][] = [
                ["non-UUID operationId", { operationId: "OP-123", payload: salePayload(`INV-${suffix}-x`) }],
                ["UPDATE operation type", { operationId: newOp(), operationType: "UPDATE", payload: salePayload(`INV-${suffix}-x`) }],
                ["unsupported entity (Product)", { operationId: newOp(), entityType: "Product", payload: {} }],
                ["payload that is an array", { operationId: newOp(), payload: [1, 2] }],
                ["unknown top-level field", { operationId: newOp(), payload: {}, tenantId: tenantB.toString() }],
                ["oversized payload", { operationId: newOp(), payload: { blob: "x".repeat(120_000) } }],
            ];
            for (const [label, body] of invalid) {
                const r = await upload(u1, body);
                check(`V3. Upload rejects ${label} (400)`, r.status === 400 && r.json.retryable === false, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
            }
            const noOwner = await call(uploadRoute.POST, "/api/sync-operations", u1.token, { operationId: newOp(), operationType: "CREATE", entityType: "Sale", payload: {} });
            check("V3. Upload rejects a missing owner (400)", noOwner.status === 400);
            check("V4. Process rejects an empty operationId (400)", (await processOp(u1, "")).status === 400);

            // ---------------------------------------------- ownership
            const crossUserOp = newOp();
            const crossUser = await call(uploadRoute.POST, "/api/sync-operations", u1.token, {
                operationId: crossUserOp, operationType: "CREATE", entityType: "Sale", payload: salePayload(`INV-${suffix}-cu`), owner: ownerOf(u2),
            });
            check("O1. Uploading another user's queued item under this session is refused (403 OWNER_MISMATCH)",
                crossUser.status === 403 && crossUser.json.code === "OWNER_MISMATCH");
            const crossTenant = await call(uploadRoute.POST, "/api/sync-operations", u1.token, {
                operationId: newOp(), operationType: "CREATE", entityType: "Sale", payload: salePayload(`INV-${suffix}-ct`), owner: ownerOf(b1),
            });
            check("O1. Uploading another tenant's queued item is refused (403)", crossTenant.status === 403);
            check("O1. Nothing was stored for refused uploads", (await SyncOperation.countDocuments({ operationId: crossUserOp })) === 0);

            const op1 = newOp();
            const up1 = await upload(u1, { operationId: op1, payload: salePayload(`INV-${suffix}-1`) });
            const stored = await SyncOperation.findOne({ tenantId: tenantA, operationId: op1 }).lean();
            check("O2. Upload by the owner succeeds (201)", up1.status === 201 && up1.json.alreadyExists === false, JSON.stringify(up1.json));
            check("O2. Stored identity comes from the session (tenant, user, device)",
                stored?.tenantId.equals(tenantA) === true && stored?.userId?.equals(u1.userObjectId) === true && stored?.deviceId.equals(u1.deviceObjectId) === true);
            const otherProcess = await processOp(u2, op1);
            check("O3. Another user/device in the same tenant cannot process it (403) and it stays PENDING",
                otherProcess.status === 403 && otherProcess.json.code === "OWNER_MISMATCH"
                && (await SyncOperation.findById(stored!._id).lean())?.status === "PENDING" && (await salesFor(op1)) === 0);
            check("O4. Another tenant cannot see it (404)", (await processOp(b1, op1)).status === 404);

            // ---------------------------------------------- success + duplicates
            const before = await stock();
            const p1 = await processOp(u1, op1);
            check("S1. Owner processes the sale (200, SYNCED)", p1.status === 200 && p1.json.status === "SYNCED" && p1.json.alreadySynced === false, JSON.stringify(p1.json));
            check("S1. Exactly one sale and one stock movement; stock decreased once", (await salesFor(op1)) === 1 && (await movementsFor(op1)) === 1 && (await stock()) === before! - 1);
            const reUpload = await upload(u1, { operationId: op1, payload: salePayload(`INV-${suffix}-1`) });
            const reProcess = await processOp(u1, op1);
            check("D1. Re-upload after a lost response is accepted (200 alreadyExists)", reUpload.status === 200 && reUpload.json.alreadyExists === true);
            check("D1. Re-processing returns alreadySynced without new effects",
                reProcess.status === 200 && reProcess.json.alreadySynced === true && (await salesFor(op1)) === 1 && (await movementsFor(op1)) === 1 && (await stock()) === before! - 1);
            const conflict = await upload(u2, { operationId: op1, payload: salePayload(`INV-${suffix}-dup`) });
            check("D2. Same operation ID from another device/user is a conflict (409, permanent)",
                conflict.status === 409 && conflict.json.code === "OPERATION_ID_CONFLICT" && conflict.json.retryable === false);

            const parallelOp = newOp();
            await upload(u1, { operationId: parallelOp, payload: salePayload(`INV-${suffix}-par`) });
            const stockBeforeParallel = await stock();
            const parallel = await Promise.all([processOp(u1, parallelOp), processOp(u1, parallelOp), processOp(u1, parallelOp)]);
            const parallelStatuses = parallel.map((r) => r.status).sort();
            check("D3. Three simultaneous process calls: one applies, others are told it is in progress or already done",
                parallelStatuses.filter((s) => s === 200).length >= 1 && parallelStatuses.every((s) => s === 200 || s === 409), parallelStatuses.join(","));
            check("D3. Still exactly one sale, one stock movement, one stock decrement",
                (await salesFor(parallelOp)) === 1 && (await movementsFor(parallelOp)) === 1 && (await stock()) === stockBeforeParallel! - 1);
            check("D3. The operation ends SYNCED", (await SyncOperation.findOne({ tenantId: tenantA, operationId: parallelOp }).lean())?.status === "SYNCED");

            // ---------------------------------------------- stale recovery
            const staleOp = newOp();
            await upload(u1, { operationId: staleOp, payload: salePayload(`INV-${suffix}-stale`) });
            await SyncOperation.updateOne({ tenantId: tenantA, operationId: staleOp }, {
                $set: { status: "PROCESSING", leaseToken: "crashed-worker", leaseExpiresAt: new Date(Date.now() - 1000), attempts: 1 },
            });
            const staleResult = await processOp(u1, staleOp);
            check("R1. An expired lease from a crashed worker is reclaimed and completed (200)",
                staleResult.status === 200 && (await salesFor(staleOp)) === 1, JSON.stringify(staleResult.json));

            const leasedOp = newOp();
            await upload(u1, { operationId: leasedOp, payload: salePayload(`INV-${suffix}-leased`) });
            await SyncOperation.updateOne({ tenantId: tenantA, operationId: leasedOp }, {
                $set: { status: "PROCESSING", leaseToken: "busy-worker", leaseExpiresAt: new Date(Date.now() + 60_000), attempts: 1 },
            });
            const leased = await processOp(u1, leasedOp);
            check("R2. An active lease is respected (409 IN_PROGRESS, retryable, Retry-After)",
                leased.status === 409 && leased.json.code === "IN_PROGRESS" && leased.json.retryable === true
                && Number(leased.headers.get("retry-after")) > 0 && (await salesFor(leasedOp)) === 0);

            // Business transaction committed, but the SYNCED update never happened.
            const committedOp = newOp();
            await upload(u1, { operationId: committedOp, payload: salePayload(`INV-${suffix}-committed`) });
            await SalesService.createSale({ userId: u1.userObjectId, tenantId: tenantA },
                salePayload(`INV-${suffix}-committed`) as Parameters<typeof SalesService.createSale>[1], committedOp);
            const stockAfterCommit = await stock();
            await SyncOperation.updateOne({ tenantId: tenantA, operationId: committedOp }, {
                $set: { status: "PROCESSING", leaseToken: "died-before-status-update", leaseExpiresAt: new Date(Date.now() - 1000), attempts: 1 },
            });
            const recovered = await processOp(u1, committedOp);
            check("R3. Committed-but-unmarked operation is recovered to SYNCED (200)", recovered.status === 200 && recovered.json.status === "SYNCED", JSON.stringify(recovered.json));
            check("R3. No duplicate sale, stock movement or stock change on recovery",
                (await salesFor(committedOp)) === 1 && (await movementsFor(committedOp)) === 1 && (await stock()) === stockAfterCommit);

            // Legacy records (created before this change) have no userId/lease.
            const legacyOp = `LEGACY-${suffix}`;
            await SyncOperation.collection.insertOne({
                tenantId: tenantA, deviceId: u1.deviceObjectId, operationId: legacyOp, operationType: "CREATE", entityType: "Sale",
                payload: salePayload(`INV-${suffix}-legacy`), status: "PROCESSING", attempts: 1,
                lastAttemptAt: new Date(Date.now() - 10 * 60_000), createdAt: new Date(), updatedAt: new Date(),
            });
            check("R4. Legacy record on another device cannot be processed by another user (403)", (await processOp(u2, legacyOp)).status === 403);
            const legacy = await processOp(u1, legacyOp);
            check("R4. Legacy stuck PROCESSING record (no lease) is recovered by its device owner (200)",
                legacy.status === 200 && (await salesFor(legacyOp)) === 1, JSON.stringify(legacy.json));

            // ---------------------------------------------- retry limit
            const exhaustedOp = newOp();
            await upload(u1, { operationId: exhaustedOp, payload: salePayload(`INV-${suffix}-exhausted`) });
            await SyncOperation.updateOne({ tenantId: tenantA, operationId: exhaustedOp }, { $set: { status: "FAILED", attempts: max } });
            const exhausted = await processOp(u1, exhaustedOp);
            const exhaustedDoc = await SyncOperation.findOne({ tenantId: tenantA, operationId: exhaustedOp }).lean();
            check("L1. An operation at the attempt limit is not retried (422 NEEDS_ATTENTION)",
                exhausted.status === 422 && exhausted.json.code === "NEEDS_ATTENTION" && exhausted.json.retryable === false);
            check("L1. It is marked NEEDS_ATTENTION / RETRIES_EXHAUSTED with no sale and no extra attempt",
                exhaustedDoc?.status === "NEEDS_ATTENTION" && exhaustedDoc.failureKind === "RETRIES_EXHAUSTED" && exhaustedDoc.attempts === max && (await salesFor(exhaustedOp)) === 0);

            // ---------------------------------------------- permanent failures
            const stockBeforeBig = await stock();
            const bigOp = newOp();
            await upload(u1, { operationId: bigOp, payload: salePayload(`INV-${suffix}-big`, 1000) });
            const big = await processOp(u1, bigOp);
            const bigDoc = await SyncOperation.findOne({ tenantId: tenantA, operationId: bigOp }).lean();
            check("P1. Insufficient stock is a permanent failure (422, retryable:false)",
                big.status === 422 && big.json.code === "PERMANENT_FAILURE" && big.json.retryable === false && /Insufficient stock/.test(String(big.json.message)), JSON.stringify(big.json));
            check("P1. Operation is NEEDS_ATTENTION (PERMANENT), no sale, stock unchanged",
                bigDoc?.status === "NEEDS_ATTENTION" && bigDoc.failureKind === "PERMANENT" && (await salesFor(bigOp)) === 0 && (await stock()) === stockBeforeBig);
            const bigAgain = await processOp(u1, bigOp);
            check("P1. Retrying a permanent failure is refused without another attempt",
                bigAgain.status === 422 && bigAgain.json.code === "NEEDS_ATTENTION"
                && (await SyncOperation.findOne({ tenantId: tenantA, operationId: bigOp }).lean())?.attempts === bigDoc?.attempts);

            const dupInvoiceOp = newOp();
            await upload(u1, { operationId: dupInvoiceOp, payload: salePayload(`INV-${suffix}-1`) });
            const dupInvoice = await processOp(u1, dupInvoiceOp);
            check("P2. A duplicate invoice number is a permanent failure; no second sale and nothing renumbered",
                dupInvoice.status === 422 && dupInvoice.json.retryable === false
                && (await salesFor(dupInvoiceOp)) === 0 && (await Sale.countDocuments({ tenantId: tenantA, invoiceNo: `INV-${suffix}-1` })) === 1,
                JSON.stringify(dupInvoice.json));

            const invalidOp = newOp();
            await upload(u1, { operationId: invalidOp, payload: { warehouse: { name: "Main" }, items: [] } });
            const invalidResult = await processOp(u1, invalidOp);
            check("P3. Invalid business data is a permanent failure (422)", invalidResult.status === 422 && invalidResult.json.retryable === false);

            check("S2. No sale was created in tenant B", (await Sale.countDocuments({ tenantId: tenantB })) === 0);
        },
    });
}

main().catch((error: unknown) => {
    console.error("Offline sync tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
