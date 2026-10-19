# Offline billing hardening — status, open decisions and definition of done

Last updated: 2026-10-13 (second pass). Covers audit items M-4 to M-20, the database test isolation work and the open design plans (sections 7–10).

How to read the status words:

- **Static** — checked by reading code or by database-free test scripts (logic in memory, source text, build output). Does not prove browser or database behaviour.
- **Browser** — proven in a real browser. **Not done for any item yet.**
- **Database** — proven against the isolated `billing_test` database. **Not done for any item yet** (each run needs the owner's explicit approval; see section 10).

## 1. Checklist

| Item | Topic | Status | Evidence |
|---|---|---|---|
| M-1 | Sync errors sanitized and classified | Done (static) | `scripts/test-sync-error-classification.ts` 32/32 |
| M-2 | Double-click protection on the test sale button | Done (static) | type check |
| M-3 | Network failures do not use up retry attempts | Done (static) | `scripts/test-sync-network-failure.ts` 30/30 |
| M-4 | Request timeouts (5 s session, 5 s logout, 20 s sync) | Done (static) | `scripts/test-request-timeouts.ts` 20/20 |
| M-5 | Truthful queue status and reasons | Done (static) | `scripts/test-queue-status.ts` 28/28 |
| M-6 | Exposed database credentials | Rotated (owner reported); Atlas test-user scope **UNVERIFIED** | section 6 |
| M-7 | Exact `billing_test` guard in every database test script | Done (static) | `scripts/test-db-test-safety.ts` 48/48 |
| M-8 | Browser test and its server use the same database; server on 127.0.0.1 only | Done (static + refusal runs) | `scripts/test-db-test-safety.ts` |
| M-9 | Offline sale date vs. sync window | **Blocked — decision** | section 2 |
| M-10 | Recovery of NEEDS_ATTENTION operations | **Blocked — decision** (visibility part done in M-5) | section 2 |
| M-11 | Invoice numbering | Done (static) | `scripts/test-stage-6b4-invoice-numbering.ts` 60/60 |
| M-12 | Real offline billing screen and local catalogue | **Blocked — depends on M-9, M-14, M-15, M-16 and a catalogue permission decision** | sections 2, 9 |
| M-13 | Automatic sync on open / reconnect | Done (static) | `scripts/test-auto-sync.ts` 15/15 |
| M-14 | Offline payments and ledger | **Blocked — decision** | section 2 |
| M-15 | Stock shortage at sync time | **Blocked — decision** | section 2 |
| M-16 | Price change before sync | **Blocked — decision** | section 2 |
| M-17 | Pending-operation export ownership | **Blocked — decision** | section 2 |
| M-18 | Persistent storage and "not saved" messages | Done (static) | `scripts/test-storage-durability.ts` 15/15 |
| M-19 | Service-worker updates and open tabs | Done (static + build output) | `scripts/test-sw-update.ts` 14/14 |
| M-20 | Definition of done | Matrix written (section 4); browser test updated for automatic sync but **not run** (section 3) | — |
| M-21 | Customer Management + Offline Access | Done (static) | `scripts/test-customer-offline-sync.ts` 59/59 |

All database-free scripts are listed in section 5.

## 2. Decisions needed from the owner

Nothing below has been implemented. Each choice changes accounting, stock, invoices or what a cashier may do.

### M-9 — Which date does an offline sale get?

Facts in the code:

- Offline work is allowed for **72 hours** after the last online check (`lib/offline/offlineSession.ts`).
- At sync, a sale dated more than **24 hours** before the server first received it needs the `sales.backdate` permission (`SALE_DATE_RULES.syncMaxAgeMs` in `lib/auth/businessPermissions.ts`, whose comment says it "matches the 24-hour offline window" — written when the window was 24 hours).
- The test page sends **no sale date**, so the server uses the **sync time** as the sale date.

Result today: a sale made on Monday and synced on Wednesday is either booked on Wednesday (no date sent) or rejected for a cashier without `sales.backdate` (date sent).

Options:

1. **Keep the device time as the sale date, accept it up to 72 hours (+5 min clock tolerance) before the server received it**, and store both "recorded on device" and "received by server" times. Recommended: matches the offline window; the device clock is already checked against the server at every online login and rollback is detected.
2. Keep 24 hours and shorten the offline window to 24 hours.
3. Always book offline sales at the sync time (simplest, but daily totals and tax dates are wrong for delayed syncs).

### M-10 — What may a manager do with an operation that needs attention?

Today: the server never retries it, nothing in the code ever uses the existing `CANCELLED` status, and there is no screen to act on it. The cashier now sees the reason (M-5). Options for the server action (all audit-logged, original payload kept):

1. "Retry after the cause is fixed" (e.g. stock corrected) — reuses the same operation ID, so no duplicate is possible.
2. "Cancel with a reason" — the sale is not booked; who refunds/returns goods is a business process.
3. Both, behind a new permission (e.g. `sync.resolve`).

Depends on M-15 (what "fixing" stock means).

### M-11 — Invoice numbers

Fact: **online and offline sales both take the invoice number from the browser** (`app/api/sales/route.ts` passes the request body through); the only protection is a unique index per business. A clash makes an offline sale fail permanently. There is no printed invoice yet. Options:

1. **Device prefix**: each device numbers its own series (e.g. `C2-000123`). Simple; numbers are not one continuous series.
2. **Server-issued number at sync**, with a provisional reference printed offline (e.g. `PROV-C2-17`). One continuous series; the customer's offline receipt shows a provisional reference.
3. Pre-allocated number blocks per device. Continuous per block; more complex.

Check local tax/invoice rules before choosing (some require a continuous series).

### M-12 — Offline billing screen

Cannot be designed safely before M-9 (date), M-11 (number), M-14 (payment), M-15 (stock) and M-16 (price). Suggested order: M-9 → M-11 → M-16 → M-15 → M-14 → M-12. It will also need a read-only local catalogue (products, prices, taxes, customers) of the signed-in business only, with a "last updated" time.

### M-14 — Payment recorded offline

Facts: a sale stores `paidAmount` only; no Payment record is created and the ledger gets only "receivable" and "revenue" lines (`lib/services/SalesService.ts`). Nothing marks a payment as unverified. Decisions needed:

- Is an offline cash payment final? (usually yes — the cashier holds the cash)
- Is an offline UPI/card payment **pending verification** until matched with the bank/UPI statement? (a screenshot is never proof)
- Which ledger lines are written at sale time and which at verification?
- Partial payments, failed payments and refunds.

### M-15 — Not enough stock when the offline sale syncs

Today the whole sale is rejected and needs attention (stock never goes below zero). Options: keep rejecting (manager resolves via M-10); allow negative stock for synced offline sales and flag it; per-business setting.

### M-16 — Price changed before the sale synced

Today a sent price that differs from the **current** server price counts as a price override and needs `sales.priceOverride`; if no price is sent, the server uses the current price (the controlled test page does this). Options: accept the price charged at the time if it matches the catalogue the device had (needs a catalogue version, M-12); treat any difference as an override (today); always use the current price (customer may have been charged differently).

### M-17 — Who may export the waiting operations?

Today the export contains **every** unsynced operation on the device, of every account and business, and is offered to a person whose sign-in was just stopped by someone else's waiting operations. This is how the device is unblocked for a different account. Options: keep as is (documented risk: one click exposes other accounts' waiting sales on a shared device); export only items of the same business as the person signing in (a different business cannot unblock the device); export only the signed-in account's own items (another account can never unblock the device; the original account must sync).

