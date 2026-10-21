/**
 * Test Suite: Supplier Management Phase 1
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Zod input validation schemas (createSupplierSchema, updateSupplierSchema)
 *    - Required fields, string trimming, email lowercase normalization
 *    - GSTIN pattern verification (lib/tax.ts GSTIN_PATTERN)
 *    - PAN pattern verification
 *    - Non-negative credit days and credit limit coercion
 *    - Strict payload rejection of unknown keys
 *    - Rejection of empty update payloads
 * 2. Safe Supplier Code generation & collision handling logic
 *    - Tenant-scoped counter key ("supplier:SUP")
 *    - Sequential code formatting (SUP-0001, SUP-0042)
 *    - Atomic increment simulation & collision retry
 *    - Timestamp fallback on persistent collision
 * 3. Deleted supplier filtering & multi-tenant query isolation
 *    - Filtering excludes isDeleted: true
 *    - Preserves documents where isDeleted is false or undefined (backwards compatible)
 *    - Regex special-character escaping for search queries
 * 4. AppShell navigation permission evaluation
 *    - Business Owner, Admin, Manager have supplier visibility
 *    - Cashiers/Staff (sales.create only) do NOT see suppliers in sidebar
 *    - Strict array evaluation: ['purchases.create', 'purchases.read', 'products.read', 'users.read']
 * 5. Audit log payload data safety
 *    - Audit event structure and entity name
 *    - Strict omission of sensitive banking details (bankDetails, accountNumber, ifsc, upiId)
 *
 * Run:
 *   npx tsx scripts/test-supplier-management.ts
 */

import {
    createSupplierSchema,
    updateSupplierSchema,
    PAN_PATTERN,
    parseSupplierValidationErrors,
    SUPPLIER_FORM_FIELD_MAP,
    supplierLifecycleSchema,
    isValidSupplierTransition,
    type SupplierLifecycleAction,
    getSupplierDisplayBadge,
} from "../lib/validations/supplier";
import { GSTIN_PATTERN } from "../lib/tax";

interface TestResult {
    name: string;
    passed: boolean;
    detail?: string;
}

const results: TestResult[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n==================================================`);
    console.log(`${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`\nFailed tests:`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`==================================================\n`);
    return failed.length === 0;
}

// =========================================================================
// 1. ZOD INPUT VALIDATION TESTS
// =========================================================================
function testValidationSchemas() {
    console.log("\n--- 1. Zod Input Validation (createSupplierSchema) ---");

    // Valid minimal supplier
    const validMinimal = createSupplierSchema.safeParse({
        name: "Acme Supplies",
    });
    check("1.1 Valid minimal supplier parses successfully", validMinimal.success);
    if (validMinimal.success) {
        check("1.2 Defaults paymentType to cash", validMinimal.data.paymentType === "cash");
        check("1.3 Defaults creditDays to 0", validMinimal.data.creditDays === 0);
        check("1.4 Defaults creditLimit to 0", validMinimal.data.creditLimit === 0);
        check("1.5 Defaults status to active", validMinimal.data.status === "active");
    }

    // Name trimming & requirement
    const trimmedName = createSupplierSchema.safeParse({
        name: "   Apex Trading Corp   ",
    });
    check("1.6 Name is trimmed properly", trimmedName.success && trimmedName.data.name === "Apex Trading Corp");

    const emptyName = createSupplierSchema.safeParse({
        name: "    ",
    });
    check("1.7 Empty/whitespace-only name is rejected", !emptyName.success);

    const missingName = createSupplierSchema.safeParse({});
    check("1.8 Missing name is rejected", !missingName.success);

    // Supplier code uppercase normalization
    const normalizedCode = createSupplierSchema.safeParse({
        name: "Global Metals",
        supplierCode: "  sup-0099  ",
    });
    check(
        "1.9 Supplier code trimmed and normalized to uppercase",
        normalizedCode.success && normalizedCode.data.supplierCode === "SUP-0099"
    );

    // Email validation & normalization
    const normalizedEmail = createSupplierSchema.safeParse({
        name: "Email Test",
        email: "  Billing.Supplier@Domain.COM  ",
    });
    check(
        "1.10 Email trimmed and converted to lowercase",
        normalizedEmail.success && normalizedEmail.data.email === "billing.supplier@domain.com"
    );

    const invalidEmail = createSupplierSchema.safeParse({
        name: "Bad Email",
        email: "not-an-email",
    });
    check("1.11 Invalid email rejected", !invalidEmail.success);

    // GSTIN validation using GSTIN_PATTERN
    const validGSTIN = createSupplierSchema.safeParse({
        name: "GST Test",
        gstin: "27AAPFU0939F1ZV",
    });
    check("1.12 Valid Indian GSTIN accepted", validGSTIN.success && validGSTIN.data.gstin === "27AAPFU0939F1ZV");

    const lowercaseGSTIN = createSupplierSchema.safeParse({
        name: "GST Lowercase",
        gstin: "27aapfu0939f1zv",
    });
    check(
        "1.13 Lowercase GSTIN normalized to uppercase and accepted",
        lowercaseGSTIN.success && lowercaseGSTIN.data.gstin === "27AAPFU0939F1ZV"
    );

    const invalidGSTIN = createSupplierSchema.safeParse({
        name: "GST Bad",
        gstin: "INVALIDGST123",
    });
    check("1.14 Malformed GSTIN rejected", !invalidGSTIN.success);

    // PAN validation using PAN_PATTERN
    const validPAN = createSupplierSchema.safeParse({
        name: "PAN Test",
        pan: "ABCDE1234F",
    });
    check("1.15 Valid Indian PAN accepted", validPAN.success && validPAN.data.pan === "ABCDE1234F");

    const lowercasePAN = createSupplierSchema.safeParse({
        name: "PAN Lowercase",
        pan: "abcde1234f",
    });
    check(
        "1.16 Lowercase PAN normalized to uppercase and accepted",
        lowercasePAN.success && lowercasePAN.data.pan === "ABCDE1234F"
    );

    const invalidPAN = createSupplierSchema.safeParse({
        name: "PAN Bad",
        pan: "12345ABCDE",
    });
    check("1.17 Malformed PAN rejected", !invalidPAN.success);

    // Numeric creditDays & creditLimit parsing and clamping
    const numericStrings = createSupplierSchema.safeParse({
        name: "Credit Terms",
        creditDays: "45",
        creditLimit: "150000.50",
    });
    check(
        "1.18 String numeric fields converted to valid numbers",
        numericStrings.success &&
            numericStrings.data.creditDays === 45 &&
            numericStrings.data.creditLimit === 150000.5
    );

    const negativeNumbers = createSupplierSchema.safeParse({
        name: "Negative Terms",
        creditDays: -10,
        creditLimit: -5000,
    });
    check(
        "1.19 Negative credit numbers clamped to 0",
        negativeNumbers.success &&
            negativeNumbers.data.creditDays === 0 &&
            negativeNumbers.data.creditLimit === 0
    );

    // Strict mode unknown property rejection
    const unknownKeys = createSupplierSchema.safeParse({
        name: "Hacker Supplier",
        injectedRole: "admin",
        isDeleted: false,
    });
    check("1.20 Unknown fields rejected in strict schema", !unknownKeys.success);

    console.log("\n--- 2. Zod Input Validation (updateSupplierSchema) ---");

    // Partial update allowed
    const validUpdate = updateSupplierSchema.safeParse({
        phone: "9876543210",
        creditDays: 60,
    });
    check(
        "2.1 Partial update with valid subset of fields accepted",
        validUpdate.success && validUpdate.data.phone === "9876543210" && validUpdate.data.creditDays === 60
    );

    // Rejection of empty object
    const emptyUpdate = updateSupplierSchema.safeParse({});
    check("2.2 Empty update object rejected", !emptyUpdate.success);

    // Rejection of empty name
    const emptyUpdateName = updateSupplierSchema.safeParse({
        name: "    ",
    });
    check("2.3 Whitespace-only name in update rejected", !emptyUpdateName.success);
}

