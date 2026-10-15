# Billing SaaS API Reference (Code-Reviewed Draft)

**Base URL:** `{{baseUrl}}`  
**Content type:** `application/json` for JSON request bodies  
**Authentication:** HTTP-only `session` cookie set by `/api/auth/login`  
**Source:** `documentation-source.txt`, supplied 15 Oct 2026  
**Status:** Route inventory and selected handler behavior reviewed; validate payloads/responses in Postman before publishing as a final contract.

## 1. Authentication

### Login
`POST /api/auth/login`

Login validates credentials, active tenant, and an active registered device. On success, the response sets an HTTP-only cookie named `session`; the browser/Postman cookie jar should retain it for subsequent requests. Login uses rate limiting and may return `429` or `503` if rate-limit infrastructure is unavailable.

Example body (field names observed in login handler; confirm required schema in current source):
```json
{
  "email": "admin@example.com",
  "password": "replace-with-test-password",
  "deviceId": "registered-device-id"
}
```

Success response includes `success`, `message`, `user`, `tenant`, and `device`. Do not put real passwords or secrets into shared collections.

### Session identity
`GET /api/auth/me` — inspect current authenticated user, tenant, device/permissions as returned by implementation.

### Logout
`POST /api/auth/logout` — revokes the current server-side session and clears the cookie. If server-side revocation fails, handler can return `503` while clearing the local cookie.

### Logout all sessions
`POST /api/auth/logout-all` — revokes all sessions belonging to the caller; requires authentication.

### Change password
`POST /api/auth/change-password` — authenticated password-change flow; inspect handler for exact body fields and rules before use.

## 2. Endpoint inventory

HTTP methods below are the methods found in the source export where identifiable. Route handlers may export more than one method. For request bodies, use the current route/service validation rather than assuming the examples below are complete.

| Method | Path | Purpose / notes |
|---|---|---|
| GET | `/api/audit-logs` | Paginated audit-log list; filters include `page`, `limit`, `action`, `entity`, `entityId`; requires authentication and audit-read permission; tenant scope comes from session |
| GET | `/api/audit-logs/[id]` | Read a specific audit log within tenant scope; no client POST is intentionally provided |
| POST | `/api/auth/change-password` | Change password |
| POST | `/api/auth/login` | Login; sets HTTP-only `session` cookie |
| POST | `/api/auth/logout` | Revoke current session and clear cookie |
| POST | `/api/auth/logout-all` | Revoke all caller sessions |
| GET | `/api/auth/me` | Current session identity |
| GET, POST | `/api/categories` | List/create categories |
| GET, POST | `/api/customers` | List/create customers |
| GET, POST | `/api/customers/[id]` | Read/update customer (verify exact exported methods; source inventory should be authoritative) |
| GET, POST | `/api/devices` | List/register devices (verify exact handler semantics) |
| GET, POST | `/api/devices/[id]` | Read/update device (verify exact exported methods) |
| POST | `/api/ledger-entries` | Ledger-entry operation/query endpoint; inspect body schema and permission rules |
| POST | `/api/payments` | Create/process payment |
| GET, POST | `/api/products` | List/create products |
| GET, POST | `/api/products/[id]` | Read/update product (verify exact exported methods) |
| POST | `/api/purchase-returns` | Create purchase return |
| GET, POST | `/api/purchases` | List/create purchases; GET is tenant-scoped and returns up to 100 recent records in inspected handler |
| GET, POST | `/api/purchases/[id]` | Read/update purchase (verify exact exported methods) |
| GET, POST | `/api/sales` | List/create sales |
| POST | `/api/sales-returns` | Create sales return |
| POST | `/api/stock-adjustments` | Create stock adjustment; operation ID/idempotency behavior applies where validated |
| GET, POST | `/api/suppliers` | List/create suppliers |
| GET, POST | `/api/suppliers/[id]` | Read/update supplier (verify exact exported methods) |
| POST | `/api/sync-operations` | Submit/register sync operation |
| POST | `/api/sync-operations/process` | Process queued sync operation |
| GET | `/api/taxes` | List taxes |
| GET | `/api/taxes/[id]` | Read tax record |
| GET, POST | `/api/units` | List/create units |
| GET, POST | `/api/users` | List/create users; list supports `page`, `limit`, `search`, `status`; permission checked |
| GET | `/api/users/roles` | List active tenant roles and whether caller may assign each role |
| GET | `/api/users/[id]` | Read user |
| GET | `/api/users/[id]/password` | Route inventory reported GET; verify carefully: route is password-related and should not be assumed to expose a password. Check handler before calling. |

**Route inventory caution:** The source export includes route files and handler code. Some earlier terminal output was produced during a PowerShell read error; re-run the corrected inventory script if method accuracy is in doubt. Never infer PUT/PATCH/DELETE support from a route name.

## 3. Common response patterns

Observed examples include:
```json
{ "success": true, "message": "..." }
```
and errors such as:
```json
{ "success": false, "message": "Authentication required" }
```
Some endpoints include resource properties (`product`, `sale`, `purchase`, `customer`, etc.) and paginated endpoints include:
```json
{
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```
Use the actual response from each handler as the definitive contract. Error codes/statuses vary by endpoint.

## 4. Status codes to test

- `200`: successful read or operation
- `201`: resource created (purchase-return handler uses `201` on success)
- `400`: invalid business/request data (some service routes use this for caught errors)
- `401`: missing/invalid session or credentials
- `403`: permission denied, inactive tenant, or device/user policy violation
- `404`: resource not found or not visible in tenant
- `409`: conflict (for example, ambiguous registered device during login or duplicate/idempotency conflict where implemented)
- `429`: login rate limit
- `500`: unexpected server error
- `503`: temporary infrastructure/session revocation failure

These are observed/expected categories, not a guarantee that every route implements every status.

## 5. Security rules for API consumers

- Do not send a client-controlled `tenantId` and expect it to define access. Tenant identity is derived from the verified session on protected routes.
- Use a separate test tenant and disposable test records.
- Never share real cookies, passwords, session secrets, Atlas URIs, or production data.
- Keep `session` cookie handling enabled in Postman; don't manually copy session tokens into shared environments.
- Test missing cookie, expired/revoked cookie, wrong permissions, cross-tenant IDs, invalid ObjectIds, duplicate operation IDs, insufficient stock, and invalid payment amounts.
- Login requires a registered active device. Use an existing development device ID or register one through the authorized workflow; don't guess a device ID.
- Audit logs are server-generated; clients must not be allowed to fabricate audit events.
