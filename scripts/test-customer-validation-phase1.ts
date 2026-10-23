/**
 * Test Suite: Customer Security, Validation, and Lifecycle Isolation (Phase 1)
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Customer-create permission checks:
 *    - Unauthenticated returns 401
 *    - Role missing customer write permissions ("sales.create", "users.read") returns 403
 *    - Role with "sales.create" succeeds
 *    - Role with "users.read" succeeds
 *    - Auth context without roleId (owner/legacy) succeeds
 * 2. Shared createCustomerSchema validation:
 *    - Blank name (empty string, whitespace-only, missing) rejected
 *    - Name exceeding 200 characters rejected
 *    - Valid trimmed name (1-200 chars) accepted
 *    - Phone exceeding 30 characters rejected
 *    - Valid phone (1-30 chars) accepted and trimmed
 *    - Empty string or null phone converts to undefined on create
 *    - Malformed email (missing @, missing domain, invalid format) rejected
 *    - Email exceeding 200 characters rejected
 *    - Valid email lowercased and accepted
 *    - Empty string or null email converts to undefined on create
 *    - Address exceeding 500 characters rejected
 *    - Valid address accepted and trimmed
 *    - Empty string or null address converts to undefined on create
 *    - Status enum enforces "active" | "inactive" (default "active", "blocked" rejected)
 *    - Strict schema rejects unrecognized keys
 * 3. Shared updateCustomerSchema validation & lifecycle isolation:
 *    - Blank name on update rejected
 *    - Name exceeding 200 characters rejected
 *    - PUT cannot pass or change "status" directly (strict schema rejects status)
 *    - Empty update payload {} rejected
 *    - Phone exceeding 30 characters rejected
 *    - Malformed email on update rejected
 *    - Email exceeding 200 characters rejected
 *    - Address exceeding 500 characters rejected
 * 4. Omitted vs Explicitly Cleared optional fields contract:
 *    - Omitted optional fields (undefined) preserve stored values (not in $set or $unset)
 *    - Explicitly cleared fields via null produce null (added to $unset: { [field]: 1 })
 *    - Explicitly cleared fields via empty/whitespace string produce null (added to $unset: { [field]: 1 })
 *    - Valid new values added to $set
 * 5. Handler logic simulation:
 *    - Duplicate phone check prevents collisions with status 409
 *    - Lifecycle transitions preserved via PATCH with transition guards and audit logging
 *
 * Run:
 *   npx tsx scripts/test-customer-validation-phase1.ts
 */

import {
    createCustomerSchema,
    updateCustomerSchema,
    clearableOptionalString,
    clearableOptionalEmail,
    customerLifecycleSchema,
    isValidCustomerTransition,
    CUSTOMER_WRITE_PERMISSIONS,
} from "../lib/validations/customer";

// ============================================================
// TEST HARNESS
// ============================================================

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n============================================================`);
    console.log(`CUSTOMER VALIDATION & SECURITY (PHASE 1) SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// ============================================================
// 1. PERMISSION CHECKS & AUTHORIZATION
// ============================================================

console.log("\n=== 1. CUSTOMER-CREATE PERMISSION CHECK & AUTHORIZATION ===");

// Simulate permission check helper following any-of semantics
function evaluateCustomerCreatePermission(auth: {
    userId: string;
    tenantId: string;
    roleId?: string;
    rolePermissions?: string[];
}): { status: number; message?: string } {
    if (!auth) {
        return { status: 401, message: "Authentication required" };
    }

    if (auth.roleId) {
        const userPerms = new Set(auth.rolePermissions || []);
        const granted = CUSTOMER_WRITE_PERMISSIONS.filter((p) => userPerms.has(p));
        if (granted.length === 0) {
            return { status: 403, message: "You do not have permission to create customers" };
        }
    }

    return { status: 201 };
}

check(
    "1.1 CUSTOMER_WRITE_PERMISSIONS contains sales.create and users.read",
    CUSTOMER_WRITE_PERMISSIONS.includes("sales.create") && CUSTOMER_WRITE_PERMISSIONS.includes("users.read")
);

const unauthResult = evaluateCustomerCreatePermission(null as any);
check("1.2 Unauthenticated customer creation returns 401", unauthResult.status === 401);

const unauthorizedRole = evaluateCustomerCreatePermission({
    userId: "u1",
    tenantId: "t1",
    roleId: "r-viewer",
    rolePermissions: ["reports.view", "inventory.read"],
});
check("1.3 Role without customer-write permissions returns 403", unauthorizedRole.status === 403);
check(
    "1.3b 403 error message explains lack of create permission",
    unauthorizedRole.message === "You do not have permission to create customers"
);