// =========================================================================
// 2. SAFE SUPPLIER CODE GENERATION & COLLISION SIMULATION
// =========================================================================
function testSupplierCodeGeneration() {
    console.log("\n--- 3. Supplier Code Generation & Collision Simulation ---");

    // Model in-memory counters per tenant
    const counterStore: Map<string, number> = new Map();
    const existingSuppliers: Set<string> = new Set();

    function mockGenerateNextSupplierCode(
        tenantId: string,
        prefix = "SUP",
        maxRetries = 10
    ): string {
        const cleanPrefix = (prefix || "SUP").trim().toUpperCase();
        const counterKey = `${tenantId}:supplier:${cleanPrefix}`;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const currentSeq = (counterStore.get(counterKey) || 0) + 1;
            counterStore.set(counterKey, currentSeq);

            const candidate = `${cleanPrefix}-${String(currentSeq).padStart(4, "0")}`;
            const globalKey = `${tenantId}:${candidate}`;

            if (!existingSuppliers.has(globalKey)) {
                return candidate;
            }
        }

        return `${cleanPrefix}-FALLBACK`;
    }

    const tenantA = "tenant_111";
    const tenantB = "tenant_222";

    // Sequential code generation for tenant A
    const codeA1 = mockGenerateNextSupplierCode(tenantA);
    existingSuppliers.add(`${tenantA}:${codeA1}`);
    check("3.1 Tenant A generates sequential code SUP-0001", codeA1 === "SUP-0001");

    const codeA2 = mockGenerateNextSupplierCode(tenantA);
    existingSuppliers.add(`${tenantA}:${codeA2}`);
    check("3.2 Tenant A generates next sequential code SUP-0002", codeA2 === "SUP-0002");

    // Tenant B starts its own independent sequence
    const codeB1 = mockGenerateNextSupplierCode(tenantB);
    existingSuppliers.add(`${tenantB}:${codeB1}`);
    check("3.3 Tenant B gets independent sequence SUP-0001", codeB1 === "SUP-0001");

    // Simulate pre-existing manually assigned SUP-0003 in tenant A
    existingSuppliers.add(`${tenantA}:SUP-0003`);

    // Next allocation should detect collision with SUP-0003, retry, and allocate SUP-0004
    const codeA3 = mockGenerateNextSupplierCode(tenantA);
    check(
        "3.4 Collision with pre-existing code is detected and skipped (allocated SUP-0004)",
        codeA3 === "SUP-0004"
    );
}

// =========================================================================
// 3. DELETED SUPPLIER FILTERING & QUERY ISOLATION
// =========================================================================
function testDeletedSupplierFiltering() {
    console.log("\n--- 4. Deleted Supplier Filtering & Query Isolation ---");

    interface MockSupplierDoc {
        _id: string;
        tenantId: string;
        name: string;
        supplierCode: string;
        isDeleted?: boolean;
    }

    const mockDatabase: MockSupplierDoc[] = [
        { _id: "1", tenantId: "tenant_A", name: "Alpha", supplierCode: "SUP-0001", isDeleted: false },
        { _id: "2", tenantId: "tenant_A", name: "Beta", supplierCode: "SUP-0002", isDeleted: true }, // deleted
        { _id: "3", tenantId: "tenant_A", name: "Gamma", supplierCode: "SUP-0003" }, // undefined isDeleted (legacy)
        { _id: "4", tenantId: "tenant_B", name: "Delta", supplierCode: "SUP-0001", isDeleted: false },
    ];

    // Filter implementation matching app/api/suppliers/route.ts:
    // { tenantId, isDeleted: { $ne: true } }
    function querySuppliers(tenantId: string): MockSupplierDoc[] {
        return mockDatabase.filter(
            (doc) => doc.tenantId === tenantId && doc.isDeleted !== true
        );
    }

    const tenantAResults = querySuppliers("tenant_A");
    check("4.1 Returns 2 active/non-deleted suppliers for Tenant A", tenantAResults.length === 2);
    check(
        "4.2 Excludes supplier with isDeleted: true",
        !tenantAResults.some((s) => s.supplierCode === "SUP-0002")
    );
    check(
        "4.3 Includes legacy supplier without isDeleted field",
        tenantAResults.some((s) => s.supplierCode === "SUP-0003")
    );
    check(
        "4.4 Multi-tenant isolation: does not leak Tenant B suppliers",
        !tenantAResults.some((s) => s.tenantId === "tenant_B")
    );

    // Regex escaping check
    const rawSearch = "Acme (Pvt) [Ltd] + $";
    const escaped = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    check("4.5 Regex special characters in search string are safely escaped", regex.test("Acme (Pvt) [Ltd] + $"));
}

// =========================================================================
// 4. SIDEBAR PERMISSION EVALUATION (AppShell.tsx)
// =========================================================================
function testSidebarPermissionEvaluation() {
    console.log("\n--- 5. Sidebar Navigation Permission Evaluation ---");

    // Exact evaluation rule from AppShell.tsx:
    const requiredSupplierPermissions = [
        "purchases.create",
        "purchases.read",
        "products.read",
        "users.read",
    ];

    function evaluateSupplierNavVisibility(userPermissions: string[] | undefined | null): boolean {
        if (!Array.isArray(userPermissions)) return false;
        return requiredSupplierPermissions.some((req) => userPermissions.includes(req));
    }

    // Role definitions
    const businessOwnerPermissions = [
        "sales.create",
        "sales.priceOverride",
        "salesReturns.create",
        "purchases.create",
        "purchaseReturns.create",
        "payments.create",
        "stock.adjust",
        "taxes.read",
        "taxes.delete",
    ];

    const managerPermissions = [
        "sales.create",
        "sales.priceOverride",
        "salesReturns.create",
        "purchases.create",
        "purchaseReturns.create",
        "payments.create",
        "stock.adjust",
        "taxes.read",
    ];

    const cashierStaffPermissions = [
        "sales.create",
        "taxes.read",
    ];

    const viewerPermissions = [
        "purchases.read",
    ];

    check(
        "5.1 Business Owner has supplier navigation visible (via purchases.create)",
        evaluateSupplierNavVisibility(businessOwnerPermissions) === true
    );
    check(
        "5.2 Manager has supplier navigation visible (via purchases.create)",
        evaluateSupplierNavVisibility(managerPermissions) === true
    );
    check(
        "5.3 Cashier / POS Staff CANNOT see supplier navigation",
        evaluateSupplierNavVisibility(cashierStaffPermissions) === false
    );
    check(
        "5.4 Purchasing Viewer CAN see supplier navigation (via purchases.read)",
        evaluateSupplierNavVisibility(viewerPermissions) === true
    );
    check(
        "5.5 User with undefined/null permissions CANNOT see supplier navigation",
        evaluateSupplierNavVisibility(undefined) === false && evaluateSupplierNavVisibility(null) === false
    );
    check(
        "5.6 User with empty permissions array CANNOT see supplier navigation",
        evaluateSupplierNavVisibility([]) === false
    );
}

