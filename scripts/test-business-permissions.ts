
/*
 * Stage 0 business-permission tests (REAL database test).
 *
 * Calls the real route handlers in-process against MONGODB_URI, inside
 * brand-new temporary tenants that runTestSafely removes afterwards.
 * Permission names missing from the shared catalogue are created with
 * registered IDs and removed again (only those; never pre-existing ones).
 *
 * Covers: allowed vs denied roles on every protected route (nothing written
 * when denied), offline sync upload and processing (permission re-checked
 * at processing time), price override / discount, sale dates (online and
 * sync), duplicate invoice numbers (sequential and concurrent), tenant
 * isolation, sale audit logging and rollback when the audit write fails.
 *
 * Run:
 *   ALLOW_BUSINESS_PERMISSION_TESTS=YES npx tsx scripts/test-business-permissions.ts
 */

import { loadEnvConfig } from "@next/env";
import { assertTestDatabaseUri } from "./lib/testDatabaseGuard";

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

const HOUR = 60 * 60 * 1000;

async function main() {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_BUSINESS_PERMISSION_TESTS !== "YES") {
        throw new Error("Set ALLOW_BUSINESS_PERMISSION_TESTS=YES after confirming MONGODB_URI is a development database.");
    }
    // Only the dedicated test database, checked before anything connects.
    assertTestDatabaseUri(process.env.MONGODB_URI);
    if (process.env.TEST_AUDIT_LOG_FAILURE) {
        throw new Error("Unset TEST_AUDIT_LOG_FAILURE before running these tests.");
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
    const { Supplier } = await import("../lib/models/Supplier");
    const { Tax } = await import("../lib/models/Tax");
    const { Sale } = await import("../lib/models/Sale");
    const { AuditLog } = await import("../lib/models/AuditLog");
    const { SyncOperation } = await import("../lib/models/SyncOperation");
    const { createUserSession } = await import("../lib/auth/sessionStore");
    const { BUSINESS_PERMISSIONS, getSyncEntityPermission } = await import("../lib/auth/businessPermissions");
    const { newOperationId } = await import("../lib/offline/syncPolicy");
    const salesRoute = await import("../app/api/sales/route");
    const purchasesRoute = await import("../app/api/purchases/route");
    const salesReturnsRoute = await import("../app/api/sales-returns/route");
    const purchaseReturnsRoute = await import("../app/api/purchase-returns/route");
    const paymentsRoute = await import("../app/api/payments/route");
    const stockRoute = await import("../app/api/stock-adjustments/route");
    const ledgerRoute = await import("../app/api/ledger-entries/route");
    const taxesRoute = await import("../app/api/taxes/route");
    const taxRoute = await import("../app/api/taxes/[id]/route");
    const uploadRoute = await import("../app/api/sync-operations/route");
    const processRoute = await import("../app/api/sync-operations/process/route");

    type ObjectId = InstanceType<typeof mongoose.Types.ObjectId>;
    const ALL = Object.values(BUSINESS_PERMISSIONS);

    await runTestSafely({
        name: "Business permission tests",
        tenantNamePrefix: "BPERM-TEST-",
        overallTimeoutMs: 300_000,
        summarize,
        run: async (run) => {
            await connectDB();
            const suffix = run.runId;

            // ------------------------------------------------------ fixtures
            const permIds = await ensureTestPermissions(run, Permission, ALL);
            const perms = (...names: string[]) => names.map((name) => permIds.get(name)!);

            const tenantA = run.newTenantId();
            await Tenant.create({ _id: tenantA, name: run.tenantName("A"), status: "active" });
            const tenantB = run.newTenantId();
            await Tenant.create({ _id: tenantB, name: run.tenantName("B"), status: "active" });

            const makeRole = async (tenantId: ObjectId, name: string, names: string[]) =>
                (await Role.create({ tenantId, name: `${name} ${suffix}`, permissions: perms(...names), status: "active" }))._id as ObjectId;

            const fullRoleA = await makeRole(tenantA, "Full", ALL);
            const sellerRoleA = await makeRole(tenantA, "Seller", [BUSINESS_PERMISSIONS.salesCreate]);
            const noneRoleA = await makeRole(tenantA, "None", []);
            const revocableRoleA = await makeRole(tenantA, "Revocable", [BUSINESS_PERMISSIONS.salesCreate]);
            const fullRoleB = await makeRole(tenantB, "Full", ALL);

            async function makeUser(tenantId: ObjectId, label: string, roleId: ObjectId, extra: Record<string, unknown> = {}) {
                const user = await User.create({
                    tenantId, name: `Perm ${label}`, email: `perm-${label}-${suffix}@example.invalid`,
                    passwordHash: "NOT_A_REAL_HASH_TEST_ONLY", status: "active", roleId, ...extra,
                });
                const device = await Device.create({
                    tenantId, userId: user._id, deviceName: `perm ${label}`, deviceType: "pos",
                    deviceId: `perm-${label}-${suffix}`, status: "active",
                });
                const owner = { tenantId: tenantId.toString(), userId: user._id.toString(), deviceId: device._id.toString() };
                const token = (await createUserSession({ ...owner, roleId: roleId.toString() })).token;
                return { ...owner, token, userObjectId: user._id as ObjectId, deviceObjectId: device._id as ObjectId };
            }

            const full = await makeUser(tenantA, "full", fullRoleA);
            const seller = await makeUser(tenantA, "seller", sellerRoleA);
            const none = await makeUser(tenantA, "none", noneRoleA);
            const revocable = await makeUser(tenantA, "revocable", revocableRoleA);
            const tempPw = await makeUser(tenantA, "temppw", fullRoleA, { mustChangePassword: true });
            const fullB = await makeUser(tenantB, "fullb", fullRoleB);

            const category = await Category.create({ tenantId: tenantA, name: `Perm ${suffix}` });
            const unit = await Unit.create({ tenantId: tenantA, name: "Piece", shortName: "pc" });
            const product = await Product.create({
                tenantId: tenantA, name: "Perm Widget", SKU: `PERM-${suffix}`, categoryId: category._id,
                unitId: unit._id, purchasePrice: 50, sellingPrice: 100, stockQuantity: 1000,
            });
            const supplier = await Supplier.create({ tenantId: tenantA, supplierCode: `SUP-${suffix}`, name: `Perm Supplier ${suffix}` });
            const tax = await Tax.create({ tenantId: tenantA, name: "Perm GST", code: `GST-${suffix}`, type: "GST", rate: 18, createdBy: full.userObjectId });
            const categoryB = await Category.create({ tenantId: tenantB, name: `Perm ${suffix}` });
            const unitB = await Unit.create({ tenantId: tenantB, name: "Piece", shortName: "pc" });
            await Product.create({
                tenantId: tenantB, name: "Perm Widget B", SKU: `PERM-B-${suffix}`, categoryId: categoryB._id,
                unitId: unitB._id, purchasePrice: 50, sellingPrice: 100, stockQuantity: 1000,
            });
            const productB = await Product.findOne({ tenantId: tenantB }).lean();

            // ------------------------------------------------------ helpers
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type Handler = (request: any, context?: any) => Promise<Response>;
            async function call(handler: Handler, method: string, path: string, token: string | undefined, body?: unknown, params?: Record<string, string>) {
                const headers = new Headers({ "content-type": "application/json" });
                if (token) headers.set("cookie", `session=${token}`);
                const request = new NextRequest(new URL(path, "http://localhost:3000"), {
                    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
                });
                const response = params ? await handler(request, { params: Promise.resolve(params) }) : await handler(request);
                const text = await response.text();
                let json: Json = {};
                try { json = JSON.parse(text); } catch { /* non-JSON */ }
                return { status: response.status, json };
            }
            const post = (handler: Handler, path: string, user: { token: string }, body: unknown) => call(handler, "POST", path, user.token, body);

            let invoiceCounter = 0;
            const nextInvoice = () => `INV-${suffix}-${++invoiceCounter}`;
            const salePayload = (overrides: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
                invoiceNo: nextInvoice(),
                warehouse: { name: "Main Warehouse" },
                items: [{ productId: product._id.toString(), quantity: 1, ...item }],
                paymentMethod: "cash",
                ...overrides,
            });
            const createSale = (user: { token: string }, payload: Record<string, unknown>) =>
                post(salesRoute.POST as Handler, "/api/sales", user, payload);

            const COLLECTIONS = ["sales", "purchases", "salesreturns", "purchasereturns", "payments", "stockmovements", "ledgerentries", "auditlogs", "syncoperations"];
            async function snapshotA() {
                const db = mongoose.connection.db!;
                const counts: Record<string, number> = {};
                for (const name of COLLECTIONS) counts[name] = await db.collection(name).countDocuments({ tenantId: tenantA });
                counts.stock = (await Product.findById(product._id).lean())?.stockQuantity ?? -1;
                counts.activeTaxes = await Tax.countDocuments({ tenantId: tenantA, status: "active" });
                return JSON.stringify(counts);
            }

            // ---------------------------------------- P1: online route permissions
            const before = await snapshotA();

            const deniedCalls: [string, () => Promise<{ status: number }>][] = [
                ["POST /api/sales (no sales.create)", () => createSale(none, salePayload())],
                ["POST /api/purchases", () => post(purchasesRoute.POST as Handler, "/api/purchases", seller, {
                    purchaseNo: `PUR-${suffix}-denied`, supplierId: supplier._id.toString(), warehouse: { name: "Main Warehouse" },
                    items: [{ productId: product._id.toString(), quantity: 5, unitPrice: 50 }],
                })],
                ["POST /api/sales-returns", () => post(salesReturnsRoute.POST as Handler, "/api/sales-returns", seller, {
                    salesReturnNo: `SR-${suffix}-denied`, saleId: new mongoose.Types.ObjectId().toString(), warehouse: { name: "Main Warehouse" },
                    items: [{ productId: product._id.toString(), quantity: 1 }],
                })],
                ["POST /api/purchase-returns", () => post(purchaseReturnsRoute.POST as Handler, "/api/purchase-returns", seller, {
                    purchaseReturnNo: `PR-${suffix}-denied`, purchaseId: new mongoose.Types.ObjectId().toString(), warehouse: { name: "Main Warehouse" },
                    items: [{ productId: product._id.toString(), quantity: 1 }],
                })],
                ["POST /api/payments", () => post(paymentsRoute.POST as Handler, "/api/payments", seller, {
                    paymentNo: `PAY-${suffix}-denied`, type: "receipt", amount: 10, paymentMethod: "cash", saleId: new mongoose.Types.ObjectId().toString(),
                })],
                ["POST /api/stock-adjustments", () => post(stockRoute.POST as Handler, "/api/stock-adjustments", seller, {
                    operationId: newOperationId(), productId: product._id.toString(), quantity: 5, warehouse: { name: "Main Warehouse" }, reason: "denied test",
                })],
                ["POST /api/ledger-entries", () => post(ledgerRoute.POST as Handler, "/api/ledger-entries", seller, {
                    entries: [
                        { transactionId: new mongoose.Types.ObjectId().toString(), transactionType: "receipt", account: "cash", entryType: "debit", amount: 10 },
                        { transactionId: new mongoose.Types.ObjectId().toString(), transactionType: "receipt", account: "accounts_receivable", entryType: "credit", amount: 10 },
                    ],
                })],
                ["GET /api/taxes", () => call(taxesRoute.GET as Handler, "GET", "/api/taxes", seller.token)],
                ["DELETE /api/taxes/[id]", () => call(taxRoute.DELETE as Handler, "DELETE", `/api/taxes/${tax._id}`, seller.token, undefined, { id: tax._id.toString() })],
            ];
            for (const [label, fn] of deniedCalls) {
                const response = await fn();
                check(`P1. ${label}: a role without the permission gets 403`, response.status === 403, String(response.status));
            }
            check("P1. Denied requests wrote nothing (sales, stock, payments, ledger, returns, purchases, audit, taxes)",
                (await snapshotA()) === before, `${before} -> ${await snapshotA()}`);

            const tempPwSale = await createSale(tempPw, salePayload());
            check("P1. A temporary-password user is rejected (401) even with a full role", tempPwSale.status === 401, String(tempPwSale.status));

            // Allowed calls (full role).
            const saleForReturns = await createSale(seller, salePayload({ paidAmount: 0 }, { quantity: 3 }));
            check("P2. POST /api/sales: a role with sales.create gets 201", saleForReturns.status === 201, JSON.stringify(saleForReturns.json).slice(0, 200));
            const saleId = saleForReturns.json.sale?._id as string;

            const purchase = await post(purchasesRoute.POST as Handler, "/api/purchases", full, {
                purchaseNo: `PUR-${suffix}-1`, supplierId: supplier._id.toString(), warehouse: { name: "Main Warehouse" },
                items: [{ productId: product._id.toString(), quantity: 5, unitPrice: 50 }],
            });
            check("P2. POST /api/purchases with purchases.create gets 201", purchase.status === 201, JSON.stringify(purchase.json).slice(0, 200));

            const salesReturn = await post(salesReturnsRoute.POST as Handler, "/api/sales-returns", full, {
                salesReturnNo: `SR-${suffix}-1`, saleId, warehouse: { name: "Main Warehouse" },
                items: [{ productId: product._id.toString(), quantity: 1 }],
            });
            check("P2. POST /api/sales-returns with salesReturns.create gets 201", salesReturn.status === 201, JSON.stringify(salesReturn.json).slice(0, 200));

            const purchaseReturn = await post(purchaseReturnsRoute.POST as Handler, "/api/purchase-returns", full, {
                purchaseReturnNo: `PR-${suffix}-1`, purchaseId: purchase.json.purchase?._id, warehouse: { name: "Main Warehouse" },
                items: [{ productId: product._id.toString(), quantity: 1 }],
            });
            check("P2. POST /api/purchase-returns with purchaseReturns.create gets 201", purchaseReturn.status === 201, JSON.stringify(purchaseReturn.json).slice(0, 200));

            const payment = await post(paymentsRoute.POST as Handler, "/api/payments", full, {
                paymentNo: `PAY-${suffix}-1`, type: "receipt", amount: 10, paymentMethod: "cash", saleId,
            });
            check("P2. POST /api/payments with payments.create gets 200", payment.status === 200, JSON.stringify(payment.json).slice(0, 200));

            const adjustment = await post(stockRoute.POST as Handler, "/api/stock-adjustments", full, {
                operationId: newOperationId(), productId: product._id.toString(), quantity: 5, warehouse: { name: "Main Warehouse" }, reason: "allowed test",
            });
            check("P2. POST /api/stock-adjustments with stock.adjust gets 200", adjustment.status === 200, JSON.stringify(adjustment.json).slice(0, 200));

            const ledgerTx = new mongoose.Types.ObjectId().toString();
            const ledger = await post(ledgerRoute.POST as Handler, "/api/ledger-entries", full, {
                entries: [
                    { transactionId: ledgerTx, transactionType: "receipt", account: "cash", entryType: "debit", amount: 10 },
                    { transactionId: ledgerTx, transactionType: "receipt", account: "accounts_receivable", entryType: "credit", amount: 10 },
                ],
            });
            check("P2. POST /api/ledger-entries with ledger.create gets 201", ledger.status === 201, JSON.stringify(ledger.json).slice(0, 200));

            const taxes = await call(taxesRoute.GET as Handler, "GET", "/api/taxes", full.token);
            check("P2. GET /api/taxes with taxes.read gets 200 and only this tenant's taxes",
                taxes.status === 200 && Array.isArray(taxes.json.taxes)
                && taxes.json.taxes.every((t: { tenantId: string }) => t.tenantId === tenantA.toString()) && taxes.json.taxes.length === 1);
            const taxesB = await call(taxRoute.DELETE as Handler, "DELETE", `/api/taxes/${tax._id}`, fullB.token, undefined, { id: tax._id.toString() });
            check("P2. Another tenant's user cannot deactivate this tenant's tax (404)", taxesB.status === 404, String(taxesB.status));
            const taxDelete = await call(taxRoute.DELETE as Handler, "DELETE", `/api/taxes/${tax._id}`, full.token, undefined, { id: tax._id.toString() });
            check("P2. DELETE /api/taxes/[id] with taxes.delete gets 200", taxDelete.status === 200, String(taxDelete.status));

            const crossTenant = await createSale(fullB, salePayload());
            check("P2. Tenant isolation: a sale in tenant B cannot use tenant A's product", crossTenant.status === 400 && /not found/i.test(String(crossTenant.json.message)));

            // ---------------------------------------- P3: price override and discount
            const s0 = await snapshotA();
            const overrideDenied = await createSale(seller, salePayload({}, { unitPrice: 90 }));
            const discountDenied = await createSale(seller, salePayload({}, { discountRate: 10 }));
            check("P3. A different price without sales.priceOverride is refused (403)", overrideDenied.status === 403, String(overrideDenied.status));
            check("P3. A discount without sales.priceOverride is refused (403)", discountDenied.status === 403, String(discountDenied.status));
            check("P3. Refused sales wrote nothing", (await snapshotA()) === s0, `${s0} -> ${await snapshotA()}`);
            const samePrice = await createSale(seller, salePayload({}, { unitPrice: 100 }));
            check("P3. Sending the product's own selling price is allowed", samePrice.status === 201, String(samePrice.status));
            const overrideAllowed = await createSale(full, salePayload({}, { unitPrice: 90, discountRate: 5 }));
            check("P3. With sales.priceOverride a different price and discount are allowed", overrideAllowed.status === 201, JSON.stringify(overrideAllowed.json).slice(0, 200));
            const overrideAudit = await AuditLog.findOne({ tenantId: tenantA, entity: "Sale", entityId: overrideAllowed.json.sale?._id }).lean();
            check("P3. The audit log records that the price was overridden", overrideAudit?.newValues?.priceOverridden === true);

            // ---------------------------------------- P4: sale dates (online)
            const s1 = await snapshotA();
            const backdateDenied = await createSale(seller, salePayload({ saleDate: new Date(Date.now() - 48 * HOUR).toISOString() }));
            check("P4. A sale dated 2 days ago without sales.backdate is refused (403)", backdateDenied.status === 403, String(backdateDenied.status));
            const futureSeller = await createSale(seller, salePayload({ saleDate: new Date(Date.now() + HOUR).toISOString() }));
            const futureFull = await createSale(full, salePayload({ saleDate: new Date(Date.now() + HOUR).toISOString() }));
            check("P4. A sale dated 1 hour in the future is refused, even with every permission",
                futureSeller.status === 400 && futureFull.status === 400 && /future/i.test(String(futureFull.json.message)));
            const invalidDate = await createSale(full, salePayload({ saleDate: "not-a-date" }));
            check("P4. An invalid sale date is refused", invalidDate.status === 400, String(invalidDate.status));
            check("P4. Refused dated sales wrote nothing", (await snapshotA()) === s1, `${s1} -> ${await snapshotA()}`);
            const recent = await createSale(seller, salePayload({ saleDate: new Date(Date.now() - 5 * 60 * 1000).toISOString() }));
            check("P4. A sale dated 5 minutes ago is allowed without sales.backdate", recent.status === 201, String(recent.status));
            const backdateAllowed = await createSale(full, salePayload({ saleDate: new Date(Date.now() - 48 * HOUR).toISOString() }));
            check("P4. With sales.backdate a sale dated 2 days ago is allowed", backdateAllowed.status === 201, String(backdateAllowed.status));
            const backdateAudit = await AuditLog.findOne({ tenantId: tenantA, entity: "Sale", entityId: backdateAllowed.json.sale?._id }).lean();
            check("P4. The audit log records the backdated sale", backdateAudit?.newValues?.backdated === true);

            // ---------------------------------------- P5: duplicate invoice numbers
            const dupNo = `INV-${suffix}-DUP`;
            const first = await createSale(seller, salePayload({ invoiceNo: dupNo }));
            const s2 = await snapshotA();
            const again = await createSale(seller, salePayload({ invoiceNo: dupNo }));
            const caseVariant = await createSale(seller, salePayload({ invoiceNo: `  ${dupNo.toLowerCase()}  ` }));
            check("P5. First use of an invoice number succeeds", first.status === 201);
            check("P5. The same invoice number again is refused with a clear message",
                again.status === 400 && /already exists/i.test(String(again.json.message)), JSON.stringify(again.json));
            check("P5. The same number in different case / with spaces is refused too",
                caseVariant.status === 400 && /already exists/i.test(String(caseVariant.json.message)), JSON.stringify(caseVariant.json));
            check("P5. Refused duplicates wrote nothing", (await snapshotA()) === s2, `${s2} -> ${await snapshotA()}`);
            const otherTenant = await post(salesRoute.POST as Handler, "/api/sales", fullB, {
                invoiceNo: dupNo, warehouse: { name: "Main Warehouse" }, items: [{ productId: productB!._id.toString(), quantity: 1 }],
            });
            check("P5. Another tenant may use the same invoice number", otherTenant.status === 201, JSON.stringify(otherTenant.json).slice(0, 200));

            const raceNo = `INV-${suffix}-RACE`;
            const stockBeforeRace = (await Product.findById(product._id).lean())?.stockQuantity ?? 0;
            const race = await Promise.all([1, 2, 3].map(() => createSale(seller, salePayload({ invoiceNo: raceNo }))));
            const raceSales = await Sale.find({ tenantId: tenantA, invoiceNo: raceNo }).select("_id").lean();
            check("P5. Three concurrent sales with one invoice number: exactly one is created",
                race.filter((r) => r.status === 201).length === 1 && raceSales.length === 1,
                race.map((r) => `${r.status}:${r.json.message ?? ""}`).join(" | "));
            check("P5. ...stock was decreased exactly once",
                (await Product.findById(product._id).lean())?.stockQuantity === stockBeforeRace - 1);
            check("P5. ...and the losers got a clear 'already exists' message",
                race.filter((r) => r.status !== 201).every((r) => /already exists/i.test(String(r.json.message))),
                race.map((r) => String(r.json.message)).join(" | "));

            const indexes = await mongoose.connection.db!.collection("sales").listIndexes().toArray();
            const invoiceIndex = indexes.find((ix) => JSON.stringify(ix.key) === JSON.stringify({ tenantId: 1, invoiceNo: 1 }));
            check("P5. The database's unique tenantId+invoiceNo index is present", Boolean(invoiceIndex?.unique), JSON.stringify(invoiceIndex));
            const declared = Sale.schema.indexes();
            check("P5. The Sale model declares exactly the database's invoice and operationId indexes",
                declared.some(([key, opts]) => JSON.stringify(key) === JSON.stringify({ tenantId: 1, invoiceNo: 1 }) && opts?.unique === true && !opts?.partialFilterExpression && !opts?.sparse)
                && declared.filter(([key]) => JSON.stringify(key) === JSON.stringify({ tenantId: 1, operationId: 1 })).length === 1
                && declared.some(([key, opts]) => JSON.stringify(key) === JSON.stringify({ tenantId: 1, operationId: 1 }) && opts?.unique === true && Boolean(opts?.partialFilterExpression) && !opts?.sparse));

            // ---------------------------------------- P6: sale audit log
            const auditSaleId = first.json.sale?._id;
            const auditLogs = await AuditLog.find({ tenantId: tenantA, entity: "Sale", entityId: auditSaleId }).lean();
            check("P6. A sale creates exactly one audit log (tenant, user, device, invoice)",
                auditLogs.length === 1 && auditLogs[0].action === "CREATE"
                && auditLogs[0].userId?.toString() === seller.userId
                && auditLogs[0].deviceId?.toString() === seller.deviceId
                // Invoice numbers are stored upper-case.
                && auditLogs[0].newValues?.invoiceNo === dupNo.toUpperCase(), JSON.stringify(auditLogs[0] ?? null).slice(0, 300));

            const s3 = await snapshotA();
            const failNo = `INV-${suffix}-AUDITFAIL`;
            process.env.TEST_AUDIT_LOG_FAILURE = "true";
            let auditFailure;
            try {
                auditFailure = await createSale(seller, salePayload({ invoiceNo: failNo }));
            } finally {
                delete process.env.TEST_AUDIT_LOG_FAILURE;
            }
            check("P6. When the audit write fails, the sale is refused", auditFailure.status === 400, JSON.stringify(auditFailure.json));
            check("P6. ...and the sale, stock movement, stock change and ledger entries are all rolled back",
                (await snapshotA()) === s3 && (await Sale.countDocuments({ tenantId: tenantA, invoiceNo: failNo })) === 0,
                `${s3} -> ${await snapshotA()}`);

            // ---------------------------------------- P7: offline sync
            const ownerOf = (u: typeof seller) => ({ tenantId: u.tenantId, userId: u.userId, deviceId: u.deviceId });
            const upload = (u: typeof seller, payload: Record<string, unknown>, operationId = newOperationId()) =>
                call(uploadRoute.POST as Handler, "POST", "/api/sync-operations", u.token,
                    { operationId, operationType: "CREATE", entityType: "Sale", payload, owner: ownerOf(u) })
                    .then((r) => ({ ...r, operationId }));
            const processOp = (u: typeof seller, operationId: string) =>
                call(processRoute.POST as Handler, "POST", "/api/sync-operations/process", u.token, { operationId });
            const opStatus = async (operationId: string) => (await SyncOperation.findOne({ tenantId: tenantA, operationId }).lean())?.status;
            const salesFor = (operationId: string) => Sale.countDocuments({ tenantId: tenantA, operationId });

            const okUp = await upload(seller, salePayload());
            const okProc = await processOp(seller, okUp.operationId);
            check("P7. Sync: a role with sales.create uploads and processes a sale",
                okUp.status === 201 && okProc.status === 200 && (await salesFor(okUp.operationId)) === 1);
            const syncAudit = await AuditLog.findOne({ tenantId: tenantA, entity: "Sale", "newValues.operationId": okUp.operationId }).lean();
            check("P7. The synced sale is audited with the uploading device", syncAudit?.deviceId?.toString() === seller.deviceId);

            const deniedUp = await upload(none, salePayload());
            check("P7. Sync upload without sales.create is refused (403 PERMISSION_DENIED) and nothing is stored",
                deniedUp.status === 403 && deniedUp.json.code === "PERMISSION_DENIED" && deniedUp.json.retryable === false
                && !(await SyncOperation.exists({ tenantId: tenantA, operationId: deniedUp.operationId })));

            const revUp = await upload(revocable, salePayload());
            await Role.updateOne({ _id: revocableRoleA, tenantId: tenantA }, { $pull: { permissions: permIds.get(BUSINESS_PERMISSIONS.salesCreate) } });
            const s4 = await snapshotA();
            const revProc = await processOp(revocable, revUp.operationId);
            check("P7. Permission removed after upload: processing re-checks the CURRENT role and refuses (403)",
                revUp.status === 201 && revProc.status === 403 && revProc.json.code === "PERMISSION_DENIED", `${revUp.status}/${revProc.status}`);
            check("P7. ...the operation is flagged NEEDS_ATTENTION for review", (await opStatus(revUp.operationId)) === "NEEDS_ATTENTION");
            const s4after = JSON.parse(await snapshotA());
            const s4before = JSON.parse(s4);
            check("P7. ...and no sale, stock movement, ledger entry or audit log was created",
                (await salesFor(revUp.operationId)) === 0
                && ["sales", "stockmovements", "ledgerentries", "payments", "auditlogs", "stock"].every((k) => s4after[k] === s4before[k]),
                `${s4} -> ${JSON.stringify(s4after)}`);

            const syncOverride = await upload(seller, salePayload({}, { unitPrice: 80 }));
            const syncOverrideProc = await processOp(seller, syncOverride.operationId);
            check("P7. Sync: a price override without sales.priceOverride is flagged (422, NEEDS_ATTENTION, no sale)",
                syncOverrideProc.status === 422 && (await opStatus(syncOverride.operationId)) === "NEEDS_ATTENTION" && (await salesFor(syncOverride.operationId)) === 0,
                `${syncOverrideProc.status} ${syncOverrideProc.json.message}`);

            // ---------------------------------------- P8: sale dates (sync)
            const at = (ms: number) => new Date(Date.now() - ms).toISOString();
            const within = await upload(seller, salePayload({ saleDate: at(20 * HOUR) }));
            const withinProc = await processOp(seller, within.operationId);
            check("P8. Sync: a sale made 20 hours before the server received it is accepted", withinProc.status === 200 && (await salesFor(within.operationId)) === 1, `${withinProc.status} ${withinProc.json.message}`);

            const tooOld = await upload(seller, salePayload({ saleDate: at(30 * HOUR) }));
            const tooOldProc = await processOp(seller, tooOld.operationId);
            check("P8. Sync: a sale 30 hours older than its receipt is flagged for review without sales.backdate",
                tooOldProc.status === 422 && (await opStatus(tooOld.operationId)) === "NEEDS_ATTENTION" && (await salesFor(tooOld.operationId)) === 0,
                `${tooOldProc.status} ${tooOldProc.json.message}`);

            const oldAllowed = await upload(full, salePayload({ saleDate: at(30 * HOUR) }));
            const oldAllowedProc = await processOp(full, oldAllowed.operationId);
            check("P8. Sync: with sales.backdate the 30-hour-old sale is accepted", oldAllowedProc.status === 200, `${oldAllowedProc.status} ${oldAllowedProc.json.message}`);

            // The window is measured from the server's first receipt, not from now:
            // received 10 h ago, sale made 30 h ago -> 20 h before receipt -> allowed.
            const lateProcessed = await upload(seller, salePayload({ saleDate: at(30 * HOUR) }));
            await SyncOperation.collection.updateOne(
                { tenantId: tenantA, operationId: lateProcessed.operationId },
                { $set: { createdAt: new Date(Date.now() - 10 * HOUR) } }
            );
            const lateProc = await processOp(seller, lateProcessed.operationId);
            check("P8. Sync: the 24-hour window is measured from the server's first receipt (received 10 h ago, sale 30 h ago: accepted)",
                lateProc.status === 200 && (await salesFor(lateProcessed.operationId)) === 1, `${lateProc.status} ${lateProc.json.message}`);

            const future = await upload(full, salePayload({ saleDate: new Date(Date.now() + HOUR).toISOString() }));
            const futureProc = await processOp(full, future.operationId);
            check("P8. Sync: a future-dated sale is flagged even with every permission",
                futureProc.status === 422 && (await salesFor(future.operationId)) === 0, `${futureProc.status} ${futureProc.json.message}`);

            const dupSync = await upload(seller, salePayload({ invoiceNo: dupNo }));
            const dupSyncProc = await processOp(seller, dupSync.operationId);
            check("P8. Sync: a duplicate invoice number is flagged NEEDS_ATTENTION with no new sale",
                dupSyncProc.status === 422 && (await opStatus(dupSync.operationId)) === "NEEDS_ATTENTION" && (await salesFor(dupSync.operationId)) === 0,
                `${dupSyncProc.status} ${dupSyncProc.json.message}`);

            // ---------------------------------------- P9: unmapped operation types (deny by default)
            const UNMAPPED = ["Product", "Customer", "Supplier", "Bogus", "constructor", "__proto__", "toString"];
            check("P9. Only the six mapped types have a permission; unmapped names (incl. object built-ins) have none",
                ["Sale", "SalesReturn", "Purchase", "PurchaseReturn", "Payment", "StockAdjustment"].every((t) => getSyncEntityPermission(t) !== null)
                && UNMAPPED.every((t) => getSyncEntityPermission(t) === null)
                && getSyncEntityPermission(undefined) === null && getSyncEntityPermission(42) === null);

            // A user holding EVERY permission still cannot upload an unmapped type.
            // Strict request validation rejects it (400 INVALID_REQUEST) before
            // the permission-map backstop and before any database write.
            const s5 = JSON.parse(await snapshotA());
            for (const entityType of UNMAPPED) {
                const operationId = newOperationId();
                const response = await call(uploadRoute.POST as Handler, "POST", "/api/sync-operations", full.token, {
                    operationId, operationType: "CREATE", entityType, payload: salePayload(), owner: ownerOf(full),
                });
                check(`P9. Upload of unmapped type "${entityType}" is rejected by validation (400 INVALID_REQUEST) even with every permission, nothing stored`,
                    response.status === 400 && response.json.code === "INVALID_REQUEST" && response.json.retryable === false
                    && !(await SyncOperation.exists({ tenantId: tenantA, operationId })),
                    `${response.status} ${response.json.code}`);
            }

            // Stored operations of an unmapped type (e.g. legacy records) are
            // rejected at processing BEFORE being claimed. The payload is a
            // valid sale, so a wrong code path would visibly create a sale.
            for (const entityType of ["Product", "Customer", "Bogus"]) {
                const operationId = newOperationId();
                await SyncOperation.collection.insertOne({
                    tenantId: tenantA, userId: full.userObjectId, deviceId: full.deviceObjectId, operationId,
                    operationType: "CREATE", entityType, payload: salePayload(), status: "PENDING", attempts: 0,
                    createdAt: new Date(), updatedAt: new Date(),
                });
                const response = await processOp(full, operationId);
                const stored = await SyncOperation.findOne({ tenantId: tenantA, operationId }).lean();
                check(`P9. Processing a stored "${entityType}" operation is rejected (403 PERMISSION_DENIED) before it is claimed`,
                    response.status === 403 && response.json.code === "PERMISSION_DENIED" && response.json.retryable === false
                    && stored?.attempts === 0 && !stored?.leaseToken,
                    `${response.status} ${response.json.code} attempts=${stored?.attempts}`);
                check(`P9. ...the "${entityType}" operation is flagged NEEDS_ATTENTION (PERMANENT) for review`,
                    stored?.status === "NEEDS_ATTENTION" && stored?.failureKind === "PERMANENT", `${stored?.status}/${stored?.failureKind}`);
                const again = await processOp(full, operationId);
                check(`P9. ...processing it again is still refused`, again.status === 422 || again.status === 403, String(again.status));
            }
            const s5after = JSON.parse(await snapshotA());
            check("P9. Unmapped operations created no business records (sales, stock, payments, ledger, returns, purchases, audit)",
                ["sales", "purchases", "salesreturns", "purchasereturns", "payments", "stockmovements", "ledgerentries", "auditlogs", "stock", "activeTaxes"]
                    .every((key) => s5after[key] === s5[key]),
                `${JSON.stringify(s5)} -> ${JSON.stringify(s5after)}`);
            check("P9. ...and the only new sync records are the three inserted by this test", s5after.syncoperations === s5.syncoperations + 3);
        },
    });
}

main().catch((error: unknown) => {
    console.error("Business permission tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