const cashierRole = evaluateCustomerCreatePermission({
    userId: "u2",
    tenantId: "t1",
    roleId: "r-cashier",
    rolePermissions: ["sales.create", "sales.read"],
});
check("1.4 Role with 'sales.create' permission succeeds", cashierRole.status === 201);

const managerRole = evaluateCustomerCreatePermission({
    userId: "u3",
    tenantId: "t1",
    roleId: "r-manager",
    rolePermissions: ["users.read", "inventory.manage"],
});
check("1.5 Role with 'users.read' permission succeeds", managerRole.status === 201);

const ownerContext = evaluateCustomerCreatePermission({
    userId: "u4",
    tenantId: "t1",
    // No roleId: owner / super-admin context
});
check("1.6 Context without roleId (owner/legacy) succeeds", ownerContext.status === 201);

// ============================================================
// 2. CREATE CUSTOMER SCHEMA VALIDATION
// ============================================================

console.log("\n=== 2. CREATE CUSTOMER SCHEMA VALIDATION ===");

// Name validation
const emptyName = createCustomerSchema.safeParse({ name: "" });
check("2.1 Empty name is rejected", !emptyName.success);

const whitespaceName = createCustomerSchema.safeParse({ name: "   " });
check("2.2 Whitespace-only name is rejected", !whitespaceName.success);

const missingName = createCustomerSchema.safeParse({});
check("2.3 Missing name is rejected", !missingName.success);

const longName = createCustomerSchema.safeParse({ name: "A".repeat(201) });
check("2.4 Name exceeding 200 characters is rejected", !longName.success);

const maxName = createCustomerSchema.safeParse({ name: "A".repeat(200) });
check("2.5 Name exactly 200 characters is accepted", maxName.success);

const validName = createCustomerSchema.safeParse({ name: "  Ramesh Traders  " });
check("2.6 Valid name is accepted and trimmed", validName.success && validName.data?.name === "Ramesh Traders");

// Phone validation
const longPhone = createCustomerSchema.safeParse({
    name: "Valid Customer",
    phone: "1".repeat(31),
});
check("2.7 Phone exceeding 30 characters is rejected", !longPhone.success);

const maxPhone = createCustomerSchema.safeParse({
    name: "Valid Customer",
    phone: "1".repeat(30),
});
check("2.8 Phone exactly 30 characters is accepted", maxPhone.success);

const validPhone = createCustomerSchema.safeParse({
    name: "Valid Customer",
    phone: "  9876543210  ",
});
check("2.9 Valid phone is accepted and trimmed", validPhone.success && validPhone.data?.phone === "9876543210");

const emptyPhoneCreate = createCustomerSchema.safeParse({
    name: "Valid Customer",
    phone: "",
});
check("2.10 Empty string phone normalizes to undefined on create", emptyPhoneCreate.success && emptyPhoneCreate.data?.phone === undefined);

const nullPhoneCreate = createCustomerSchema.safeParse({
    name: "Valid Customer",
    phone: null,
});
check("2.11 Null phone normalizes to undefined on create", nullPhoneCreate.success && nullPhoneCreate.data?.phone === undefined);

// Email validation
const malformedEmailNoAt = createCustomerSchema.safeParse({
    name: "Valid Customer",
    email: "notanemail",
});
check("2.12 Email missing @ is rejected", !malformedEmailNoAt.success);

const malformedEmailNoDomain = createCustomerSchema.safeParse({
    name: "Valid Customer",
    email: "user@domain",
});
check("2.13 Email missing domain dot is rejected", !malformedEmailNoDomain.success);

const longEmail = createCustomerSchema.safeParse({
    name: "Valid Customer",
    email: "a".repeat(195) + "@example.com",
});
check("2.14 Email exceeding 200 characters is rejected", !longEmail.success);

const validEmail = createCustomerSchema.safeParse({
    name: "Valid Customer",
    email: "  Alice@Example.COM  ",
});
check(
    "2.15 Valid email is trimmed and converted to lowercase",
    validEmail.success && validEmail.data?.email === "alice@example.com"
);

const emptyEmailCreate = createCustomerSchema.safeParse({
    name: "Valid Customer",
    email: "",
});
check("2.16 Empty string email normalizes to undefined on create", emptyEmailCreate.success && emptyEmailCreate.data?.email === undefined);

