# Postman Setup and Test Plan

## 1. Import

1. Open Postman.
2. Import `Billing-SaaS.postman_collection.json`.
3. Import `Billing-SaaS.local.postman_environment.json`.
4. Select the `Billing SaaS - Local` environment.
5. Set `baseUrl` to your local app URL, usually `http://localhost:3000` (no trailing slash).
6. Fill `loginEmail`, `loginPassword`, and `deviceId` with development-only values.
7. Start the Next.js app, then run the login request.
8. Confirm Postman stores the `session` cookie for the same host. Subsequent requests should send it automatically.

## 2. Login requirements

The source shows login needs email, password, and a registered device ID. It checks that the user and tenant are active and that the active device belongs to the matching user/business. An arbitrary device ID will not work.

Do not store real passwords or cookies in an exported collection. The environment uses placeholders and is marked secret where appropriate.

## 3. Suggested test order

1. `Auth - Login`
2. `Auth - Me` — confirms cookie/session is accepted
3. `Categories - List`
4. `Units - List`
5. `Taxes - List`
6. `Products - List`
7. `Customers - List`
8. `Suppliers - List`
9. `Sales - List`
10. `Purchases - List`
11. `Audit Logs - List` (requires audit-read permission)
12. `Auth - Logout`
13. `Auth - Me` again — should now fail authentication

The collection includes safe GET requests and a small number of write requests with placeholder bodies. Before running POST requests, inspect the current route/service validation and use a dedicated test tenant. A request template is not proof the payload matches the implementation.

## 4. Required negative tests

- Call `/api/auth/me` before login: expect `401`.
- Login with an incorrect password: expect authentication failure and verify rate-limit behavior without causing lockout in shared accounts.
- Login using an unregistered/inactive device: expect denial.
- Call a protected route after logout: expect `401`.
- Use an ObjectId belonging to a different tenant in a resource route: ensure it cannot read or mutate that tenant's data.
- Submit duplicate `operationId` to a supported operation: verify it does not duplicate stock/financial effects.
- Attempt a sale exceeding available stock: verify it is rejected and no partial records remain.
- Force a downstream/audit failure only in a safe local test environment: verify transaction rollback.
- Test user role/permission denial and password-change-required restrictions.

## 5. Record results

For every test, record: date, environment, request, expected status, actual status, response body, data side effects, pass/fail, and defect reference. Never mark a test passed just because Postman returned a 2xx; verify database side effects for financial/stock workflows.