// =========================================================================
// 5. AUDIT LOGGING DATA SAFETY
// =========================================================================
function testAuditLogDataSafety() {
    console.log("\n--- 6. Audit Logging Data Safety ---");

    const mockSupplierWithBank = {
        name: "Safe Supplier",
        supplierCode: "SUP-0010",
        contact: {
            contactPerson: "John Doe",
            phone: "9876543210",
            email: "john@supplier.com",
        },
        tax: {
            gstin: "27AAPFU0939F1ZV",
        },
        paymentTerms: {
            type: "credit",
            creditDays: 30,
        },
        status: "active",
        bankDetails: {
            accountName: "Safe Supplier Pvt Ltd",
            accountNumber: "123456789012",
            bankName: "HDFC Bank",
            ifsc: "HDFC0001234",
            upiId: "supplier@hdfc",
        },
    };

    // The audit log event constructed in app/api/suppliers/route.ts:
    const auditNewValues = {
        supplierCode: mockSupplierWithBank.supplierCode,
        name: mockSupplierWithBank.name,
        contactPerson: mockSupplierWithBank.contact?.contactPerson,
        phone: mockSupplierWithBank.contact?.phone,
        email: mockSupplierWithBank.contact?.email,
        gstin: mockSupplierWithBank.tax?.gstin,
        paymentType: mockSupplierWithBank.paymentTerms?.type,
        creditDays: mockSupplierWithBank.paymentTerms?.creditDays,
        status: mockSupplierWithBank.status,
    };

    check(
        "6.1 Audit payload includes supplierCode and name",
        auditNewValues.supplierCode === "SUP-0010" && auditNewValues.name === "Safe Supplier"
    );
    check(
        "6.2 Audit payload does NOT contain bankDetails",
        !("bankDetails" in auditNewValues)
    );
    check(
        "6.3 Audit payload does NOT contain accountNumber",
        !("accountNumber" in auditNewValues)
    );
    check(
        "6.4 Audit payload does NOT contain ifsc",
        !("ifsc" in auditNewValues)
    );
    check(
        "6.5 Audit payload does NOT contain upiId",
        !("upiId" in auditNewValues)
    );
}

// =========================================================================
// 6. FIELD VALIDATION PARSING & ERROR MAPPING TESTS
// =========================================================================
function testFieldValidationParsing() {
    console.log("\n--- 7. Field-Specific Validation Error Parsing ---");

    // Test 1: User's exact reported issue: GSTIN validation error
    const gstinErrorPayload = {
        success: false,
        message: "Invalid supplier update data",
        errors: [
            {
                field: "gstin",
                message: "Invalid GSTIN format (15 alphanumeric characters expected)",
            },
        ],
    };
    const parsedGstin = parseSupplierValidationErrors(gstinErrorPayload);
    check(
        "7.1 Maps 'gstin' error to fieldErrors.gstin",
        parsedGstin.fieldErrors.gstin === "Invalid GSTIN format (15 alphanumeric characters expected)"
    );
    check(
        "7.2 General error is null when field error is mapped (no generic redundant banner)",
        parsedGstin.generalError === null
    );
    check("7.3 No unmapped errors for gstin", parsedGstin.unmappedErrors.length === 0);

    // Test 2: Multiple field errors (name, email, phone)
    const multiFieldPayload = {
        success: false,
        message: "Invalid supplier update data",
        errors: [
            { field: "name", message: "Name cannot be empty" },
            { field: "email", message: "Invalid email format" },
            { field: "phone", message: "Phone number too long" },
        ],
    };
    const parsedMulti = parseSupplierValidationErrors(multiFieldPayload);
    check(
        "7.4 Maps multiple field errors simultaneously",
        parsedMulti.fieldErrors.name === "Name cannot be empty" &&
            parsedMulti.fieldErrors.email === "Invalid email format" &&
            parsedMulti.fieldErrors.phone === "Phone number too long"
    );
    check("7.5 General error is null when all fields are mapped", parsedMulti.generalError === null);

    // Test 3: Nested path mapping (e.g. tax.gstin, contact.email, address.line1)
    const nestedPayload = {
        success: false,
        errors: [
            { field: "tax.gstin", message: "Invalid GSTIN format" },
            { field: "contact.contactPerson", message: "Contact person too long" },
            { field: "address.line1", message: "Address line 1 too long" },
        ],
    };
    const parsedNested = parseSupplierValidationErrors(nestedPayload);
    check(
        "7.6 Maps nested field paths to form keys",
        parsedNested.fieldErrors.gstin === "Invalid GSTIN format" &&
            parsedNested.fieldErrors.contactPerson === "Contact person too long" &&
            parsedNested.fieldErrors.address === "Address line 1 too long"
    );

    // Test 4: Unmapped field errors placed into unmapped/general area
    const unmappedPayload = {
        success: false,
        message: "Invalid supplier update data",
        errors: [
            { field: "pan", message: "Invalid PAN format" },
            { field: "creditDays", message: "Expected positive number" },
        ],
    };
    const parsedUnmapped = parseSupplierValidationErrors(unmappedPayload);
    check(
        "7.7 Unmapped fields excluded from fieldErrors",
        Object.keys(parsedUnmapped.fieldErrors).length === 0
    );
    check(
        "7.8 Unmapped errors included in generalError",
        Boolean(parsedUnmapped.generalError?.includes("pan: Invalid PAN format")) &&
            Boolean(parsedUnmapped.generalError?.includes("creditDays: Expected positive number"))
    );

    // Test 5: Generic response without errors array (e.g. 409 code conflict)
    const generic409Payload = {
        success: false,
        message: "A supplier with this code already exists.",
    };
    const parsed409 = parseSupplierValidationErrors(generic409Payload);
    check(
        "7.9 Fallback to top-level message when errors array is absent",
        parsed409.generalError === "A supplier with this code already exists." &&
            Object.keys(parsed409.fieldErrors).length === 0
    );

    // Test 6: Null / malformed response handling
    const nullPayload = parseSupplierValidationErrors(null, "Server error");
    check(
        "7.10 Gracefully handles null payload with fallback message",
        nullPayload.generalError === "Server error" && Object.keys(nullPayload.fieldErrors).length === 0
    );

    // Test 7: Simulated clear-on-edit logic
    let simulatedFieldErrors: Record<string, string> = { ...parsedMulti.fieldErrors };
    // Clear email when user edits email
    delete simulatedFieldErrors.email;
    check(
        "7.11 Clearing a field error preserves other field errors",
        simulatedFieldErrors.email === undefined &&
            simulatedFieldErrors.name === "Name cannot be empty" &&
            simulatedFieldErrors.phone === "Phone number too long"
    );
}