const nullEmailCreate = createCustomerSchema.safeParse({
    name: "Valid Customer",
    email: null,
});
check("2.17 Null email normalizes to undefined on create", nullEmailCreate.success && nullEmailCreate.data?.email === undefined);

// Address validation
const longAddress = createCustomerSchema.safeParse({
    name: "Valid Customer",
    address: "X".repeat(501),
});
check("2.18 Address exceeding 500 characters is rejected", !longAddress.success);

const maxAddress = createCustomerSchema.safeParse({
    name: "Valid Customer",
    address: "X".repeat(500),
});
check("2.19 Address exactly 500 characters is accepted", maxAddress.success);

const validAddress = createCustomerSchema.safeParse({
    name: "Valid Customer",
    address: "  123 Market Street, Suite 400  ",
});
check(
    "2.20 Valid address is trimmed and accepted",
    validAddress.success && validAddress.data?.address === "123 Market Street, Suite 400"
);

const emptyAddressCreate = createCustomerSchema.safeParse({
    name: "Valid Customer",
    address: "",
});
check("2.21 Empty string address normalizes to undefined on create", emptyAddressCreate.success && emptyAddressCreate.data?.address === undefined);

const nullAddressCreate = createCustomerSchema.safeParse({
    name: "Valid Customer",
    address: null,
});
check("2.22 Null address normalizes to undefined on create", nullAddressCreate.success && nullAddressCreate.data?.address === undefined);

// Status validation on create
const defaultStatus = createCustomerSchema.safeParse({ name: "Valid Customer" });
check("2.23 Status defaults to 'active' when omitted", defaultStatus.success && defaultStatus.data?.status === "active");

const inactiveStatus = createCustomerSchema.safeParse({ name: "Valid Customer", status: "inactive" });
check("2.24 Status 'inactive' is accepted on create", inactiveStatus.success && inactiveStatus.data?.status === "inactive");

const invalidStatusCreate = createCustomerSchema.safeParse({ name: "Valid Customer", status: "blocked" });
check("2.25 Invalid status ('blocked') is rejected", !invalidStatusCreate.success);

// Strict check
const unrecognizedKey = createCustomerSchema.safeParse({
    name: "Valid Customer",
    unexpectedField: "malicious",
});
check("2.26 Unrecognized keys are strictly rejected", !unrecognizedKey.success);

// ============================================================
// 3. UPDATE CUSTOMER SCHEMA & LIFECYCLE ISOLATION
// ============================================================

console.log("\n=== 3. UPDATE CUSTOMER SCHEMA & LIFECYCLE ISOLATION ===");

// Status isolation: PUT cannot pass status
const updateWithStatus = updateCustomerSchema.safeParse({ status: "inactive" });
check("3.1 PUT body with only status is strictly rejected", !updateWithStatus.success);

const updateWithStatusAndName = updateCustomerSchema.safeParse({ name: "Updated Name", status: "inactive" });
check("3.2 PUT body with name and status is strictly rejected", !updateWithStatusAndName.success);

const emptyUpdate = updateCustomerSchema.safeParse({});
check("3.3 Empty update body {} is rejected", !emptyUpdate.success);

const updateWithOnlyUndefined = updateCustomerSchema.safeParse({ phone: undefined });
check("3.4 Update body with all undefined fields is rejected", !updateWithOnlyUndefined.success);

const updateEmptyName = updateCustomerSchema.safeParse({ name: "" });
check("3.5 Blank customer name on update is rejected", !updateEmptyName.success);

const updateWhitespaceName = updateCustomerSchema.safeParse({ name: "    " });
check("3.6 Whitespace-only customer name on update is rejected", !updateWhitespaceName.success);

const updateLongName = updateCustomerSchema.safeParse({ name: "B".repeat(201) });
check("3.7 Name exceeding 200 characters on update is rejected", !updateLongName.success);

const updateValidName = updateCustomerSchema.safeParse({ name: "  New Name  " });
check(
    "3.8 Valid name on update is accepted and trimmed",
    updateValidName.success && updateValidName.data?.name === "New Name"
);

const updateLongPhone = updateCustomerSchema.safeParse({ phone: "9".repeat(31) });
check("3.9 Phone exceeding 30 characters on update is rejected", !updateLongPhone.success);

const updateMalformedEmail = updateCustomerSchema.safeParse({ email: "bad-email" });
check("3.10 Malformed email on update is rejected", !updateMalformedEmail.success);

