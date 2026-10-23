# Billing SaaS — Database Design (Code-Reviewed Draft)

**Project:** Nexvra Billing / POS / Inventory  
**Database:** MongoDB Atlas with Mongoose  
**Source reviewed:** `documentation-source.txt` supplied on 15 Oct 2026  
**Status:** Draft for review. This describes source-defined models; verify deployed Atlas indexes before calling it a production database specification.

## 1. Design principles visible in source

- Multi-tenant business data uses `tenantId`; authenticated routes derive tenant identity from the server-verified session rather than trusting a client-supplied tenant ID.
- Mongoose schemas use `timestamps: true` for most operational models, adding `createdAt` and `updatedAt`.
- Relationships are commonly represented by MongoDB `ObjectId` fields and Mongoose `ref` values.
- Tenant-scoped unique indexes allow the same business key in different tenants while preventing duplicates within one tenant.
- Sales, stock, payments, ledger entries, audit logs, and sync operations have service-layer logic. A schema/index alone does not prove every transaction path is atomic; test transaction behavior against the configured Atlas deployment.
- Offline retry safety uses `operationId` on supported operations and tenant-scoped uniqueness/idempotency checks.

## 2. Model / collection inventory

These model files were present in the source export. The names below are the Mongoose model names and typically become collections using Mongoose's pluralization. Confirm actual collection names in Atlas.

| Model file / model | Purpose | Key design notes observed |
|---|---|---|
| `Tenant` | Business account / tenant | `name`, optional `businessType`, `status`, optional `ownerUserId`; timestamps |
| `User` | Staff / login identity | `tenantId`, `name`, normalized `email`, `passwordHash`, optional `roleId`, `status`, `mustChangePassword`; unique `{tenantId,email}` |
| `Role` | Tenant roles and permission assignments | Used by authorization and user management; inspect full schema for all fields |
| `Permission` | Permission definitions / grants | Used by permission resolution; inspect full schema for exact keys |
| `Device` | Registered client device | Login requires an active device associated with the user and tenant |
| `Session` | Server-side sessions | Session token carries a session ID; only active server-side session is valid; TTL index on `expiresAt` |
| `LoginRateLimit` | Login abuse protection counters | HMAC-derived `key`, failures, window/lockout fields, expiry; unique `key` and TTL `expiresAt` indexes |
| `TenantAdminGuard` | Concurrency guard for tenant administrator changes | `tenantId`, `revision`; unique `{tenantId}` |
| `Category` | Product categories | Tenant-scoped master data; inspect schema for exact fields/indexes |
| `Unit` | Units of measure | `tenantId`, `name`, `shortName`, `status`; unique `{tenantId,name}` |
| `Product` | Product/SKU/barcode and stock master | Tenant-scoped product master; inspect full schema for all inventory fields and indexes |
| `Tax` | Tax configuration | `name`, uppercase `code`, `type`, `rate` 0–100, optional description, status, `createdBy`; unique `{tenantId,code}` |
| `Customer` | Customer master | Tenant-scoped customer data; inspect full schema for exact fields/indexes |
| `Supplier` | Supplier master | Tenant-scoped supplier data; inspect full schema for exact fields/indexes |
| `Purchase` | Purchase / goods receipt | Tenant-scoped purchase records; service manages purchase creation and inventory effects |
| `PurchaseReturn` | Returns to supplier | Includes operation idempotency design; service handles stock/financial effects |
| `Sale` | Sales invoices | Tenant-scoped invoice; unique `{tenantId,invoiceNo}`; partial unique `{tenantId,operationId}` when `operationId` exists; indexes for customer, sale date, payment status, status |
| `SalesReturn` | Customer sales returns | Return lines include product/customer snapshots and tax/price totals; supports `operationId` |
| `StockMovement` | Inventory movement audit trail | Product, movement type, quantity, previous/new stock, warehouse snapshot, reference and actor; operation idempotency index is defined in source |
| `Payment` | Payments / receipts | Supports `operationId` for sync idempotency; inspect full schema for fields/statuses |
| `LedgerEntry` | Accounting-style entries | Transaction, account, debit/credit, amount, optional customer/supplier/reference, entry date and actor; compound indexes on tenant + transaction/date/account |
| `AuditLog` | Security/business audit history | Actor, tenant, optional device, action/entity/entityId, description, old/new values; server-side service writes records; route intentionally has no client POST |
| `SyncOperation` | Offline operation queue / server processing state | Unique `{tenantId,operationId}`; indexes for tenant/device/status and tenant/createdAt; retry/error/synced metadata |

### Supporting-model caution
`TenantAdminGuard` is a real Mongoose model (not merely a helper), so it likely maps to a database collection. `Session` and `LoginRateLimit` are security-support collections. They are additional to the original 21 business collections.