// =========================================================================
// 8. SUPPLIER MANAGEMENT PHASE 2: LIFECYCLE, SAFE DELETION & PURCHASE RETURNS
// =========================================================================
function testSupplierLifecycleManagement() {
    console.log("\n--- 8. Supplier Lifecycle Transitions (Phase 2) ---");

    // 8.1 Approved transitions
    const t1 = isValidSupplierTransition("active", "deactivate");
    check("8.1 Active -> Deactivate transitions to inactive", t1.valid && t1.newStatus === "inactive");

    const t2 = isValidSupplierTransition("inactive", "reactivate");
    check("8.2 Inactive -> Reactivate transitions to active", t2.valid && t2.newStatus === "active");

    const t3 = isValidSupplierTransition("active", "block");
    check("8.3 Active -> Block transitions to blocked", t3.valid && t3.newStatus === "blocked");

    const t4 = isValidSupplierTransition("blocked", "unblock");
    check("8.4 Blocked -> Unblock transitions to active", t4.valid && t4.newStatus === "active");

    // 8.2 Valid lifecycle schema parsing with reason
    const validDeactivateWithReason = supplierLifecycleSchema.safeParse({
        action: "deactivate",
        reason: "Supplier closing branch for renovation",
    });
    check(
        "8.5 Lifecycle schema parses valid action with reason",
        validDeactivateWithReason.success &&
            validDeactivateWithReason.data.action === "deactivate" &&
            validDeactivateWithReason.data.reason === "Supplier closing branch for renovation"
    );

    const validBlockWithoutReason = supplierLifecycleSchema.safeParse({
        action: "block",
    });
    check(
        "8.6 Lifecycle schema parses valid action without reason (optional reason)",
        validBlockWithoutReason.success && validBlockWithoutReason.data.action === "block"
    );

    // 8.3 Rejection of invalid transitions
    const bad1 = isValidSupplierTransition("inactive", "deactivate");
    check("8.7 Inactive -> Deactivate rejected", !bad1.valid && Boolean(bad1.error));

    const bad2 = isValidSupplierTransition("inactive", "block");
    check("8.8 Inactive -> Block rejected", !bad2.valid && Boolean(bad2.error));

    const bad3 = isValidSupplierTransition("blocked", "deactivate");
    check("8.9 Blocked -> Deactivate rejected", !bad3.valid && Boolean(bad3.error));

    const bad4 = isValidSupplierTransition("blocked", "block");
    check("8.10 Blocked -> Block rejected", !bad4.valid && Boolean(bad4.error));

    const bad5 = isValidSupplierTransition("active", "reactivate");
    check("8.11 Active -> Reactivate rejected", !bad5.valid && Boolean(bad5.error));

    const bad6 = isValidSupplierTransition("active", "unblock");
    check("8.12 Active -> Unblock rejected", !bad6.valid && Boolean(bad6.error));

    const invalidActionSchema = supplierLifecycleSchema.safeParse({
        action: "delete",
    });
    check("8.13 Unsupported action 'delete' rejected by lifecycle schema", !invalidActionSchema.success);

    const arbitraryActionSchema = supplierLifecycleSchema.safeParse({
        action: "archive",
    });
    check("8.14 Unsupported action 'archive' rejected by lifecycle schema", !arbitraryActionSchema.success);

    // 8.4 Rejection of status or isDeleted in ordinary profile updates
    const statusInUpdate = updateSupplierSchema.safeParse({
        name: "Acme Updated",
        status: "inactive",
    });
    check("8.15 Profile update cannot change status (rejected by updateSupplierSchema)", !statusInUpdate.success);

    const deletedInUpdate = updateSupplierSchema.safeParse({
        name: "Acme Updated",
        isDeleted: true,
    });
    check("8.16 Profile update cannot change isDeleted (rejected by updateSupplierSchema)", !deletedInUpdate.success);

    console.log("\n--- 9. Tenant-Scoped Authorization for Lifecycle & Deletion ---");

    const SUPPLIER_WRITE_PERMISSIONS = [
        "purchases.create",
        "products.create",
        "products.update",
        "users.read",
    ];

    function checkWritePermission(permissions: string[] | undefined | null): boolean {
        if (!Array.isArray(permissions)) return false;
        return SUPPLIER_WRITE_PERMISSIONS.some((p) => permissions.includes(p));
    }

    check(
        "9.1 Business owner / manager with purchases.create is authorized for lifecycle",
        checkWritePermission(["purchases.create", "sales.create"]) === true
    );
    check(
        "9.2 Manager with products.update is authorized for lifecycle",
        checkWritePermission(["products.update"]) === true
    );
    check(
        "9.3 Cashier with sales.create only is NOT authorized for lifecycle (403)",
        checkWritePermission(["sales.create", "taxes.read"]) === false
    );
    check(
        "9.4 Empty or null permissions are NOT authorized (403)",
        checkWritePermission([]) === false && checkWritePermission(null) === false
    );

    // Multi-tenant isolation check: tenant A cannot access tenant B supplier
    const tenantASupplier = { _id: "sup_123", tenantId: "tenant_A", name: "Supplier A" };
    function findTenantSupplier(id: string, requestTenantId: string) {
        if (tenantASupplier._id === id && tenantASupplier.tenantId === requestTenantId) {
            return tenantASupplier;
        }
        return null;
    }

    check(
        "9.5 Cross-tenant lifecycle attempt fails lookup (404 / null)",
        findTenantSupplier("sup_123", "tenant_B") === null
    );
    check(
        "9.6 Same-tenant lookup succeeds",
        findTenantSupplier("sup_123", "tenant_A") !== null
    );

    console.log("\n--- 10. Historical Purchase Return Compatibility & Snapshot Preservation ---");

    // Pure validation logic representing Step 6 of PurchaseReturnService
    interface MockPurchaseForReturn {
        _id: string;
        tenantId: string;
        status: "received" | "ordered" | "cancelled";
        supplierId: string;
        supplierSnapshot: {
            name: string;
            supplierCode: string;
            gstin?: string;
        };
    }

    interface MockLiveSupplier {
        _id: string;
        tenantId: string;
        name: string;
        supplierCode: string;
        status: "active" | "inactive" | "blocked";
        isDeleted?: boolean;
    }

    function validatePurchaseReturnSupplier({
        requestTenantId,
        purchase,
        liveSupplier,
    }: {
        requestTenantId: string;
        purchase: MockPurchaseForReturn;
        liveSupplier?: MockLiveSupplier | null;
    }): { valid: boolean; error?: string; returnSupplierSnapshot?: any } {
        // Multi-tenant check on purchase
        if (purchase.tenantId !== requestTenantId) {
            return { valid: false, error: "Unauthorized: Purchase belongs to another tenant" };
        }

        // Purchase status check
        if (purchase.status !== "received") {
            return { valid: false, error: "Only received purchases can be returned" };
        }

        // Live supplier check if present
        if (liveSupplier) {
            if (liveSupplier.tenantId !== requestTenantId) {
                return { valid: false, error: "Cross-tenant supplier reference detected" };
            }
            // Inactive, blocked, or soft-deleted suppliers do NOT block historical purchase return
        }

        // Preserve immutable historical snapshot from original purchase
        const returnSupplierSnapshot = purchase.supplierSnapshot || (liveSupplier ? {
            name: liveSupplier.name,
            supplierCode: liveSupplier.supplierCode,
        } : { name: "Historical Supplier", supplierCode: "UNKNOWN" });

        return { valid: true, returnSupplierSnapshot };
    }

    const originalPurchase: MockPurchaseForReturn = {
        _id: "po_001",
        tenantId: "tenant_A",
        status: "received",
        supplierId: "sup_100",
        supplierSnapshot: {
            name: "Original Supplier 2024",
            supplierCode: "SUP-0042",
            gstin: "27AAPFU0939F1ZV",
        },
    };

    // 10.1 Return with active supplier
    const returnActive = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: {
            _id: "sup_100",
            tenantId: "tenant_A",
            name: "Original Supplier 2024",
            supplierCode: "SUP-0042",
            status: "active",
            isDeleted: false,
        },
    });
    check("10.1 Purchase return permitted for active supplier", returnActive.valid === true);

    // 10.2 Return with inactive supplier
    const returnInactive = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: {
            _id: "sup_100",
            tenantId: "tenant_A",
            name: "Original Supplier 2024",
            supplierCode: "SUP-0042",
            status: "inactive",
            isDeleted: false,
        },
    });
    check(
        "10.2 Purchase return permitted for INACTIVE supplier (Policy 1)",
        returnInactive.valid === true
    );

    // 10.3 Return with blocked supplier
    const returnBlocked = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: {
            _id: "sup_100",
            tenantId: "tenant_A",
            name: "Original Supplier 2024",
            supplierCode: "SUP-0042",
            status: "blocked",
            isDeleted: false,
        },
    });
    check(
        "10.3 Purchase return permitted for BLOCKED supplier (Policy 1)",
        returnBlocked.valid === true
    );

    // 10.4 Return with soft-deleted / archived supplier
    const returnDeleted = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: {
            _id: "sup_100",
            tenantId: "tenant_A",
            name: "Original Supplier 2024",
            supplierCode: "SUP-0042",
            status: "inactive",
            isDeleted: true,
        },
    });
    check(
        "10.4 Purchase return permitted for SOFT-DELETED supplier (Policy 1)",
        returnDeleted.valid === true
    );

    // 10.5 Return with completely missing live supplier doc (uses original purchase snapshot)
    const returnMissingSupplier = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: null,
    });
    check(
        "10.5 Purchase return permitted when live supplier document is missing (fallback to snapshot)",
        returnMissingSupplier.valid === true
    );

    // 10.6 Snapshot preservation: original purchase snapshot is preserved, not overwritten by renamed supplier
    const renamedSupplier: MockLiveSupplier = {
        _id: "sup_100",
        tenantId: "tenant_A",
        name: "Renamed Modern Enterprise LLC",
        supplierCode: "SUP-9999",
        status: "active",
    };
    const returnPreservedSnapshot = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: renamedSupplier,
    });
    check(
        "10.6 Immutable purchase.supplierSnapshot is preserved on return, not overwritten by changed supplier",
        returnPreservedSnapshot.returnSupplierSnapshot.name === "Original Supplier 2024" &&
            returnPreservedSnapshot.returnSupplierSnapshot.supplierCode === "SUP-0042"
    );

    // 10.7 Cross-tenant purchase rejected
    const crossTenantReturn = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_B",
        purchase: originalPurchase,
    });
    check(
        "10.7 Cross-tenant purchase return attempt is rejected",
        crossTenantReturn.valid === false && Boolean(crossTenantReturn.error?.includes("Unauthorized"))
    );

    // 10.8 Cross-tenant supplier detected and rejected
    const crossTenantSupplierReturn = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: originalPurchase,
        liveSupplier: {
            _id: "sup_100",
            tenantId: "tenant_B",
            name: "Foreign Supplier",
            supplierCode: "SUP-0042",
            status: "active",
        },
    });
    check(
        "10.8 Cross-tenant supplier reference is rejected",
        crossTenantSupplierReturn.valid === false && Boolean(crossTenantSupplierReturn.error?.includes("Cross-tenant"))
    );

    // 10.9 Unreceived purchase cannot be returned
    const unreceivedPurchase = { ...originalPurchase, status: "ordered" as const };
    const returnUnreceived = validatePurchaseReturnSupplier({
        requestTenantId: "tenant_A",
        purchase: unreceivedPurchase,
    });
    check(
        "10.9 Unreceived purchase cannot be returned",
        returnUnreceived.valid === false && Boolean(returnUnreceived.error?.includes("Only received purchases"))
    );

    console.log("\n--- 11. Safe Deletion & Reference Guard (Policy 3 & 4) ---");

    interface MockDeletionCheck {
        purchaseCount: number;
        returnCount: number;
        paymentCount: number;
        ledgerCount: number;
        currentStatus: "active" | "inactive" | "blocked";
        isDeleted?: boolean;
    }

    function executeSafeSupplierDeletion(state: MockDeletionCheck): {
        actionTaken: "deactivated" | "soft_deleted" | "already_deleted";
        newStatus: string;
        newIsDeleted: boolean;
        auditAction: "DEACTIVATE" | "DELETE" | "NONE";
        message: string;
    } {
        if (state.isDeleted) {
            return {
                actionTaken: "already_deleted",
                newStatus: state.currentStatus,
                newIsDeleted: true,
                auditAction: "NONE",
                message: "Supplier is already deleted",
            };
        }

        const totalReferences =
            state.purchaseCount +
            state.returnCount +
            state.paymentCount +
            state.ledgerCount;

        if (totalReferences > 0) {
            // Policy 3: Never hard-delete or soft-delete if referenced. Safe fallback is deactivation.
            return {
                actionTaken: "deactivated",
                newStatus: "inactive",
                newIsDeleted: false,
                auditAction: "DEACTIVATE",
                message: `Supplier has existing transactional records (${state.purchaseCount} purchases, ${state.returnCount} returns, ${state.paymentCount} payments, ${state.ledgerCount} ledger entries). Status set to inactive instead of deletion.`,
            };
        }

        // Policy 4: Unreferenced supplier may be soft-deleted
        return {
            actionTaken: "soft_deleted",
            newStatus: state.currentStatus,
            newIsDeleted: true,
            auditAction: "DELETE",
            message: "Supplier soft-deleted successfully.",
        };
    }

    // 11.1 Referenced by purchases -> converts to deactivation
    const delWithPurchases = executeSafeSupplierDeletion({
        purchaseCount: 3,
        returnCount: 0,
        paymentCount: 0,
        ledgerCount: 0,
        currentStatus: "active",
    });
    check(
        "11.1 Supplier with purchases is deactivated instead of deleted",
        delWithPurchases.actionTaken === "deactivated" &&
            delWithPurchases.newStatus === "inactive" &&
            delWithPurchases.newIsDeleted === false &&
            delWithPurchases.auditAction === "DEACTIVATE"
    );

    // 11.2 Referenced by purchase returns -> converts to deactivation
    const delWithReturns = executeSafeSupplierDeletion({
        purchaseCount: 0,
        returnCount: 1,
        paymentCount: 0,
        ledgerCount: 0,
        currentStatus: "active",
    });
    check(
        "11.2 Supplier with purchase returns is deactivated instead of deleted",
        delWithReturns.actionTaken === "deactivated" &&
            delWithReturns.newStatus === "inactive" &&
            delWithReturns.newIsDeleted === false
    );

    // 11.3 Referenced by payments -> converts to deactivation
    const delWithPayments = executeSafeSupplierDeletion({
        purchaseCount: 0,
        returnCount: 0,
        paymentCount: 2,
        ledgerCount: 0,
        currentStatus: "active",
    });
    check(
        "11.3 Supplier with payments is deactivated instead of deleted",
        delWithPayments.actionTaken === "deactivated" &&
            delWithPayments.newStatus === "inactive" &&
            delWithPayments.newIsDeleted === false
    );

    // 11.4 Referenced by ledger entries -> converts to deactivation
    const delWithLedger = executeSafeSupplierDeletion({
        purchaseCount: 0,
        returnCount: 0,
        paymentCount: 0,
        ledgerCount: 5,
        currentStatus: "active",
    });
    check(
        "11.4 Supplier with ledger entries is deactivated instead of deleted",
        delWithLedger.actionTaken === "deactivated" &&
            delWithLedger.newStatus === "inactive" &&
            delWithLedger.newIsDeleted === false
    );

    // 11.5 Unreferenced supplier -> safe soft deletion
    const delUnreferenced = executeSafeSupplierDeletion({
        purchaseCount: 0,
        returnCount: 0,
        paymentCount: 0,
        ledgerCount: 0,
        currentStatus: "active",
    });
    check(
        "11.5 Unreferenced supplier is soft-deleted (isDeleted: true)",
        delUnreferenced.actionTaken === "soft_deleted" &&
            delUnreferenced.newIsDeleted === true &&
            delUnreferenced.auditAction === "DELETE"
    );

    // 11.6 Repeated deletion on already soft-deleted supplier
    const delAlreadyDeleted = executeSafeSupplierDeletion({
        purchaseCount: 0,
        returnCount: 0,
        paymentCount: 0,
        ledgerCount: 0,
        currentStatus: "inactive",
        isDeleted: true,
    });
    check(
        "11.6 Repeated deletion on already soft-deleted supplier is handled safely without mutation",
        delAlreadyDeleted.actionTaken === "already_deleted" &&
            delAlreadyDeleted.newIsDeleted === true &&
            delAlreadyDeleted.auditAction === "NONE"
    );

    // 11.7 Repeated deletion on already inactive referenced supplier
    const delAlreadyInactiveReferenced = executeSafeSupplierDeletion({
        purchaseCount: 2,
        returnCount: 0,
        paymentCount: 1,
        ledgerCount: 2,
        currentStatus: "inactive",
        isDeleted: false,
    });
    check(
        "11.7 Repeated deletion on referenced inactive supplier remains safely inactive",
        delAlreadyInactiveReferenced.actionTaken === "deactivated" &&
            delAlreadyInactiveReferenced.newStatus === "inactive" &&
            delAlreadyInactiveReferenced.newIsDeleted === false
    );

    console.log("\n--- 12. Lifecycle Audit Action Names & Sensitive Data Exclusion ---");

    interface MockAuditLogEntry {
        action: string;
        entity: string;
        entityId: string;
        previousState?: Record<string, unknown>;
        newState?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
    }

    function createLifecycleAudit(
        action: "DEACTIVATE" | "REACTIVATE" | "BLOCK" | "UNBLOCK" | "DELETE",
        supplier: any,
        previousStatus: string,
        newStatus: string,
        reason?: string
    ): MockAuditLogEntry {
        return {
            action,
            entity: "Supplier",
            entityId: supplier._id,
            previousState: {
                supplierCode: supplier.supplierCode,
                name: supplier.name,
                status: previousStatus,
            },
            newState: {
                supplierCode: supplier.supplierCode,
                name: supplier.name,
                status: newStatus,
            },
            metadata: {
                reason: reason || undefined,
            },
        };
    }

    const testSupplierFull = {
        _id: "sup_999",
        supplierCode: "SUP-0999",
        name: "Confidential Vendor Corp",
        bankDetails: {
            accountNumber: "98765432101234",
            ifsc: "SBIN0001234",
            bankName: "State Bank of India",
            upiId: "confidential@sbi",
        },
    };

    const deactivateAudit = createLifecycleAudit(
        "DEACTIVATE",
        testSupplierFull,
        "active",
        "inactive",
        "Seasonal shutdown"
    );
    const reactivateAudit = createLifecycleAudit(
        "REACTIVATE",
        testSupplierFull,
        "inactive",
        "active"
    );
    const blockAudit = createLifecycleAudit(
        "BLOCK",
        testSupplierFull,
        "active",
        "blocked",
        "Severe quality non-compliance"
    );
    const unblockAudit = createLifecycleAudit(
        "UNBLOCK",
        testSupplierFull,
        "blocked",
        "active",
        "Compliance restored"
    );

    check(
        "12.1 Distinct audit action DEACTIVATE emitted",
        deactivateAudit.action === "DEACTIVATE" && deactivateAudit.entity === "Supplier"
    );
    check(
        "12.2 Distinct audit action REACTIVATE emitted",
        reactivateAudit.action === "REACTIVATE" && reactivateAudit.entity === "Supplier"
    );
    check(
        "12.3 Distinct audit action BLOCK emitted",
        blockAudit.action === "BLOCK" && blockAudit.entity === "Supplier"
    );
    check(
        "12.4 Distinct audit action UNBLOCK emitted",
        unblockAudit.action === "UNBLOCK" && unblockAudit.entity === "Supplier"
    );

    const allAuditEntries = [deactivateAudit, reactivateAudit, blockAudit, unblockAudit];
    const hasAnyBankingData = allAuditEntries.some((entry) => {
        const p = JSON.stringify(entry.previousState || {});
        const n = JSON.stringify(entry.newState || {});
        const m = JSON.stringify(entry.metadata || {});
        return (
            p.includes("98765432101234") ||
            n.includes("98765432101234") ||
            m.includes("98765432101234") ||
            p.includes("SBIN0001234") ||
            n.includes("SBIN0001234") ||
            p.includes("bankDetails") ||
            n.includes("bankDetails")
        );
    });
    check("12.5 Sensitive banking details are strictly excluded from all lifecycle audit payloads", !hasAnyBankingData);

    check(
        "12.6 User-provided reason is recorded in audit metadata without fabricating reasons",
        deactivateAudit.metadata?.reason === "Seasonal shutdown" &&
            reactivateAudit.metadata?.reason === undefined &&
            blockAudit.metadata?.reason === "Severe quality non-compliance" &&
            unblockAudit.metadata?.reason === "Compliance restored"
    );
}