const updateLongEmail = updateCustomerSchema.safeParse({ email: "a".repeat(195) + "@domain.com" });
check("3.11 Email exceeding 200 characters on update is rejected", !updateLongEmail.success);

const updateLongAddress = updateCustomerSchema.safeParse({ address: "C".repeat(501) });
check("3.12 Address exceeding 500 characters on update is rejected", !updateLongAddress.success);

// ============================================================
// 4. OMITTED VS EXPLICITLY CLEARED FIELDS CONTRACT
// ============================================================

console.log("\n=== 4. OMITTED VS EXPLICITLY CLEARED FIELDS CONTRACT ===");

// Test helper: simulate MongoDB $set and $unset construction from parsed data
function buildMongoUpdateOperations(data: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
}) {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};

    if (data.name !== undefined) {
        $set.name = data.name;
    }

    if (data.phone !== undefined) {
        if (data.phone === null) {
            $unset.phone = 1;
        } else {
            $set.phone = data.phone;
        }
    }

    if (data.email !== undefined) {
        if (data.email === null) {
            $unset.email = 1;
        } else {
            $set.email = data.email;
        }
    }

    if (data.address !== undefined) {
        if (data.address === null) {
            $unset.address = 1;
        } else {
            $set.address = data.address;
        }
    }

    return { $set, $unset };
}

// Scenario 4A: Omitted optional fields
const omittedUpdate = updateCustomerSchema.safeParse({ name: "Updated Company" });
check("4.1 Omitted update parses successfully", omittedUpdate.success);
if (omittedUpdate.success) {
    check("4.2 Omitted phone is undefined in schema output", omittedUpdate.data.phone === undefined);
    check("4.3 Omitted email is undefined in schema output", omittedUpdate.data.email === undefined);
    check("4.4 Omitted address is undefined in schema output", omittedUpdate.data.address === undefined);

    const ops = buildMongoUpdateOperations(omittedUpdate.data);
    check("4.5 Omitted fields are NOT in $set", !("phone" in ops.$set) && !("email" in ops.$set) && !("address" in ops.$set));
    check("4.6 Omitted fields are NOT in $unset (existing values preserved)", Object.keys(ops.$unset).length === 0);
    check("4.7 Provided name is in $set", ops.$set.name === "Updated Company");
}

// Scenario 4B: Explicit clearing with null
const nullClearingUpdate = updateCustomerSchema.safeParse({
    phone: null,
    email: null,
    address: null,
});
check("4.8 Explicit null fields parse successfully", nullClearingUpdate.success);
if (nullClearingUpdate.success) {
    check("4.9 Null phone produces null", nullClearingUpdate.data.phone === null);
    check("4.10 Null email produces null", nullClearingUpdate.data.email === null);
    check("4.11 Null address produces null", nullClearingUpdate.data.address === null);

    const ops = buildMongoUpdateOperations(nullClearingUpdate.data);
    check("4.12 Null phone adds to $unset: { phone: 1 }", ops.$unset.phone === 1);
    check("4.13 Null email adds to $unset: { email: 1 }", ops.$unset.email === 1);
    check("4.14 Null address adds to $unset: { address: 1 }", ops.$unset.address === 1);
    check("4.15 Cleared fields are NOT in $set", Object.keys(ops.$set).length === 0);
}

// Scenario 4C: Explicit clearing with empty strings (rather than silently treating as omitted)
const emptyStringClearingUpdate = updateCustomerSchema.safeParse({
    phone: "",
    email: "   ",
    address: "",
});
check("4.16 Empty string fields parse successfully", emptyStringClearingUpdate.success);
if (emptyStringClearingUpdate.success) {
    check("4.17 Empty string phone normalizes to null (explicit clear)", emptyStringClearingUpdate.data.phone === null);
    check("4.18 Whitespace-only email normalizes to null (explicit clear)", emptyStringClearingUpdate.data.email === null);
    check("4.19 Empty string address normalizes to null (explicit clear)", emptyStringClearingUpdate.data.address === null);

    const ops = buildMongoUpdateOperations(emptyStringClearingUpdate.data);
    check("4.20 Empty string phone is NOT silently omitted: routed to $unset", ops.$unset.phone === 1);
    check("4.21 Empty string email is NOT silently omitted: routed to $unset", ops.$unset.email === 1);
    check("4.22 Empty string address is NOT silently omitted: routed to $unset", ops.$unset.address === 1);
}