## 3. Browser test: updated for automatic sync (M-13) — not yet run

Since M-13 the dashboard sends waiting operations automatically whenever it opens. `scripts/test-offline-sync-browser.ts` has been updated to that behaviour (type check and ESLint pass; it has **not been run**, it needs the database and the owner's approval):

- A helper `waitForQueueSettled(owner)` waits until the dashboard's own sync has finished before queue snapshots are compared.
- **B3**: new check that Alice's dashboard sends her waiting item under **her** identity. The simulated "crashed tab" now happens after her logout, just before Bob signs in.
- **B4**: "nothing uploaded" became "nothing uploaded **under Bob**" (and the item on the server still belongs to Alice).
- **B5**: her next dashboard visit recovers the interrupted item (checked), then the existing checks.
- **B20a**: the dashboard sends the item automatically (checked); "Sync now" must still answer truthfully; neither renews the offline session.
- **B21 / B20a**: the newly added item is found by its new operation ID, not by "the first PENDING item".
- **B22**: "server session stayed active while offline" is now measured while still offline (on reconnection the dashboard completes the pending logout itself).

What the browser test still cannot check, and why: nothing proves a real IndexedDB survives a PC restart; MongoDB transactions on the Atlas cluster are only exercised once the test runs.

## 4. Definition of done (test matrix)

"Required proof" says which level of evidence is needed before the item can be called done. Payment, stock and price rows depend on the decisions above.

| Area | Acceptance criterion | Required proof | Today |
|---|---|---|---|
| Authentication | Offline work only with a valid 72-hour authorization from a server-verified login; expiry and clock rollback block new work | Static + Browser | Static ✔ (`test-offline-session`, `test-session-confirmation`) |
| Permissions | Server re-checks the user's current role for every synced operation | Static + Database | Static ✔; Database ✘ |
| Tenant isolation | Upload/process only by the owning business, user and device; another account never uploads or sees them | Static + Database + Browser | Static ✔ (`test-pending-guard`, `test-offline-sync` part 1); others ✘ |
| Local persistence | A sale is stored in IndexedDB before "added" is shown; survives refresh, browser restart, PC restart | Browser | Static ✔ (`test-storage-durability`); Browser ✘ |
| Storage failure | A failed save says "NOT saved"; full disk named; nothing is cleared | Static + Browser | Static ✔ |
| Duplicate submission | One click = one queued sale; re-sending the same operation never creates a second sale | Static + Database | Static ✔; Database ✘ (`test-offline-sync` D1/D3) |
| Sale committed once | Exactly one sale, one stock movement per line, two ledger lines (+ payment lines per M-14), one audit entry | Database | ✘ — `test-offline-sync` checks sale and stock only; ledger/audit/payment checks to be added |
| Stock | Stock changes once; shortage follows the M-15 decision | Database | ✘ (decision pending) |
| Payments & ledger | Per M-14 decision; retries never duplicate postings; unverified UPI never shown as confirmed | Database | ✘ (decision pending) |
| Network failure / timeout | No attempt counted, item untouched, run stops; lost response recovered by re-sending the same ID | Static + Browser | Static ✔ (`test-sync-network-failure`, `test-request-timeouts`); Browser ✘ |
| Invoice numbers | Server-issued sequential number at sync, provisional reference offline; no clashes; idempotent retry | Static + Database | Static ✔ (`test-stage-6b4-invoice-numbering` 60/60); Database ✘ |
| Error sanitization | No database, driver or code detail reaches the cashier, the queue or the export | Static | ✔ (`test-sync-error-classification`, `test-public-error`) |
| Automatic sync | On open / reconnect / tab shown; no loops; one run at a time | Static + Browser | Static ✔ (`test-auto-sync`) |
| Service-worker update | Open tabs keep working; update only on the user's choice; queue untouched | Static + Browser | Static ✔ (`test-sw-update`, build output) |
| Logout / account switch | Queue kept; another account blocked until synced or exported (per M-17) | Static + Browser | Static ✔ (`test-pending-guard`) |
| Test isolation | Every database test refuses any database other than exactly `billing_test` before connecting; browser test starts its own server on 127.0.0.1 | Static | ✔ (`test-db-test-safety` 48/48, refusal runs); Atlas user scope UNVERIFIED |
| Tax | Tax rate per line comes from an approved rule, not freely from the device | Static + Database | ✘ — today the device chooses the rate (section 7) |
| Customers | Offline customer caching, local customer creation/update, stable IDs, dependency resolution for queued sales, idempotent sync | Static + Browser | Static ✔ (`test-customer-offline-sync` 59/59); Browser ✘ |

## 5. Database-free test scripts

Run from the project root with `npx tsx scripts/<name>.ts`. None connects to a database, server or network.

`test-offline-session`, `test-pending-guard`, `test-session-confirmation`, `test-cache-cleanup`, `test-session-policy`, `test-security-headers`, `test-public-error`, `test-sync-error-classification`, `test-sync-network-failure`, `test-origin-check`, `test-request-timeouts`, `test-queue-status`, `test-db-test-safety`, `test-auto-sync`, `test-storage-durability`, `test-sw-update`, `test-product-cache`, `test-offline-product-sync`, `test-barcode-normalization`, `test-stage-6b4-invoice-numbering`, `test-customer-offline-sync`.

Database-backed (each run needs the owner's explicit approval; see section 10): `test-offline-sync`, `test-offline-sync-browser`, `test-auth-security`, `test-audit-log-security`, `test-browser-e2e`, `test-business-permissions`, `test-password-management`, `test-permission-security`, `test-temporary-password`, `test-user-management` — all now refuse any database other than `billing_test` before connecting. `test-mongodb-connection` (its "live" scenario only connects and disconnects, writes nothing) is deliberately unguarded. The setup/admin scripts (`create-*`, `assign-*`, `grant-*`, `remove-*`, `reset-*`, `setup-*`, `designate-*`, `register-*`, `find-*`, `inspect-*`, `verify-*`) have **no guard** and 16 of them load `.env.local` (the **main** database) on purpose: never run them for testing.

## 6. Credential rotation checklist (M-6)

Status: the owner reported both credentials rotated and a separate test `SESSION_SECRET` added to `.env.test.local` (presence checked without reading the value). Still **UNVERIFIED**: the Atlas test user's actual privileges (step 2), and that the test `SESSION_SECRET` differs from the production one.

Both MongoDB connection strings (main database user and test database user) were shown in tool output on 2026-10-13. Treat both passwords as known to others until changed.

1. MongoDB Atlas → Database Access → edit the **main database user** → set a new strong password.
2. Do the same for the **test database user**. Make sure the test user has access **only** to `billing_test`.
3. Atlas → Network Access: check the IP access list contains only addresses you expect.
4. Update `.env.local` (main) and `.env.test.local` (test) yourself in an editor. Never paste them into a terminal, chat or ticket.
5. Update any hosting or deployment environment that uses the main connection string.
6. Optional: consider rotating `SESSION_SECRET` too if `.env.local` was ever shared (this signs every user out).
7. Atlas → Project → Activity Feed / Access logs: look for connections you do not recognise since 2026-10-13.
8. Tell the engineer when done; only then can database-backed tests be planned (each one still needs approval).

## 7. What an offline sale does on the server today (source inspection)

Path: `/offline-test` → `addToSyncQueue` (one IndexedDB write, `lib/offline/SyncQueueService.ts`) → `syncPendingOperations` (`lib/offline/SyncManager.ts`) → `POST /api/sync-operations` (store, owner checked against the session) → `POST /api/sync-operations/process` → `SyncService.processOperation` (lease claim, current-role permission check) → `SalesService.createSale` in **one MongoDB transaction**.

One synced sale writes: 1 `Sale` (unique per business + operation ID), 1 `StockMovement` per line, 2 `LedgerEntry` lines (accounts receivable debit, sales revenue credit, both for the grand total), 1 `AuditLog`. It writes **no `Payment`** record, **no cash/bank ledger line** for the amount paid, and **no cost-of-goods** entry.

Findings that need a decision (not changed):

- **Tax rate is chosen by the device.** Products have no tax link (`lib/models/Product.ts`); `Tax` records exist per business but are not attached to products. `SalesService.createSale` accepts any `taxRate >= 0` per line. A cashier (or an edited request) can send 0 % tax. Decision needed: which tax applies to which product (e.g. a `taxId` on each product) and whether the server must enforce it.
- **Paid amount is trusted from the device** (`paidAmount`, `paymentMethod`); see M-14.
- **Product list permission.** `GET /api/products` requires `products.read`; a cashier who only has `sales.create` cannot download the catalogue needed offline. Decision: give cashiers `products.read`, or add a read-only catalogue endpoint behind `sales.create` that returns only selling fields (name, SKU, barcode, unit, selling price, tax).
- **Returns of offline sales.** `SalesReturnService` needs the server `saleId`; the device only knows its operation ID until the sale has synced. Offline returns of offline sales are therefore not possible today.
- **Fractional quantities.** Stock is updated with floating-point `$inc`; repeated fractional sales (e.g. 0.1 kg) can accumulate rounding error. Decision: allowed precision per unit (e.g. 3 decimals) and rounding rule.
- **Transactions.** All six writing services use `session.withTransaction`. Atlas clusters (including free M0) are replica sets and support transactions, but this has **not** been exercised against `billing_test` yet (UNVERIFIED until the first approved database run).
- **Two devices sell the last item offline**: the first to sync wins; the second is rejected as "Insufficient stock" and needs attention (M-15). **Product deactivated before sync**: rejected permanently ("Product not found or inactive"). **Repeated sync after a timeout**: safe — the same operation ID returns the existing sale.

## 8. Invoice numbering — implemented architecture (Module M-11)

Implemented policy: online and synced sales receive authoritative legal sequential numbers from the server; offline sales receive collision-resistant provisional references on the device; at sync the server assigns the final sequential number; the provisional reference stays permanently linked for traceability; retrying the same operation never creates another sale or burns an invoice number.

Implemented architecture:

1. **Counter collection** `counters`: `{ tenantId, key: "invoice:PREFIX:YYYY", seq }`, unique on `tenantId + key`. A number is taken atomically with `findOneAndUpdate({ tenantId, key }, { $inc: { seq: 1 } }, { upsert: true, new: true, session })` **inside the sale's transaction** via `InvoiceNumberService`.
2. **Format**: `INV-YYYY-XXXX` (e.g. `INV-2026-0001`), supporting yearly reset and optional custom series prefixes.
3. **Sale fields**: `invoiceNo` (authoritative permanent legal number, assigned by server) and `provisionalInvoiceNo` (provisional reference generated on the client, e.g. `OFFLINE-DEV1-XXXX`).
4. **Device reference**: `generateProvisionalReference("DEV1")` creates collision-resistant references (`OFFLINE-DEV1-L9XYZ1-A7B2`) stored in the queued payload and shown on offline receipts clearly labeled "Provisional — Pending Server Confirmation".
5. **Idempotency before number allocation**: `SalesService.createSale` checks `tenantId + operationId` **first** before invoking the invoice number generator. A retry returns the existing committed sale and invoice number immediately without consuming sequence numbers or burning counters.
6. **Local reconciliation**: `SyncManager.syncOne` reconciles `permanentInvoiceNo` and `serverSaleId` into the local `syncQueue.payload` on sync success, preserving the original `provisionalInvoiceNo`.
7. **UI distinction**: POS receipts and sales detail pages distinguish offline provisional receipts from confirmed legal GST Tax Invoices.
8. **Tests**: 60/60 database-free checks passed in `scripts/test-stage-6b4-invoice-numbering.ts`.

## 9. Offline billing screen — plan and blockers

There is no real billing screen yet: `/offline-test` is a controlled test page, `/` is the Next.js starter page. A genuine screen needs:

| Part | Can be built now? | Blocked by |
|---|---|---|
| Local catalogue (IndexedDB table per business, "last updated" time, read-only) | Design ready | Catalogue permission decision (section 7) |
| Search by name / SKU / barcode, cart, quantities | Yes, once the catalogue exists | — |
| Price shown and sent | No | M-16 (price policy) |
| Tax per line | No | Tax decision (section 7) |
| Discounts | Only with `sales.priceOverride` (existing rule) | — |
| Customer selection | Yes (cached customers of the business) | Customer list permission (same as catalogue) |
| Invoice / receipt reference | No | M-11 implementation approval (section 8) |
| Payment method and amount | No | M-14 (payment policy) |
| Sale date | No | M-9 (date policy) |
| Save locally, pending/synced/failed list, retry | Yes — reuses `addToSyncQueue`, `queueStatus.ts`, `AutoSync` | — |
| "Pending sync" receipt | Layout only | M-11, M-14 |

Recommended order of decisions: M-9 → M-11 → tax → M-16 → M-15 → M-14 → catalogue permission → build the screen.

## 10. Running a database test safely (each run needs explicit approval)

Facts (source): the test scripts call `loadEnvConfig(process.cwd(), false)`. Without `NODE_ENV=test` they load `.env.local` (the **main** database) and refuse to run. With `NODE_ENV=test` they load only `.env.test.local` (`billing_test`, test `SESSION_SECRET`) and never `.env.local`. Values already set in the shell win over files. The browser test's server inherits the test's environment unchanged.

Command shape (no secrets in the command or the shell history):

```powershell
$env:NODE_ENV = "test"; $env:ALLOW_OFFLINE_SYNC_TESTS = "YES"; npx tsx scripts/test-offline-sync.ts
```

Before the first run the owner must confirm in Atlas that the test user has only `readWrite@billing_test`.

If a run is killed hard (power loss, closing the window): temporary businesses named `SYNC-TEST-*` / `SYNCB-TEST-*` and their records may remain **in `billing_test` only**; the browser test may also leave its own `next start` (port 3130) and headless Chrome running — the next run refuses until that port is free.
