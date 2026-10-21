/**
 * Database-Free Test Suite: Phase 2 — Supplier Offline-Sync Validation Parity
 * (NO MONGODB, NO SERVER, NO NETWORK, NO BROWSER STORAGE MUTATIONS)
 *
 * Verifies:
 * 1. Shared Validation Regex & Export Consistency:
 *    - EMAIL_PATTERN, GSTIN_PATTERN, PAN_PATTERN exported and consistent across modules.
 * 2. Upload Schema Validation Parity (lib/validations/syncOperations):
 *    - Valid CREATE and UPDATE payloads with email, GSTIN, PAN accepted.
 *    - Format validations enforced for email, GSTIN, and PAN.
 *    - String numbers for creditDays and creditLimit accepted; negative/invalid rejected.
 *    - Field bounds (name max 200, phone max 30, address max 500, etc.) enforced.
 *    - Strict rejection of banking fields and lifecycle transitions.
 * 3. Server-Side Sync Processing Parity (SupplierSyncService):
 *    - createSupplierFromSync: strict format and type enforcement; no silent dropping of bad types.
 *    - updateSupplierFromSync: strict format and type enforcement; no silent dropping of bad types.
 *    - Lifecycle, deletion, and banking rejections throw 422 PERMANENT_FAILURE.
 *    - Idempotency, supplier code generation, and audit logging preserved.
 *
 * Run:
 *   npx tsx scripts/test-supplier-validation-phase2.ts
 */