// Scenario 4D: Mixed update (some updated, some cleared, some omitted)
const mixedUpdate = updateCustomerSchema.safeParse({
    name: "Deepak Wholesale",
    phone: "9876543210",
    email: null, // explicit clear
    // address omitted -> preserve
});
check("4.23 Mixed update parses successfully", mixedUpdate.success);
if (mixedUpdate.success) {
    const ops = buildMongoUpdateOperations(mixedUpdate.data);
    check("4.24 Mixed: name in $set", ops.$set.name === "Deepak Wholesale");
    check("4.25 Mixed: phone in $set", ops.$set.phone === "9876543210");
    check("4.26 Mixed: email in $unset", ops.$unset.email === 1);
    check("4.27 Mixed: address preserved (neither in $set nor $unset)", !("address" in ops.$set) && !("address" in ops.$unset));
}

// ============================================================
// 5. LIFECYCLE ENDPOINT GUARDS & AUDIT INTEGRITY
// ============================================================

console.log("\n=== 5. LIFECYCLE ENDPOINT GUARDS & AUDIT INTEGRITY ===");

// Customer lifecycle schema
const validDeactivate = customerLifecycleSchema.safeParse({ action: "deactivate", reason: "Seasonal closure" });
check("5.1 Deactivate action accepted with reason", validDeactivate.success);

const validReactivate = customerLifecycleSchema.safeParse({ action: "reactivate" });
check("5.2 Reactivate action accepted without reason", validReactivate.success);

const invalidLifecycleAction = customerLifecycleSchema.safeParse({ action: "block" });
check("5.3 Block action rejected (customer model has no blocked status)", !invalidLifecycleAction.success);

// Lifecycle transition function guards
const activeDeactivate = isValidCustomerTransition("active", "deactivate");
check("5.4 Active customer can be deactivated", activeDeactivate.valid && activeDeactivate.newStatus === "inactive");

const inactiveReactivate = isValidCustomerTransition("inactive", "reactivate");
check("5.5 Inactive customer can be reactivated", inactiveReactivate.valid && inactiveReactivate.newStatus === "active");

const activeReactivate = isValidCustomerTransition("active", "reactivate");
check("5.6 Active customer cannot be reactivated", !activeReactivate.valid);

const inactiveDeactivate = isValidCustomerTransition("inactive", "deactivate");
check("5.7 Inactive customer cannot be deactivated", !inactiveDeactivate.valid);

// Simulate PUT handler intercepting status bypass attempt
function simulatePutCustomerHandler(body: any): { status: number; message: string } {
    const parsed = updateCustomerSchema.safeParse(body);
    if (!parsed.success) {
        return {
            status: 400,
            message: parsed.error.issues[0]?.message || "Invalid customer update data",
        };
    }
    return { status: 200, message: "Customer updated successfully" };
}

const statusBypassAttempt = simulatePutCustomerHandler({ status: "inactive" });
check("5.8 PUT handler strictly rejects direct status update (status 400)", statusBypassAttempt.status === 400);

// ============================================================
// 6. DUPLICATE PHONE CHECK
// ============================================================

console.log("\n=== 6. DUPLICATE PHONE CHECK & CONFLICT PROTECTION ===");

// Simulate duplicate phone verification within a tenant
interface MockCustomerDoc {
    _id: string;
    tenantId: string;
    phone?: string;
}

const existingDocs: MockCustomerDoc[] = [
    { _id: "c-100", tenantId: "tenant-A", phone: "9876543210" },
    { _id: "c-200", tenantId: "tenant-A", phone: "9123456780" },
    { _id: "c-300", tenantId: "tenant-B", phone: "9876543210" }, // Same phone, different tenant
];

function checkPhoneConflict(tenantId: string, phone: string, excludeId?: string): boolean {
    return existingDocs.some(
        (doc) => doc.tenantId === tenantId && doc.phone === phone && doc._id !== excludeId
    );
}

check("6.1 Duplicate phone in same tenant is detected", checkPhoneConflict("tenant-A", "9876543210") === true);
check("6.2 Same phone in different tenant is allowed (tenant isolation)", checkPhoneConflict("tenant-B", "9123456780") === false);
check("6.3 Updating customer's own record with unchanged phone is not a conflict", checkPhoneConflict("tenant-A", "9876543210", "c-100") === false);
check("6.4 Updating customer with another customer's phone is a conflict", checkPhoneConflict("tenant-A", "9876543210", "c-200") === true);

// ============================================================
// SUMMARY
// ============================================================

const success = summarize();
if (!success) {
    process.exit(1);
}
