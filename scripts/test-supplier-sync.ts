/*
 * Automated Database-Free Test Suite for Phase 3, Stage 2: Supplier Server Synchronization
 * (NO MONGODB, NO SERVER, NO NETWORK, NO BROWSER STORAGE MUTATIONS).
 *
 * Verifies:
 * 1. Business Permissions & Sync Entity Mapping:
 *    - SYNC_ENTITY_PERMISSIONS.Supplier maps to BUSINESS_PERMISSIONS.purchasesCreate ("purchases.create").
 *    - getSyncEntityPermission("Supplier") returns "purchases.create".
 *    - getSyncEntityPermission fails closed (returns null) for unknown entities.
 * 2. Sync Upload Payload Validation (app/api/sync-operations & lib/validations/syncOperations):
 *    - Valid Supplier CREATE payload accepted.
 *    - Valid Supplier UPDATE payload accepted.
 *    - Strict rejection of sensitive banking fields (bankDetails, accountNumber, ifsc, upiId).
 *    - Strict rejection of lifecycle action fields (action: "deactivate", status: "inactive", isDeleted: true).
 *    - Rejection of malformed / missing required fields.
 *    - Standard CREATE operations for Sale, Purchase, Customer remain unaffected.
 * 3. Supplier Mongoose Model & Idempotency Strategy:
 *    - operationId field declared on Supplier schema.
 *    - Tenant-scoped partial unique index defined: { tenantId: 1, operationId: 1 } with { operationId: { $type: "string", $gt: "" } }.
 *    - Legacy suppliers without operationId do not collide.
 * 4. SupplierSyncService.createSupplierFromSync:
 *    - Allocates official sequential supplier code via SupplierCodeService.
 *    - Idempotent retries: replaying operationId returns alreadyProcessed: true with existing server ID.
 *    - Rejects banking fields, lifecycle status changes, and soft-deletion.
 *    - Validates name, phone, email, GSTIN, PAN.
 *    - Returns mapping metadata (_id, supplierCode, localId, name) for client reconciliation.
 * 5. SupplierSyncService.updateSupplierFromSync:
 *    - Updates profile fields (name, phone, address, credit terms) while preserving official supplierCode.
 *    - Enforces tenant isolation (rejects cross-tenant updates).
 *    - Rejects updates on soft-deleted suppliers.
 *    - Rejects banking fields and lifecycle status transitions.
 *    - Rejects empty updates.
 * 6. SyncService.processOperation Routing:
 *    - Routes entityType: "Supplier", operationType: "CREATE" to SupplierSyncService.createSupplierFromSync.
 *    - Routes entityType: "Supplier", operationType: "UPDATE" to SupplierSyncService.updateSupplierFromSync.
 *
 * Run:
 *   npx tsx scripts/test-supplier-sync.ts
 */