## 3. Relationships (logical)

- `Tenant` → many `User`, `Role`, `Device`, product/master records, transactions, audit records and sync records.
- `User` → optional `Role`; also referenced as creator/actor in operational records.
- `Device` → associated with a user and tenant; a device is required during login.
- `Sale` → optional `Customer`; sale lines reference products and retain product snapshots.
- `Purchase` → supplier and product references/snapshots (verify exact fields in `Purchase.ts`).
- `SalesReturn` → original `Sale`, optional customer, returned products.
- `PurchaseReturn` → original purchase/supplier and returned products (verify exact field names).
- `StockMovement` → product plus optional reference to the business transaction.
- `Payment` and `LedgerEntry` → linked to the originating transaction/party according to service inputs.
- `AuditLog` → tenant, user, optional device and changed entity.
- `SyncOperation` → tenant/device plus operation identity and processing outcome.

These are logical relationships, not MongoDB foreign-key constraints. Validate referenced IDs and tenant ownership in services.

## 4. Important schema/index rules confirmed in source

| Model | Index / rule | Purpose |
|---|---|---|
| User | unique `{ tenantId: 1, email: 1 }` | Same email can exist in separate businesses; not twice in one business |
| Unit | unique `{ tenantId: 1, name: 1 }` | Unit name unique per tenant |
| Tax | unique `{ tenantId: 1, code: 1 }` | Tax code unique per tenant |
| Sale | unique `{ tenantId: 1, invoiceNo: 1 }` | Invoice number unique per tenant |
| Sale | partial unique `{ tenantId: 1, operationId: 1 }` when operationId exists | Prevent duplicate offline operation processing |
| SyncOperation | unique `{ tenantId: 1, operationId: 1 }` | One sync operation identity per tenant |
| SyncOperation | `{ tenantId: 1, deviceId: 1, status: 1 }` | Find operations by device and status |
| SyncOperation | `{ tenantId: 1, createdAt: -1 }` | Recent sync history |
| Session | TTL `{ expiresAt: 1 }` | MongoDB cleanup of expired session records; application must still check expiry/revocation |
| LoginRateLimit | unique `{ key: 1 }`; TTL `{ expiresAt: 1 }` | Unique rate-limit counter and automatic cleanup |
| TenantAdminGuard | unique `{ tenantId: 1 }` | One guard record per tenant |
| LedgerEntry | `{ tenantId, transactionId }`, `{ tenantId, entryDate }`, `{ tenantId, account, entryDate }` | Transaction/account history queries |

**Important:** Source-defined indexes and indexes actually deployed in Atlas can differ until Mongoose index creation/migrations are applied. Compare with Atlas index listings before release.

## 5. Business transaction guidance

The service architecture should preserve the following invariants and tests:

1. Sale creation: validate tenant-owned product/customer, calculate totals server-side, verify stock, decrement stock, create sale, stock movement, ledger/audit records as applicable, and commit/rollback consistently.
2. Purchase creation: validate supplier/product references, create purchase, increase stock, record stock movement, payment/ledger/audit records as applicable.
3. Returns and adjustments: verify source transaction/permissions, prevent negative stock where policy forbids it, update stock and ledger/audit records consistently.
4. Payments: validate transaction ownership, amount and payment status; avoid duplicate processing using operation identity where supported.
5. Sync: treat `operationId` as an idempotency key; distinguish retryable infrastructure failures from permanent business errors; never blindly retry a permanent error.
6. Tenant isolation: test cross-tenant reads, updates, deletes, IDOR attempts, and referenced product/customer/supplier IDs.
7. Offline authorization: project policy is 24 hours; ensure this is enforced in the actual offline client and server sync validation, not only documented.

## 6. Database verification checklist

- [ ] Compare every model schema against the deployed Atlas collections and indexes.
- [ ] Confirm unique indexes exist and handle pre-existing duplicate data before creation.
- [ ] Confirm Atlas deployment supports multi-document transactions (replica set / supported cluster).
- [ ] Test rollback when audit logging or a downstream write fails.
- [ ] Test duplicate `operationId` requests and operation-ID conflicts.
- [ ] Test cross-tenant reference IDs on every write service.
- [ ] Confirm TTL indexes are deployed; TTL cleanup is asynchronous, so authorization must check expiry itself.
- [ ] Record MongoDB backup/restore and migration/index deployment procedures.
- [ ] Avoid storing raw credentials; `passwordHash` is an Argon2id hash in source, and login rate-limit keys are HMAC-derived.

## 7. Scope / limitations

This document is a code-reviewed design draft, not a live Atlas schema dump. Exact field-by-field definitions for every model should be expanded from each `lib/models/*.ts` file and compared against the deployed database. Do not claim every workflow is tested solely because a model or endpoint exists.