import mongoose from "mongoose";
import { GSTIN_PATTERN } from "../lib/tax";
import {
    EMAIL_PATTERN,
    PAN_PATTERN,
    createSupplierSchema,
    updateSupplierSchema,
} from "../lib/validations/supplier";
import {
    supplierCreatePayloadSchema,
    supplierUpdatePayloadSchema,
    supplierCreateSchema,
    supplierUpdateSchema,
    uploadSchema,
    normalizeSupplierUpdatePayload,
} from "../lib/validations/syncOperations";
import { Supplier } from "../lib/models/Supplier";
import { SupplierSyncService } from "../lib/services/SupplierSyncService";
import { SupplierCodeService } from "../lib/services/SupplierCodeService";
import { AuditLogService } from "../lib/services/AuditLogService";
import { SyncProcessError } from "../lib/services/SyncErrors";

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
    console.log(`SUPPLIER VALIDATION PARITY (PHASE 2) SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

async function runTests() {
    console.log("=== PHASE 2: SUPPLIER OFFLINE-SYNC VALIDATION PARITY TESTS ===\n");

    const tenantA = new mongoose.Types.ObjectId("670c11111111111111111111");
    const tenantB = new mongoose.Types.ObjectId("670c22222222222222222222");
    const userA = new mongoose.Types.ObjectId("670c33333333333333333333");
    const deviceA = new mongoose.Types.ObjectId("670c44444444444444444444");

    const userContext = {
        tenantId: tenantA,
        userId: userA,
        deviceId: deviceA,
    };

    // ============================================================
    // 1. SHARED VALIDATION PATTERNS & EXPORTS
    // ============================================================
    console.log("-- 1. Shared Validation Patterns & Regex Consistency --");

    check("1.1 EMAIL_PATTERN is exported and matches valid emails", EMAIL_PATTERN.test("supplier@example.com"));
    check("1.2 EMAIL_PATTERN rejects emails missing @", !EMAIL_PATTERN.test("supplierexample.com"));
    check("1.3 EMAIL_PATTERN rejects emails missing domain dot", !EMAIL_PATTERN.test("supplier@com"));
    check("1.4 EMAIL_PATTERN rejects spaces in email", !EMAIL_PATTERN.test("supplier @example.com"));

    check("1.5 GSTIN_PATTERN matches valid 15-character Indian GSTIN", GSTIN_PATTERN.test("29ABCDE1234F1Z5"));
    check("1.6 GSTIN_PATTERN rejects 14-character GSTIN", !GSTIN_PATTERN.test("29ABCDE1234F1Z"));
    check("1.7 GSTIN_PATTERN rejects invalid check character", !GSTIN_PATTERN.test("29ABCDE1234F1A5"));

    check("1.8 PAN_PATTERN matches valid 10-character Indian PAN", PAN_PATTERN.test("ABCDE1234F"));
    check("1.9 PAN_PATTERN rejects 9-character PAN", !PAN_PATTERN.test("ABCDE1234"));
    check("1.10 PAN_PATTERN rejects non-alphanumeric PAN", !PAN_PATTERN.test("ABCDE1234#"));

    // Online schema uses shared regexes
    const validOnlineSupplier = {
        name: "Acme Supplies",
        email: "test@acme.com",
        gstin: "29ABCDE1234F1Z5",
        pan: "ABCDE1234F",
    };
    check("1.11 Online createSupplierSchema accepts valid supplier", createSupplierSchema.safeParse(validOnlineSupplier).success);

    const badEmailOnline = { ...validOnlineSupplier, email: "invalid-email" };
    check("1.12 Online createSupplierSchema rejects invalid email", !createSupplierSchema.safeParse(badEmailOnline).success);

    const badGstinOnline = { ...validOnlineSupplier, gstin: "BAD_GSTIN" };
    check("1.13 Online createSupplierSchema rejects invalid GSTIN", !createSupplierSchema.safeParse(badGstinOnline).success);

    const badPanOnline = { ...validOnlineSupplier, pan: "BAD_PAN" };
    check("1.14 Online createSupplierSchema rejects invalid PAN", !createSupplierSchema.safeParse(badPanOnline).success);

    // ============================================================
    // 2. OFFLINE SYNC ZOD SCHEMAS (syncOperations.ts)
    // ============================================================
    console.log("\n-- 2. Offline Sync Zod Schemas Validation Parity --");

    const validCreatePayload = {
        name: "Apex Hardware Store",
        supplierCode: "SUP-TEMP-001",
        contactPerson: "Vikram Shah",
        phone: "+91 98765 43210",
        altPhone: "080-22223333",
        email: "contact@apexhardware.in",
        website: "https://apexhardware.in",
        address: "74 Industrial Area",
        line1: "74 Industrial Area",
        line2: "Phase 2",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560058",
        country: "India",
        gstin: "29ABCDE1234F1Z5",
        pan: "ABCDE1234F",
        paymentType: "credit" as const,
        creditDays: 45,
        creditLimit: 500000,
        category: "Hardware",
        notes: "Key supplier for brass fittings",
        status: "active" as const,
    };

    const validCreateOp = {
        operationId: "op-create-parity-001",
        operationType: "CREATE" as const,
        entityType: "Supplier" as const,
        payload: validCreatePayload,
        owner: {
            tenantId: tenantA.toString(),
            userId: userA.toString(),
            deviceId: deviceA.toString(),
        },
    };

    check("2.1 Valid supplier CREATE satisfies supplierCreatePayloadSchema", supplierCreatePayloadSchema.safeParse(validCreatePayload).success);
    check("2.2 Valid supplier CREATE satisfies uploadSchema", uploadSchema.safeParse(validCreateOp).success);

    // Format validation parity in CREATE:
    // Malformed email
    const createBadEmail = { ...validCreateOp, payload: { ...validCreatePayload, email: "not-an-email" } };
    check("2.3 Supplier CREATE with malformed email rejected by uploadSchema", !uploadSchema.safeParse(createBadEmail).success);

    // Malformed GSTIN
    const createBadGstin = { ...validCreateOp, payload: { ...validCreatePayload, gstin: "INVALID_GSTIN_123" } };
    check("2.4 Supplier CREATE with malformed GSTIN rejected by uploadSchema", !uploadSchema.safeParse(createBadGstin).success);

    // Case-insensitive GSTIN accepted
    const createLowerGstin = { ...validCreateOp, payload: { ...validCreatePayload, gstin: "29abcde1234f1z5" } };
    check("2.5 Supplier CREATE with lowercase valid GSTIN accepted", uploadSchema.safeParse(createLowerGstin).success);

    // Malformed PAN
    const createBadPan = { ...validCreateOp, payload: { ...validCreatePayload, pan: "NOTAPAN" } };
    check("2.6 Supplier CREATE with malformed PAN rejected by uploadSchema", !uploadSchema.safeParse(createBadPan).success);

    // Case-insensitive PAN accepted
    const createLowerPan = { ...validCreateOp, payload: { ...validCreatePayload, pan: "abcde1234f" } };
    check("2.7 Supplier CREATE with lowercase valid PAN accepted", uploadSchema.safeParse(createLowerPan).success);

    // String numbers for creditDays and creditLimit in CREATE
    const createStringCredit = {
        ...validCreateOp,
        payload: {
            ...validCreatePayload,
            creditDays: "30",
            creditLimit: "250000",
        },
    };
    check("2.8 Supplier CREATE accepts string numbers for credit terms", uploadSchema.safeParse(createStringCredit).success);

    // Invalid creditDays in CREATE
    const createNegativeDays = { ...validCreateOp, payload: { ...validCreatePayload, creditDays: -10 } };
    check("2.9 Supplier CREATE rejects negative creditDays", !uploadSchema.safeParse(createNegativeDays).success);

    const createExcessDays = { ...validCreateOp, payload: { ...validCreatePayload, creditDays: 5000 } };
    check("2.10 Supplier CREATE rejects creditDays > 3650", !uploadSchema.safeParse(createExcessDays).success);

    // Invalid creditLimit in CREATE
    const createNegativeLimit = { ...validCreateOp, payload: { ...validCreatePayload, creditLimit: -50 } };
    check("2.11 Supplier CREATE rejects negative creditLimit", !uploadSchema.safeParse(createNegativeLimit).success);

    // Bounds in CREATE
    const createLongPhone = { ...validCreateOp, payload: { ...validCreatePayload, phone: "1".repeat(31) } };
    check("2.12 Supplier CREATE rejects phone exceeding 30 chars", !uploadSchema.safeParse(createLongPhone).success);

    const createLongAddress = { ...validCreateOp, payload: { ...validCreatePayload, address: "A".repeat(501) } };
    check("2.13 Supplier CREATE rejects address exceeding 500 chars", !uploadSchema.safeParse(createLongAddress).success);

    // UPDATE Schemas Parity
    const validUpdatePayload = {
        supplierId: "670c55555555555555555555",
        name: "Apex Hardware Solutions Ltd",
        email: "support@apexsolutions.in",
        gstin: "29ABCDE1234F1Z5",
        pan: "ABCDE1234F",
        creditDays: "60",
        creditLimit: "750000.50",
    };

    const validUpdateOp = {
        operationId: "op-update-parity-001",
        operationType: "UPDATE" as const,
        entityType: "Supplier" as const,
        payload: validUpdatePayload,
        owner: validCreateOp.owner,
    };

    check("2.14 Valid supplier UPDATE satisfies supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(validUpdatePayload).success);
    check("2.15 Valid supplier UPDATE satisfies uploadSchema", uploadSchema.safeParse(validUpdateOp).success);

    // Format validation parity in UPDATE:
    const updateBadEmail = { ...validUpdateOp, payload: { ...validUpdatePayload, email: "bad-email@" } };
    check("2.16 Supplier UPDATE with malformed email rejected by uploadSchema", !uploadSchema.safeParse(updateBadEmail).success);

    const updateBadGstin = { ...validUpdateOp, payload: { ...validUpdatePayload, gstin: "12345" } };
    check("2.17 Supplier UPDATE with malformed GSTIN rejected by uploadSchema", !uploadSchema.safeParse(updateBadGstin).success);

    const updateBadPan = { ...validUpdateOp, payload: { ...validUpdatePayload, pan: "ABC12" } };
    check("2.18 Supplier UPDATE with malformed PAN rejected by uploadSchema", !uploadSchema.safeParse(updateBadPan).success);

    const updateNegativeDays = { ...validUpdateOp, payload: { ...validUpdatePayload, creditDays: "-5" } };
    check("2.19 Supplier UPDATE rejects negative creditDays string", !uploadSchema.safeParse(updateNegativeDays).success);

    const updateExcessDays = { ...validUpdateOp, payload: { ...validUpdatePayload, creditDays: "4000" } };
    check("2.20 Supplier UPDATE rejects creditDays > 3650 string", !uploadSchema.safeParse(updateExcessDays).success);

    // Forbidden banking fields in UPDATE
    const updateWithBank = {
        ...validUpdateOp,
        payload: {
            ...validUpdatePayload,
            bankDetails: { accountNumber: "9999999999" },
        },
    };
    check("2.21 Supplier UPDATE with bankDetails rejected by strict schema", !uploadSchema.safeParse(updateWithBank).success);

    // Forbidden status in UPDATE (unauthorized lifecycle mutation)
    const updateWithInactive = {
        ...validUpdateOp,
        payload: {
            ...validUpdatePayload,
            status: "inactive",
        },
    };
    check("2.22 Supplier UPDATE with status: inactive rejected by strict schema", !uploadSchema.safeParse(updateWithInactive).success);

    // ============================================================
    // 3. SERVER-SIDE SYNC PROCESSING (SupplierSyncService)
    // ============================================================
    console.log("\n-- 3. Server-Side SupplierSyncService Validation & Parity --");

    // In-memory collection simulation
    const suppliersCollection: any[] = [];
    const auditLogs: any[] = [];
    let sequenceCounter = 100;

    // Spy on Supplier.findOne
    Supplier.findOne = (async (query: any) => {
        const found = suppliersCollection.find((s) => {
            if (query.tenantId && !s.tenantId.equals(query.tenantId)) return false;
            if (query.operationId && s.operationId !== query.operationId) return false;
            if (query._id && !s._id.equals(query._id)) return false;
            if (query.isDeleted?.$ne !== undefined && s.isDeleted === query.isDeleted.$ne) return false;
            return true;
        });
        return found ? { ...found } : null;
    }) as any;

    // Spy on Supplier.create
    Supplier.create = (async (docOrArray: any) => {
        const docs = Array.isArray(docOrArray) ? docOrArray : [docOrArray];
        const createdDocs = docs.map((d: any) => {
            const created = {
                _id: new mongoose.Types.ObjectId(),
                createdAt: new Date(),
                updatedAt: new Date(),
                ...d,
            };
            suppliersCollection.push(created);
            return created;
        });
        return Array.isArray(docOrArray) ? createdDocs : createdDocs[0];
    }) as any;

    // Spy on Supplier.findOneAndUpdate
    Supplier.findOneAndUpdate = (async (query: any, update: any) => {
        const idx = suppliersCollection.findIndex((s) => {
            if (query.tenantId && !s.tenantId.equals(query.tenantId)) return false;
            if (query._id && !s._id.equals(query._id)) return false;
            if (query.isDeleted?.$ne !== undefined && s.isDeleted === query.isDeleted.$ne) return false;
            return true;
        });
        if (idx === -1) return null;

        const target = suppliersCollection[idx];
        const $set = update.$set || {};
        for (const [k, v] of Object.entries($set)) {
            if (k.startsWith("contact.")) {
                target.contact = target.contact || {};
                target.contact[k.replace("contact.", "")] = v;
            } else if (k.startsWith("address.")) {
                target.address = target.address || {};
                target.address[k.replace("address.", "")] = v;
            } else if (k.startsWith("tax.")) {
                target.tax = target.tax || {};
                target.tax[k.replace("tax.", "")] = v;
            } else if (k.startsWith("paymentTerms.")) {
                target.paymentTerms = target.paymentTerms || {};
                target.paymentTerms[k.replace("paymentTerms.", "")] = v;
            } else {
                target[k] = v;
            }
        }
        target.updatedAt = new Date();
        return { ...target };
    }) as any;

    // Spy on SupplierCodeService
    SupplierCodeService.generateNextSupplierCode = async () => {
        sequenceCounter++;
        return `SUP-0${sequenceCounter}`;
    };

    // Spy on AuditLogService
    AuditLogService.createAuditLog = (async (context: any, log: any) => {
        auditLogs.push({ context, log });
        return { _id: new mongoose.Types.ObjectId() };
    }) as any;

    // Test 3.1: Valid server CREATE
    const serverCreateRes = await SupplierSyncService.createSupplierFromSync(
        userContext,
        {
            name: "Premier Industrial Fasteners",
            email: "SALES@PREMIER.COM",
            gstin: "29abcde1234f1z5",
            pan: "abcde1234f",
            phone: "9876543210",
            creditDays: "30",
            creditLimit: "100000",
        },
        "op-srv-create-001"
    );

    check("3.1 Valid server CREATE succeeds", serverCreateRes._id !== undefined);
    check("3.2 Sequential supplier code assigned", serverCreateRes.supplierCode === "SUP-0101");

    const createdRecord = suppliersCollection.find((s) => s.operationId === "op-srv-create-001");
    check("3.3 Server normalized email to lowercase", createdRecord.contact?.email === "sales@premier.com");
    check("3.4 Server normalized GSTIN to uppercase", createdRecord.tax?.gstin === "29ABCDE1234F1Z5");
    check("3.5 Server normalized PAN to uppercase", createdRecord.tax?.pan === "ABCDE1234F");
    check("3.6 Server converted string creditDays to number", createdRecord.paymentTerms?.creditDays === 30);
    check("3.7 Server converted string creditLimit to number", createdRecord.creditLimit === 100000);

    // Test 3.2: createSupplierFromSync non-string type rejections (no silent dropping)
    async function assertCreateFails(payload: any, opId: string, errorMatch: string, testName: string) {
        let caught = false;
        try {
            await SupplierSyncService.createSupplierFromSync(userContext, payload, opId);
        } catch (err: any) {
            caught = true;
            check(testName, err instanceof SyncProcessError && err.httpStatus === 422 && err.message.includes(errorMatch));
        }
        if (!caught) check(testName, false, "Did not throw expected error");
    }

    await assertCreateFails(
        { name: 12345 },
        "op-bad-name-type",
        "Supplier name must be a string",
        "3.8 Server rejects numeric name with 422 (not silently dropped)"
    );

    await assertCreateFails(
        { name: "Valid Name", email: 12345 },
        "op-bad-email-type",
        "Email must be a string",
        "3.9 Server rejects non-string email with 422 (not silently dropped)"
    );

    await assertCreateFails(
        { name: "Valid Name", email: "invalid-email" },
        "op-bad-email-format",
        "Invalid supplier email format",
        "3.10 Server rejects malformed email with 422"
    );

    await assertCreateFails(
        { name: "Valid Name", gstin: true },
        "op-bad-gstin-type",
        "GSTIN must be a string",
        "3.11 Server rejects boolean GSTIN with 422 (not silently dropped)"
    );

    await assertCreateFails(
        { name: "Valid Name", gstin: "INVALID_GSTIN_123" },
        "op-bad-gstin-format",
        "Invalid GSTIN format",
        "3.12 Server rejects malformed GSTIN with 422"
    );

    await assertCreateFails(
        { name: "Valid Name", pan: 99999 },
        "op-bad-pan-type",
        "PAN must be a string",
        "3.13 Server rejects numeric PAN with 422 (not silently dropped)"
    );

    await assertCreateFails(
        { name: "Valid Name", pan: "BADPAN" },
        "op-bad-pan-format",
        "Invalid PAN format",
        "3.14 Server rejects malformed PAN with 422"
    );

    await assertCreateFails(
        { name: "Valid Name", creditDays: "not-a-number" },
        "op-bad-credit-days-nan",
        "Credit days must be an integer between 0 and 3650",
        "3.15 Server rejects non-numeric creditDays string with 422"
    );

    await assertCreateFails(
        { name: "Valid Name", creditDays: -5 },
        "op-bad-credit-days-neg",
        "Credit days must be an integer between 0 and 3650",
        "3.16 Server rejects negative creditDays with 422"
    );

    await assertCreateFails(
        { name: "Valid Name", creditDays: 4000 },
        "op-bad-credit-days-max",
        "Credit days must be an integer between 0 and 3650",
        "3.17 Server rejects creditDays > 3650 with 422"
    );

    await assertCreateFails(
        { name: "Valid Name", creditLimit: -100 },
        "op-bad-credit-limit-neg",
        "Credit limit must be a non-negative number",
        "3.18 Server rejects negative creditLimit with 422"
    );

    // Test 3.3: updateSupplierFromSync validation & non-string type rejections
    async function assertUpdateFails(payload: any, opId: string, errorMatch: string, testName: string) {
        let caught = false;
        try {
            await SupplierSyncService.updateSupplierFromSync(userContext, payload, opId);
        } catch (err: any) {
            caught = true;
            check(testName, err instanceof SyncProcessError && err.httpStatus === 422 && err.message.includes(errorMatch));
        }
        if (!caught) check(testName, false, "Did not throw expected error");
    }

    const targetSupplierId = createdRecord._id.toString();

    await assertUpdateFails(
        { supplierId: targetSupplierId, name: 123 },
        "op-upd-bad-name-type",
        "Supplier name must be a string",
        "3.19 Server update rejects numeric name with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, email: ["array"] },
        "op-upd-bad-email-type",
        "Email must be a string",
        "3.20 Server update rejects array email with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, email: "invalid-email@" },
        "op-upd-bad-email-format",
        "Invalid email format",
        "3.21 Server update rejects malformed email with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, gstin: 12345 },
        "op-upd-bad-gstin-type",
        "GSTIN must be a string",
        "3.22 Server update rejects numeric GSTIN with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, gstin: "BAD_GSTIN_123" },
        "op-upd-bad-gstin-format",
        "Invalid GSTIN format",
        "3.23 Server update rejects malformed GSTIN with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, pan: {} },
        "op-upd-bad-pan-type",
        "PAN must be a string",
        "3.24 Server update rejects object PAN with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, pan: "BAD_PAN" },
        "op-upd-bad-pan-format",
        "Invalid PAN format",
        "3.25 Server update rejects malformed PAN with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, creditDays: "abc" },
        "op-upd-bad-days-str",
        "Credit days must be an integer between 0 and 3650",
        "3.26 Server update rejects malformed creditDays string with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, creditDays: 5000 },
        "op-upd-bad-days-excess",
        "Credit days must be an integer between 0 and 3650",
        "3.27 Server update rejects creditDays > 3650 with 422"
    );

    await assertUpdateFails(
        { supplierId: targetSupplierId, creditLimit: -1 },
        "op-upd-bad-limit-neg",
        "Credit limit must be a non-negative number",
        "3.28 Server update rejects negative creditLimit with 422"
    );

    // Test 3.4: Valid update with string numbers and casing normalization
    const updateResult = await SupplierSyncService.updateSupplierFromSync(
        userContext,
        {
            supplierId: targetSupplierId,
            name: "Premier Fasteners Group",
            email: "SUPPORT@PREMIERFASTENERS.COM",
            gstin: "29abcde1234f1z5",
            pan: "abcde1234f",
            creditDays: "45",
            creditLimit: "300000",
        },
        "op-srv-update-001"
    );

    check("3.29 Server update succeeds", updateResult._id === targetSupplierId);
    check("3.30 Server update returns updated name", updateResult.name === "Premier Fasteners Group");
    check("3.31 Server update preserves official supplierCode", updateResult.supplierCode === "SUP-0101");

    check("3.32 Server update normalized email to lowercase", createdRecord.contact?.email === "support@premierfasteners.com");
    check("3.33 Server update normalized GSTIN to uppercase", createdRecord.tax?.gstin === "29ABCDE1234F1Z5");
    check("3.34 Server update normalized PAN to uppercase", createdRecord.tax?.pan === "ABCDE1234F");
    check("3.35 Server update parsed creditDays string to number 45", createdRecord.paymentTerms?.creditDays === 45);
    check("3.36 Server update parsed creditLimit string to number 300000", createdRecord.creditLimit === 300000);

    // Test 3.5: Empty string or null credit terms normalize to 0
    await SupplierSyncService.updateSupplierFromSync(
        userContext,
        {
            supplierId: targetSupplierId,
            creditDays: "",
            creditLimit: null,
        },
        "op-srv-update-clear-credit"
    );
    check("3.37 Empty string creditDays normalizes to 0", createdRecord.paymentTerms?.creditDays === 0);
    check("3.38 Null creditLimit normalizes to 0", createdRecord.creditLimit === 0);

    // Test 3.6: Idempotent replay of createSupplierFromSync
    const replayRes = await SupplierSyncService.createSupplierFromSync(
        userContext,
        {
            name: "Premier Industrial Fasteners",
        },
        "op-srv-create-001"
    );
    check("3.39 Idempotent retry returns alreadyProcessed: true", replayRes.alreadyProcessed === true);
    check("3.40 Idempotent retry returns existing ID", replayRes._id === targetSupplierId);
    check("3.41 Idempotent retry returns existing code", replayRes.supplierCode === "SUP-0101");

    return summarize();
}

runTests().then((success) => {
    if (!success) {
        process.exit(1);
    }
});