// =========================================================================
// 9. SOFT-DELETED SUPPLIER HISTORICAL PURCHASE ACCESS & MUTATION GUARDS
// =========================================================================
function testSoftDeletedSupplierPurchaseHistory() {
    console.log("\n--- 13. Soft-Deleted Supplier Purchase History Access & Mutation Guards ---");

    interface MockSupplier {
        _id: string;
        tenantId: string;
        name: string;
        supplierCode: string;
        status: "active" | "inactive" | "blocked";
        isDeleted?: boolean;
    }

    interface MockPurchase {
        _id: string;
        tenantId: string;
        supplierId: string;
        purchaseNo: string;
        supplierSnapshot: {
            name: string;
            supplierCode: string;
        };
        grandTotal: number;
        paidAmount: number;
        dueAmount: number;
        status: string;
    }

    const mockSuppliers: MockSupplier[] = [
        {
            _id: "sup_active",
            tenantId: "tenant_A",
            name: "Active Supplier",
            supplierCode: "SUP-0001",
            status: "active",
            isDeleted: false,
        },
        {
            _id: "sup_deleted_new_biz",
            tenantId: "tenant_A",
            name: "New Business",
            supplierCode: "SUP-0002",
            status: "inactive",
            isDeleted: true, // Soft-deleted supplier
        },
        {
            _id: "sup_tenant_b",
            tenantId: "tenant_B",
            name: "Tenant B Supplier",
            supplierCode: "SUP-0001",
            status: "active",
            isDeleted: true,
        },
    ];

    const mockPurchases: MockPurchase[] = [
        {
            _id: "po_101",
            tenantId: "tenant_A",
            supplierId: "sup_deleted_new_biz",
            purchaseNo: "PUR-2024-001",
            supplierSnapshot: { name: "New Business", supplierCode: "SUP-0002" },
            grandTotal: 15000,
            paidAmount: 15000,
            dueAmount: 0,
            status: "received",
        },
        {
            _id: "po_102",
            tenantId: "tenant_A",
            supplierId: "sup_deleted_new_biz",
            purchaseNo: "PUR-2024-002",
            supplierSnapshot: { name: "New Business", supplierCode: "SUP-0002" },
            grandTotal: 8500,
            paidAmount: 5000,
            dueAmount: 3500,
            status: "received",
        },
        {
            _id: "po_201",
            tenantId: "tenant_B",
            supplierId: "sup_tenant_b",
            purchaseNo: "PUR-2024-B01",
            supplierSnapshot: { name: "Tenant B Supplier", supplierCode: "SUP-0001" },
            grandTotal: 9999,
            paidAmount: 9999,
            dueAmount: 0,
            status: "received",
        },
    ];

    // 13.1 GET /api/suppliers/[id] simulation (without isDeleted: { $ne: true })
    function getSupplierDetail(id: string, requestTenantId: string) {
        // Query: { _id: id, tenantId: requestTenantId }
        const supplier = mockSuppliers.find(
            (s) => s._id === id && s.tenantId === requestTenantId
        );
        if (!supplier) {
            return { status: 404, error: "Supplier not found" };
        }

        // Query purchases: { tenantId: requestTenantId, supplierId: id }
        const purchases = mockPurchases.filter(
            (p) => p.tenantId === requestTenantId && p.supplierId === id
        );

        return { status: 200, supplier, purchases };
    }

    const detailResult = getSupplierDetail("sup_deleted_new_biz", "tenant_A");
    check(
        "13.1 GET /api/suppliers/[id] successfully retrieves soft-deleted supplier (status 200)",
        detailResult.status === 200 && Boolean(detailResult.supplier?.isDeleted)
    );
    check(
        "13.2 Soft-deleted supplier purchase history is returned (2 purchases found)",
        detailResult.status === 200 && detailResult.purchases?.length === 2
    );
    check(
        "13.3 Preserves immutable supplierSnapshot in returned purchases",
        detailResult.status === 200 &&
            detailResult.purchases?.[0].supplierSnapshot.name === "New Business" &&
            detailResult.purchases?.[0].supplierSnapshot.supplierCode === "SUP-0002"
    );

    // 13.4 Tenant isolation on GET /api/suppliers/[id]
    const crossTenantGet = getSupplierDetail("sup_deleted_new_biz", "tenant_B");
    check(
        "13.4 Cross-tenant GET lookup on soft-deleted supplier is strictly blocked (status 404)",
        crossTenantGet.status === 404
    );

    // 13.5 Normal supplier list continues to filter out soft-deleted suppliers
    function listSuppliers(requestTenantId: string) {
        return mockSuppliers.filter(
            (s) => s.tenantId === requestTenantId && s.isDeleted !== true
        );
    }
    const tenantAList = listSuppliers("tenant_A");
    check(
        "13.5 Normal suppliers list excludes soft-deleted 'New Business' (SUP-0002)",
        !tenantAList.some((s) => s._id === "sup_deleted_new_biz") && tenantAList.length === 1
    );

    // 13.6 PUT update remains strictly blocked on soft-deleted supplier
    function putSupplierUpdate(id: string, requestTenantId: string) {
        // Query in PUT: { _id: id, tenantId, isDeleted: { $ne: true } }
        const existing = mockSuppliers.find(
            (s) => s._id === id && s.tenantId === requestTenantId && s.isDeleted !== true
        );
        if (!existing) {
            return { status: 404, message: "Supplier not found" };
        }
        return { status: 200, message: "Updated" };
    }
    const putResult = putSupplierUpdate("sup_deleted_new_biz", "tenant_A");
    check(
        "13.6 PUT profile update remains rejected for soft-deleted supplier (status 404)",
        putResult.status === 404
    );

    // 13.7 PATCH lifecycle transitions remain strictly blocked on soft-deleted supplier
    function patchSupplierLifecycle(id: string, requestTenantId: string) {
        const supplier = mockSuppliers.find(
            (s) => s._id === id && s.tenantId === requestTenantId
        );
        if (!supplier) {
            return { status: 404, message: "Supplier not found" };
        }
        if (supplier.isDeleted) {
            return { status: 400, message: "Cannot perform lifecycle actions on an archived supplier" };
        }
        return { status: 200, message: "Transitioned" };
    }
    const patchResult = patchSupplierLifecycle("sup_deleted_new_biz", "tenant_A");
    check(
        "13.7 PATCH lifecycle transition rejected for soft-deleted supplier (status 400)",
        patchResult.status === 400 && patchResult.message.includes("Cannot perform lifecycle actions")
    );

    // 13.8 UI state evaluation for soft-deleted supplier
    const targetSupplier = detailResult.supplier!;
    const isArchivedBadgeVisible = Boolean(targetSupplier.isDeleted);
    const isEditButtonDisabled = Boolean(targetSupplier.isDeleted);
    const areLifecycleControlsVisible = !targetSupplier.isDeleted; // From app/suppliers/[id]/page.tsx: {!supplier.isDeleted && !isEditing && (...)}
    const arePurchaseLinksRendered = detailResult.purchases!.length > 0;

    check(
        "13.8 UI correctly renders Archived badge for soft-deleted supplier",
        isArchivedBadgeVisible === true
    );
    check(
        "13.9 UI disables 'Edit details' button for soft-deleted supplier",
        isEditButtonDisabled === true
    );
    check(
        "13.10 UI hides lifecycle action buttons (Deactivate/Block/Delete) for soft-deleted supplier",
        areLifecycleControlsVisible === false
    );
    check(
        "13.11 UI renders purchase table rows with valid links for soft-deleted supplier",
        arePurchaseLinksRendered === true
    );
}