import mongoose from "mongoose";
import {
    BUSINESS_PERMISSIONS,
    SYNC_ENTITY_PERMISSIONS,
    getSyncEntityPermission,
} from "../lib/auth/businessPermissions";
import { Supplier } from "../lib/models/Supplier";
import { SupplierSyncService } from "../lib/services/SupplierSyncService";
import { SupplierCodeService } from "../lib/services/SupplierCodeService";
import { AuditLogService } from "../lib/services/AuditLogService";
import { SyncService } from "../lib/services/SyncService";
import { SyncProcessError } from "../lib/services/SyncErrors";
import {
    supplierCreatePayloadSchema,
    supplierUpdatePayloadSchema,
    supplierCreateSchema,
    supplierUpdateSchema,
    uploadSchema,
} from "../lib/validations/syncOperations";

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
    console.log(`SUPPLIER SYNC TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

async function runTests() {
    console.log("=== PHASE 3, STAGE 2: SUPPLIER SERVER SYNCHRONIZATION TESTS ===\n");

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
    // 1. BUSINESS PERMISSIONS & SYNC ENTITY MAPPING
    // ============================================================
    console.log("-- 1. Business Permissions & Sync Entity Mapping --");

    check(
        "1.1 SYNC_ENTITY_PERMISSIONS.Supplier maps to BUSINESS_PERMISSIONS.purchasesCreate",
        SYNC_ENTITY_PERMISSIONS.Supplier === BUSINESS_PERMISSIONS.purchasesCreate
    );
    check(
        "1.2 purchasesCreate value is purchases.create",
        BUSINESS_PERMISSIONS.purchasesCreate === "purchases.create"
    );
    check(
        "1.3 getSyncEntityPermission('Supplier') returns purchases.create",
        getSyncEntityPermission("Supplier") === "purchases.create"
    );
    check(
        "1.4 Existing Customer sync permission preserved as sales.create",
        getSyncEntityPermission("Customer") === "sales.create"
    );
    check(
        "1.5 Existing Product sync permission preserved as products.create",
        getSyncEntityPermission("Product") === "products.create"
    );
    check(
        "1.6 getSyncEntityPermission fails closed for unknown entities",
        getSyncEntityPermission("UnknownEntity") === null &&
        getSyncEntityPermission("constructor") === null &&
        getSyncEntityPermission("") === null
    );

    // ============================================================
    // 2. SYNC UPLOAD PAYLOAD VALIDATION
    // ============================================================
    console.log("\n-- 2. Sync Upload Payload Validation (Zod Schemas) --");

    const validCreatePayload = {
        localId: "sup_12345678",
        supplierCode: "SUP-TEMP-1A2B3C4D",
        name: "Supreme Packaging Industries",
        contactPerson: "Rajesh Rao",
        phone: "9876543210",
        altPhone: "9876543211",
        email: "rajesh@supreme.in",
        website: "https://supreme.in",
        address: "Plot 12, Industrial Estate",
        line1: "Plot 12, Industrial Estate",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560058",
        country: "India",
        gstin: "29ABCDE1234F1Z5",
        pan: "ABCDE1234F",
        paymentType: "credit",
        creditDays: 30,
        creditLimit: 250000,
        category: "Packaging",
        notes: "Boxes and labels",
        status: "active",
    };

    const validCreateOp = {
        operationId: "op-create-supplier-001",
        operationType: "CREATE",
        entityType: "Supplier",
        payload: validCreatePayload,
        owner: {
            tenantId: tenantA.toString(),
            userId: userA.toString(),
            deviceId: deviceA.toString(),
        },
    };

    const parseCreateResult = uploadSchema.safeParse(validCreateOp);
    check("2.1 Valid Supplier CREATE operation passes uploadSchema", parseCreateResult.success);

    const validUpdatePayload = {
        supplierId: "670c55555555555555555555",
        name: "Supreme Packaging Solutions Ltd",
        phone: "9876543212",
        address: "Updated Address 99",
        category: "Cardboard Packaging",
        creditDays: 45,
    };

    const validUpdateOp = {
        operationId: "op-update-supplier-001",
        operationType: "UPDATE",
        entityType: "Supplier",
        payload: validUpdatePayload,
        owner: {
            tenantId: tenantA.toString(),
            userId: userA.toString(),
            deviceId: deviceA.toString(),
        },
    };

    const parseUpdateResult = uploadSchema.safeParse(validUpdateOp);
    check("2.2 Valid Supplier UPDATE operation passes uploadSchema", parseUpdateResult.success);

    // Strict rejection of banking fields in CREATE
    const createWithBank = {
        ...validCreateOp,
        payload: {
            ...validCreatePayload,
            bankDetails: { accountNumber: "1234567890", ifsc: "HDFC0001234" },
        },
    };
    check("2.3 Supplier CREATE with bankDetails rejected by strict schema", !uploadSchema.safeParse(createWithBank).success);

    const createWithAccountNum = {
        ...validCreateOp,
        payload: {
            ...validCreatePayload,
            accountNumber: "1234567890",
        },
    };
    check("2.4 Supplier CREATE with accountNumber rejected by strict schema", !uploadSchema.safeParse(createWithAccountNum).success);

    // Strict rejection of lifecycle action in CREATE
    const createWithInactive = {
        ...validCreateOp,
        payload: {
            ...validCreatePayload,
            status: "inactive",
        },
    };
    check("2.5 Supplier CREATE with status: inactive rejected by strict schema", !uploadSchema.safeParse(createWithInactive).success);

    const createWithAction = {
        ...validCreateOp,
        payload: {
            ...validCreatePayload,
            action: "deactivate",
        },
    };
    check("2.6 Supplier CREATE with action: deactivate rejected by strict schema", !uploadSchema.safeParse(createWithAction).success);

    // Strict rejection of banking fields in UPDATE
    const updateWithBank = {
        ...validUpdateOp,
        payload: {
            ...validUpdatePayload,
            bankDetails: { upiId: "pay@upi" },
        },
    };
    check("2.7 Supplier UPDATE with bankDetails rejected by strict schema", !uploadSchema.safeParse(updateWithBank).success);

    // Strict rejection of lifecycle actions in UPDATE
    const updateWithStatus = {
        ...validUpdateOp,
        payload: {
            ...validUpdatePayload,
            status: "inactive",
        },
    };
    check("2.8 Supplier UPDATE with status: inactive rejected by strict schema", !uploadSchema.safeParse(updateWithStatus).success);

    const updateWithDelete = {
        ...validUpdateOp,
        payload: {
            ...validUpdatePayload,
            isDeleted: true,
        },
    };
    check("2.9 Supplier UPDATE with isDeleted: true rejected by strict schema", !uploadSchema.safeParse(updateWithDelete).success);

    // Missing name in CREATE
    const createMissingName = {
        ...validCreateOp,
        payload: {
            ...validCreatePayload,
            name: "   ",
        },
    };
    check("2.10 Supplier CREATE with empty name rejected", !uploadSchema.safeParse(createMissingName).success);

    // Invalid ObjectId for supplierId in UPDATE
    const updateBadId = {
        ...validUpdateOp,
        payload: {
            ...validUpdatePayload,
            supplierId: "invalid-id",
        },
    };
    check("2.11 Supplier UPDATE with malformed supplierId rejected", !uploadSchema.safeParse(updateBadId).success);

    // Existing Customer & Product operations remain valid
    const validCustCreate = {
        operationId: "op-cust-001",
        operationType: "CREATE",
        entityType: "Customer",
        payload: { name: "Customer X", phone: "9876543210" },
        owner: validCreateOp.owner,
    };
    check("2.12 Standard Customer CREATE continues to parse successfully", uploadSchema.safeParse(validCustCreate).success);

    const validProdCreate = {
        operationId: "op-prod-001",
        operationType: "CREATE",
        entityType: "Product",
        payload: { name: "Product Y", SKU: "SKU-Y", sellingPrice: 100 },
        owner: validCreateOp.owner,
    };
    check("2.13 Standard Product CREATE continues to parse successfully", uploadSchema.safeParse(validProdCreate).success);

    // ============================================================
    // 3. SUPPLIER MONGOOSE MODEL & IDEMPOTENCY STRATEGY
    // ============================================================
    console.log("\n-- 3. Supplier Mongoose Model & Schema Index Verification --");

    const operationIdPath = Supplier.schema.path("operationId");
    check("3.1 operationId property declared on Supplier schema", operationIdPath !== undefined);
    check("3.2 operationId is String type", operationIdPath?.instance === "String");

    const schemaIndexes = Supplier.schema.indexes();
    const opIdIndex = schemaIndexes.find((idx) => {
        const fields = idx[0];
        return fields.tenantId === 1 && fields.operationId === 1;
    });

    check("3.3 Tenant-scoped operationId index declared on Supplier schema", opIdIndex !== undefined);
    check("3.4 operationId index is unique", opIdIndex?.[1]?.unique === true);
    check(
        "3.5 operationId index has partialFilterExpression for non-empty strings",
        (opIdIndex?.[1] as any)?.partialFilterExpression?.operationId?.$type === "string" &&
        (opIdIndex?.[1] as any)?.partialFilterExpression?.operationId?.$gt === ""
    );

    const supplierCodeIndex = schemaIndexes.find((idx) => {
        const fields = idx[0];
        return fields.tenantId === 1 && fields.supplierCode === 1;
    });
    check("3.6 supplierCode unique index preserved on Supplier schema", supplierCodeIndex?.[1]?.unique === true);

    // ============================================================
    // 4. SUPPLIERSYNCSERVICE: CREATE & IDEMPOTENCY
    // ============================================================
    console.log("\n-- 4. SupplierSyncService.createSupplierFromSync --");

    // Mock storage for in-memory simulation
    const suppliersCollection: any[] = [];
    const auditLogs: any[] = [];
    let allocatedSequence = 1;

    // Spy on SupplierCodeService.generateNextSupplierCode
    const origGenerateCode = SupplierCodeService.generateNextSupplierCode;
    SupplierCodeService.generateNextSupplierCode = async (tenantId: mongoose.Types.ObjectId) => {
        const candidate = `SUP-${String(allocatedSequence++).padStart(4, "0")}`;
        return candidate;
    };

    // Spy on AuditLogService.createAuditLog
    const origCreateAuditLog = AuditLogService.createAuditLog;
    AuditLogService.createAuditLog = async (ctx: any, log: any) => {
        auditLogs.push({ ctx, log });
        return { _id: new mongoose.Types.ObjectId() } as any;
    };

    // Spy on Supplier.findOne and Supplier.create
    const origFindOne = Supplier.findOne;
    const origCreate = Supplier.create;

    Supplier.findOne = ((query: any) => {
        let isLean = false;
        const executor = {
            select: () => executor,
            lean: () => {
                isLean = true;
                return executor;
            },
            then: (resolve: any) => {
                const found = suppliersCollection.find((s) => {
                    if (query.tenantId && !s.tenantId.equals(query.tenantId)) return false;
                    if (query.operationId && s.operationId !== query.operationId) return false;
                    if (query._id && !s._id.equals(query._id)) return false;
                    if (query.supplierCode && s.supplierCode !== query.supplierCode) return false;
                    if (query.isDeleted?.$ne !== undefined && s.isDeleted === query.isDeleted.$ne) return false;
                    return true;
                });
                return resolve(found ? (isLean ? structuredClone(found) : found) : null);
            },
        };
        return executor as any;
    }) as any;

    Supplier.create = (async (docOrDocs: any, options?: any) => {
        const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
        const createdList = docs.map((d) => ({
            ...d,
            _id: new mongoose.Types.ObjectId(),
            createdAt: new Date(),
            updatedAt: new Date(),
        }));
        suppliersCollection.push(...createdList);
        return Array.isArray(docOrDocs) ? createdList : createdList[0];
    }) as any;

    // Test 4.1: First creation allocates official code and returns mapping info
    const createResult = await SupplierSyncService.createSupplierFromSync(
        userContext,
        {
            localId: "sup_local_001",
            supplierCode: "SUP-TEMP-A1B2C3D4",
            name: "Hindustan Metal Works",
            phone: "9812345678",
            gstin: "29AABCH1234F1Z0",
            paymentType: "credit",
            creditDays: 30,
        },
        "op-supplier-sync-001"
    );

    check("4.1 Server allocates official sequential code (SUP-0001)", createResult.supplierCode === "SUP-0001");
    check("4.2 Returns server MongoDB ObjectId", mongoose.isValidObjectId(createResult._id));
    check("4.3 Returns local temporary ID for client reconciliation", createResult.localId === "sup_local_001");
    check("4.4 Returns supplier name", createResult.name === "Hindustan Metal Works");
    check("4.5 Stored supplier document in collection has active status", suppliersCollection[0].status === "active");
    check("4.6 Stored supplier document has operationId recorded", suppliersCollection[0].operationId === "op-supplier-sync-001");
    check("4.7 Stored supplier document has tenantId recorded", suppliersCollection[0].tenantId.equals(tenantA));

    // Audit log safety check
    const createAudit = auditLogs.find((a) => a.log.action === "CREATE" && a.log.entity === "Supplier");
    check("4.8 Audit log created for supplier creation", createAudit !== undefined);
    check("4.9 Audit log records official supplier code", createAudit?.log?.newValues?.supplierCode === "SUP-0001");
    check("4.10 Audit log does NOT contain banking details",
        createAudit?.log?.newValues?.bankDetails === undefined &&
        createAudit?.log?.newValues?.accountNumber === undefined
    );

    // Test 4.2: Idempotent replay with same operationId
    const seqBeforeReplay = allocatedSequence;
    const replayResult = await SupplierSyncService.createSupplierFromSync(
        userContext,
        {
            localId: "sup_local_001",
            supplierCode: "SUP-TEMP-A1B2C3D4",
            name: "Hindustan Metal Works",
        },
        "op-supplier-sync-001" // Exact same operation ID
    );

    check("4.11 Idempotent retry returns alreadyProcessed: true", replayResult.alreadyProcessed === true);
    check("4.12 Idempotent retry returns existing server ID", replayResult._id === createResult._id);
    check("4.13 Idempotent retry returns previously allocated code", replayResult.supplierCode === "SUP-0001");
    check("4.14 Idempotent retry did NOT increment sequence counter", allocatedSequence === seqBeforeReplay);
    check("4.15 Idempotent retry did NOT create a second document in collection", suppliersCollection.length === 1);

    // Test 4.3: Banking details rejection in SupplierSyncService
    let bankErrorCaught = false;
    try {
        await SupplierSyncService.createSupplierFromSync(
            userContext,
            {
                name: "Vendor With Bank",
                bankDetails: { accountNumber: "999999999" },
            },
            "op-supplier-bank-001"
        );
    } catch (err: any) {
        bankErrorCaught = true;
        check("4.16 Service rejects banking details with 422 PERMANENT_FAILURE",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.code === "PERMANENT_FAILURE" &&
            err.message.includes("Banking details cannot be synchronized")
        );
    }
    check("4.17 Banking rejection threw error", bankErrorCaught);

    // Test 4.4: Lifecycle action rejection in SupplierSyncService
    let lifecycleErrorCaught = false;
    try {
        await SupplierSyncService.createSupplierFromSync(
            userContext,
            {
                name: "Vendor Inactive",
                status: "inactive",
            },
            "op-supplier-inactive-001"
        );
    } catch (err: any) {
        lifecycleErrorCaught = true;
        check("4.18 Service rejects inactive status on offline create with 422 PERMANENT_FAILURE",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.message.includes("Offline supplier creation must have active status")
        );
    }
    check("4.19 Lifecycle rejection threw error", lifecycleErrorCaught);

    // Test 4.5: Validation rules
    let gstinErrorCaught = false;
    try {
        await SupplierSyncService.createSupplierFromSync(
            userContext,
            {
                name: "Vendor Bad GSTIN",
                gstin: "INVALID_GSTIN_123",
            },
            "op-supplier-bad-gstin"
        );
    } catch (err: any) {
        gstinErrorCaught = true;
        check("4.20 Invalid GSTIN rejected with 422 PERMANENT_FAILURE",
            err instanceof SyncProcessError && err.httpStatus === 422 && err.message.includes("Invalid GSTIN")
        );
    }
    check("4.21 GSTIN error threw error", gstinErrorCaught);

    let emptyNameErrorCaught = false;
    try {
        await SupplierSyncService.createSupplierFromSync(
            userContext,
            {
                name: "    ",
            },
            "op-supplier-no-name"
        );
    } catch (err: any) {
        emptyNameErrorCaught = true;
        check("4.22 Empty name rejected with 422 PERMANENT_FAILURE",
            err instanceof SyncProcessError && err.httpStatus === 422 && err.message.includes("Supplier name is required")
        );
    }
    check("4.23 Empty name threw error", emptyNameErrorCaught);

    // ============================================================
    // 5. SUPPLIERSYNCSERVICE: UPDATE & TENANT ISOLATION
    // ============================================================
    console.log("\n-- 5. SupplierSyncService.updateSupplierFromSync --");

    const existingSupplier = suppliersCollection[0];

    // Spy on Supplier.findOneAndUpdate
    const origFindOneAndUpdate = Supplier.findOneAndUpdate;
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

    // Test 5.1: Valid profile detail update
    const updateResult = await SupplierSyncService.updateSupplierFromSync(
        userContext,
        {
            supplierId: existingSupplier._id.toString(),
            name: "Hindustan Metal Works Private Limited",
            phone: "9876599999",
            address: "New Industrial Plot 42",
            creditDays: 60,
            category: "Heavy Metals",
        },
        "op-supplier-update-001"
    );

    check("5.1 Profile update returns server ID", updateResult._id === existingSupplier._id.toString());
    check("5.2 Profile update returns updated name", updateResult.name === "Hindustan Metal Works Private Limited");
    check("5.3 Profile update preserves official supplierCode", updateResult.supplierCode === "SUP-0001");
    check("5.4 Document updated in collection", suppliersCollection[0].name === "Hindustan Metal Works Private Limited");
    check("5.5 Phone updated in collection", suppliersCollection[0].contact.phone === "9876599999");
    check("5.6 Credit days updated in collection", suppliersCollection[0].paymentTerms.creditDays === 60);

    const updateAudit = auditLogs.find((a) => a.log.action === "UPDATE" && a.log.entity === "Supplier");
    check("5.7 Audit log emitted for supplier update", updateAudit !== undefined);

    // Test 5.2: Cross-tenant update rejection (Tenant B attempts to update Tenant A's supplier)
    let crossTenantErrorCaught = false;
    try {
        await SupplierSyncService.updateSupplierFromSync(
            { ...userContext, tenantId: tenantB },
            {
                supplierId: existingSupplier._id.toString(),
                name: "Hacked Supplier Name",
            },
            "op-cross-tenant-update"
        );
    } catch (err: any) {
        crossTenantErrorCaught = true;
        check("5.8 Cross-tenant update rejected with 422 Supplier not found for this tenant",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.message.includes("Supplier not found for this tenant")
        );
    }
    check("5.9 Cross-tenant update threw error", crossTenantErrorCaught);

    // Test 5.3: Lifecycle status rejection on update
    let updateStatusErrorCaught = false;
    try {
        await SupplierSyncService.updateSupplierFromSync(
            userContext,
            {
                supplierId: existingSupplier._id.toString(),
                name: "Deactivated Supplier",
                status: "inactive",
            },
            "op-status-update"
        );
    } catch (err: any) {
        updateStatusErrorCaught = true;
        check("5.10 Status update rejected with online-only error",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.message.includes("online-only")
        );
    }
    check("5.11 Status update threw error", updateStatusErrorCaught);

    // Test 5.4: Banking fields rejection on update
    let updateBankErrorCaught = false;
    try {
        await SupplierSyncService.updateSupplierFromSync(
            userContext,
            {
                supplierId: existingSupplier._id.toString(),
                name: "Vendor Update With Bank",
                bankDetails: { accountNumber: "11111111" },
            },
            "op-bank-update"
        );
    } catch (err: any) {
        updateBankErrorCaught = true;
        check("5.12 Banking update rejected with 422 PERMANENT_FAILURE",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.message.includes("Banking details cannot be modified via offline sync")
        );
    }
    check("5.13 Banking update threw error", updateBankErrorCaught);

    // Test 5.5: Empty update payload rejection
    let emptyUpdateCaught = false;
    try {
        await SupplierSyncService.updateSupplierFromSync(
            userContext,
            {
                supplierId: existingSupplier._id.toString(),
            },
            "op-empty-update"
        );
    } catch (err: any) {
        emptyUpdateCaught = true;
        check("5.14 Empty update payload rejected with 422 Provide at least one profile field",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.message.includes("Provide at least one profile field")
        );
    }
    check("5.15 Empty update threw error", emptyUpdateCaught);

    // Test 5.6: Soft-deleted supplier rejection
    suppliersCollection.push({
        _id: new mongoose.Types.ObjectId("670c99999999999999999999"),
        tenantId: tenantA,
        supplierCode: "SUP-0999",
        name: "Deleted Supplier",
        isDeleted: true,
        status: "inactive",
    });

    let softDeletedErrorCaught = false;
    try {
        await SupplierSyncService.updateSupplierFromSync(
            userContext,
            {
                supplierId: "670c99999999999999999999",
                name: "Try Edit Deleted",
            },
            "op-edit-deleted"
        );
    } catch (err: any) {
        softDeletedErrorCaught = true;
        check("5.16 Soft-deleted supplier update rejected (not found / protected)",
            err instanceof SyncProcessError &&
            err.httpStatus === 422 &&
            err.message.includes("Supplier not found for this tenant")
        );
    }
    check("5.17 Soft-deleted supplier threw error", softDeletedErrorCaught);

    // ============================================================
    // 6. SYNCSERVICE.PROCESSOPERATION ROUTING
    // ============================================================
    console.log("\n-- 6. SyncService.processOperation Routing --");

    let createFromSyncCalled = false;
    let updateFromSyncCalled = false;

    const origCreateFromSync = SupplierSyncService.createSupplierFromSync;
    const origUpdateFromSync = SupplierSyncService.updateSupplierFromSync;

    SupplierSyncService.createSupplierFromSync = async () => {
        createFromSyncCalled = true;
        return {
            _id: "670c88888888888888888888",
            supplierCode: "SUP-0008",
            name: "Routed Supplier",
        };
    };

    SupplierSyncService.updateSupplierFromSync = async () => {
        updateFromSyncCalled = true;
        return {
            _id: "670c88888888888888888888",
            supplierCode: "SUP-0008",
            name: "Routed Supplier Updated",
        };
    };

    // Test CREATE routing
    const createOpObj = {
        operationId: "op-route-create",
        operationType: "CREATE" as const,
        entityType: "Supplier" as const,
        payload: { name: "Routed Supplier" },
        status: "PENDING" as const,
        attempts: 0,
        createdAt: new Date(),
    };

    const processCreateResult = await (SyncService as any).runBusinessOperation(
        userContext,
        "Supplier",
        createOpObj.payload,
        createOpObj.operationId,
        {} as any,
        "CREATE"
    );

    check("6.1 runBusinessOperation routes Supplier CREATE to SupplierSyncService.createSupplierFromSync", createFromSyncCalled);
    check("6.2 runBusinessOperation returns createSupplierFromSync result", processCreateResult.supplierCode === "SUP-0008");

    // Test UPDATE routing
    const updateOpObj = {
        operationId: "op-route-update",
        operationType: "UPDATE" as const,
        entityType: "Supplier" as const,
        payload: { supplierId: "670c88888888888888888888", name: "Routed Supplier Updated" },
        status: "PENDING" as const,
        attempts: 0,
        createdAt: new Date(),
    };

    const processUpdateResult = await (SyncService as any).runBusinessOperation(
        userContext,
        "Supplier",
        updateOpObj.payload,
        updateOpObj.operationId,
        {} as any,
        "UPDATE"
    );

    check("6.3 runBusinessOperation routes Supplier UPDATE to SupplierSyncService.updateSupplierFromSync", updateFromSyncCalled);
    check("6.4 runBusinessOperation returns updateSupplierFromSync result", processUpdateResult.name === "Routed Supplier Updated");

    // Restore original methods
    SupplierCodeService.generateNextSupplierCode = origGenerateCode;
    AuditLogService.createAuditLog = origCreateAuditLog;
    Supplier.findOne = origFindOne;
    Supplier.create = origCreate;
    Supplier.findOneAndUpdate = origFindOneAndUpdate;
    SupplierSyncService.createSupplierFromSync = origCreateFromSync;
    SupplierSyncService.updateSupplierFromSync = origUpdateFromSync;

    return summarize();
}

runTests().then((success) => {
    process.exit(success ? 0 : 1);
});