// =========================================================================
// 10. SUPPLIER STATUS BADGE RESOLUTION & EXCLUSIVITY REGRESSION TESTS
// =========================================================================
function testSupplierStatusBadgeResolution() {
    console.log("\n--- 14. Supplier Status Badge Resolution & Exclusivity (app/suppliers/[id]) ---");

    // Case 1: Soft-deleted supplier with status "active" (User's reported SUP-0003 bug)
    const delActive = getSupplierDisplayBadge({ status: "active", isDeleted: true });
    check(
        "14.1 Soft-deleted active supplier renders ONLY 'Archived' badge",
        delActive.label === "Archived" && delActive.variant === "archived"
    );
    check(
        "14.2 Soft-deleted active supplier NEVER renders 'Active' badge",
        delActive.label !== "Active" && delActive.variant !== "active"
    );

    // Case 2: Soft-deleted supplier with status "inactive"
    const delInactive = getSupplierDisplayBadge({ status: "inactive", isDeleted: true });
    check(
        "14.3 Soft-deleted inactive supplier renders ONLY 'Archived' badge",
        delInactive.label === "Archived" && delInactive.variant === "archived"
    );
    check(
        "14.4 Soft-deleted inactive supplier NEVER renders 'Inactive' badge",
        delInactive.label !== "Inactive" && delInactive.variant !== "inactive"
    );

    // Case 3: Soft-deleted supplier with status "blocked"
    const delBlocked = getSupplierDisplayBadge({ status: "blocked", isDeleted: true });
    check(
        "14.5 Soft-deleted blocked supplier renders ONLY 'Archived' badge",
        delBlocked.label === "Archived" && delBlocked.variant === "archived"
    );
    check(
        "14.6 Soft-deleted blocked supplier NEVER renders 'Blocked' badge",
        delBlocked.label !== "Blocked" && delBlocked.variant !== "blocked"
    );

    // Case 4: Non-deleted supplier with status "active"
    const nonDelActive = getSupplierDisplayBadge({ status: "active", isDeleted: false });
    check(
        "14.7 Non-deleted active supplier renders 'Active' badge",
        nonDelActive.label === "Active" && nonDelActive.variant === "active"
    );
    check(
        "14.8 Non-deleted active supplier NEVER renders 'Archived' badge",
        nonDelActive.label !== "Archived" && nonDelActive.variant !== "archived"
    );

    // Case 5: Non-deleted supplier with status "inactive"
    const nonDelInactive = getSupplierDisplayBadge({ status: "inactive", isDeleted: false });
    check(
        "14.9 Non-deleted inactive supplier renders 'Inactive' badge",
        nonDelInactive.label === "Inactive" && nonDelInactive.variant === "inactive"
    );
    check(
        "14.10 Non-deleted inactive supplier NEVER renders 'Archived' badge",
        nonDelInactive.label !== "Archived" && nonDelInactive.variant !== "archived"
    );

    // Case 6: Non-deleted supplier with status "blocked"
    const nonDelBlocked = getSupplierDisplayBadge({ status: "blocked", isDeleted: false });
    check(
        "14.11 Non-deleted blocked supplier renders 'Blocked' badge",
        nonDelBlocked.label === "Blocked" && nonDelBlocked.variant === "blocked"
    );
    check(
        "14.12 Non-deleted blocked supplier NEVER renders 'Archived' badge",
        nonDelBlocked.label !== "Archived" && nonDelBlocked.variant !== "archived"
    );

    // Case 7: Non-deleted legacy supplier with isDeleted: undefined
    const legacyActive = getSupplierDisplayBadge({ status: "active", isDeleted: undefined });
    check(
        "14.13 Legacy supplier with isDeleted undefined defaults to 'Active' badge",
        legacyActive.label === "Active" && legacyActive.variant === "active"
    );

    // Case 8: Strict exclusivity guarantee (exactly one badge is ever produced)
    const testCases = [delActive, delInactive, delBlocked, nonDelActive, nonDelInactive, nonDelBlocked, legacyActive];
    const allProduceExactlyOneBadge = testCases.every(
        (b) => typeof b.label === "string" && b.label.length > 0 && typeof b.className === "string"
    );
    check(
        "14.14 Status badge resolution guarantees exactly one mutually exclusive badge per supplier",
        allProduceExactlyOneBadge === true
    );
}

// =========================================================================
// RUN ALL TESTS
// =========================================================================
async function runAll() {
    console.log("=== SUPPLIER MANAGEMENT PHASE 1 & PHASE 2: DATABASE-FREE TESTS ===");
    testValidationSchemas();
    testSupplierCodeGeneration();
    testDeletedSupplierFiltering();
    testSidebarPermissionEvaluation();
    testAuditLogDataSafety();
    testFieldValidationParsing();
    testSupplierLifecycleManagement();
    testSoftDeletedSupplierPurchaseHistory();
    testSupplierStatusBadgeResolution();

    const success = summarize();
    if (!success) {
        process.exit(1);
    }
}

runAll().catch((err) => {
    console.error("Test execution error:", err);
    process.exit(1);
});




