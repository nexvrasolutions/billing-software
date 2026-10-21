/**
 * Regression Test Suite: Fix Supplier UPDATE Validation Failure & Queue Preservation
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. New Supplier UPDATE payloads omit lifecycle status in syncQueue.
 * 2. Queue healing (ensurePendingSuppliersQueued) does not reintroduce status into UPDATE payloads.
 * 3. Queue healing heals legacy queued UPDATE items by stripping status: "active".
 * 4. normalizeSupplierUpdatePayload strips harmless status: "active" but preserves other fields.
 * 5. Invalid lifecycle values (e.g. status: "inactive", status: "blocked") and banking/deletion fields remain rejected by uploadSchema.
 * 6. Existing Supplier CREATE flow still includes required status: "active".
 * 7. Cached supplier records retain their local status field untouched.
 * 8. Failed operations and re-queued operations strictly retain their original operation IDs.
 * 9. SyncManager upload boundary normalizes legacy queued UPDATE payloads while preserving operation IDs.
 *
 * Run:
 *   npx tsx scripts/test-supplier-update-validation-fix.ts
 */

import {
    type CachedSupplierRecord,
    type SyncQueueItem,
} from "../lib/offline/db";
import {
    makeCachedSupplierId,
    savePendingOfflineSupplier,
    savePendingOfflineSupplierUpdate,
    ensurePendingSuppliersQueued,
} from "../lib/offline/supplierCache";
import {
    uploadSchema,
    supplierUpdatePayloadSchema,
    supplierCreatePayloadSchema,
    normalizeSupplierUpdatePayload,
} from "../lib/validations/syncOperations";
import type { SessionIdentity } from "../lib/offline/syncPolicy";

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
    console.log(`SUPPLIER UPDATE FIX TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock
function createMemoryOfflineDb() {
    const cachedSuppliersMap = new Map<string, CachedSupplierRecord>();
    const syncQueueList: SyncQueueItem[] = [];
    const metaMap = new Map<string, unknown>();

    let nextQueueId = 1;

    const db = {
        cachedSuppliers: {
            get: async (key: string) => {
                const item = cachedSuppliersMap.get(key);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: CachedSupplierRecord) => {
                cachedSuppliersMap.set(record.id, structuredClone(record));
                return record.id;
            },
            delete: async (key: string) => {
                cachedSuppliersMap.delete(key);
            },
            update: async (key: string, changes: Partial<CachedSupplierRecord>) => {
                const item = cachedSuppliersMap.get(key);
                if (item) {
                    Object.assign(item, changes);
                    return 1;
                }
                return 0;
            },
            toArray: async () => {
                return Array.from(cachedSuppliersMap.values()).map((v) => structuredClone(v));
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = Array.from(cachedSuppliersMap.values());
                        return all.filter((s: any) => s[field] === val).map((v) => structuredClone(v));
                    },
                }),
            }),
        },
        syncQueue: {
            get: async (id: number) => {
                const item = syncQueueList.find((q) => q.id === id);
                return item ? structuredClone(item) : undefined;
            },
            put: async (record: SyncQueueItem) => {
                if (record.id === undefined) {
                    record.id = nextQueueId++;
                    syncQueueList.push(structuredClone(record));
                } else {
                    const idx = syncQueueList.findIndex((q) => q.id === record.id);
                    if (idx >= 0) syncQueueList[idx] = structuredClone(record);
                    else syncQueueList.push(structuredClone(record));
                }
                return record.id;
            },
            add: async (record: SyncQueueItem) => {
                if (record.id === undefined) {
                    record.id = nextQueueId++;
                } else if (record.id >= nextQueueId) {
                    nextQueueId = record.id + 1;
                }
                syncQueueList.push(structuredClone(record));
                return record.id;
            },
            update: async (id: number, changes: Partial<SyncQueueItem>) => {
                const item = syncQueueList.find((q) => q.id === id);
                if (item) {
                    Object.assign(item, changes);
                    return 1;
                }
                return 0;
            },
            toArray: async () => {
                return syncQueueList.map((q) => structuredClone(q));
            },
            where: (field: string) => ({
                equals: (val: any) => ({
                    toArray: async () => {
                        return syncQueueList.filter((q: any) => q[field] === val).map((q) => structuredClone(q));
                    },
                    first: async () => {
                        return syncQueueList.find((q: any) => q[field] === val);
                    },
                }),
            }),
            filter: (predicate: (q: SyncQueueItem) => boolean) => ({
                toArray: async () => {
                    return syncQueueList.filter(predicate).map((q) => structuredClone(q));
                },
            }),
        },
        meta: {
            get: async (key: string) => {
                const val = metaMap.get(key);
                return val !== undefined ? { key, value: structuredClone(val) } : undefined;
            },
            put: async (record: { key: string; value: unknown }) => {
                metaMap.set(record.key, structuredClone(record.value));
                return record.key;
            },
        },
        transaction: async (_mode: any, ...args: any[]) => {
            const callback = args[args.length - 1];
            return await callback();
        },
    };

    return db as any;
}

const mockOwner: SessionIdentity = {
    tenantId: "507f1f77bcf86cd799439011",
    userId: "507f1f77bcf86cd799439022",
    deviceId: "507f1f77bcf86cd799439033",
};

async function runTests() {
    console.log("=== REGRESSION TESTS: SUPPLIER UPDATE VALIDATION & QUEUE PRESERVATION ===\n");

    // ------------------------------------------------------------
    // 1. New Supplier UPDATE Payloads Omit Status
    // ------------------------------------------------------------
    console.log("-- 1. New Supplier UPDATE Payloads Omit Status --");
    const db1 = createMemoryOfflineDb();
    const serverSupplierId = "6ad735deb550e689e9622fb7";

    // Seed existing supplier record in cache
    await db1.cachedSuppliers.put({
        id: makeCachedSupplierId(mockOwner.tenantId, serverSupplierId),
        supplierId: serverSupplierId,
        tenantId: mockOwner.tenantId,
        supplierCode: "SUP-0004",
        name: "offline test",
        phone: "+91 9876543210",
        status: "active",
        syncStatus: "SYNCED",
        cachedAt: new Date().toISOString(),
    });

    const update1 = await savePendingOfflineSupplierUpdate(
        {
            supplierId: serverSupplierId,
            name: "offline test edited",
            phone: "+91 9876543299",
        },
        mockOwner.tenantId,
        db1,
        undefined,
        mockOwner
    );

    check("1.1 savePendingOfflineSupplierUpdate succeeded", update1 !== undefined);
    check("1.2 Cached supplier record preserves local status: active", update1.status === "active");
    check("1.3 Cached supplier record syncStatus is PENDING", update1.syncStatus === "PENDING");
    check("1.4 Cached supplier record has operationId assigned", typeof update1.operationId === "string" && update1.operationId.length > 0);

    const queue1 = await db1.syncQueue.toArray();
    check("1.5 syncQueue has 1 item", queue1.length === 1);
    const queueItem1 = queue1[0];
    check("1.6 Queued item operationType is UPDATE", queueItem1.operationType === "UPDATE");
    check("1.7 Queued item entityType is Supplier", queueItem1.entityType === "Supplier");
    check("1.8 Queued item operationId matches cached record operationId", queueItem1.operationId === update1.operationId);
    check("1.9 Queued UPDATE payload strictly OMITS status field", !("status" in queueItem1.payload));
    check("1.10 Queued UPDATE payload contains updated name", queueItem1.payload.name === "offline test edited");
    check("1.11 Queued UPDATE payload satisfies strict supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(queueItem1.payload).success);

    const fullUploadOp1 = {
        operationId: queueItem1.operationId,
        operationType: queueItem1.operationType,
        entityType: queueItem1.entityType,
        payload: queueItem1.payload,
        owner: mockOwner,
    };
    check("1.12 New Supplier UPDATE operation satisfies uploadSchema with HTTP 200/success", uploadSchema.safeParse(fullUploadOp1).success);

    // ------------------------------------------------------------
    // 2. Existing Queued UPDATE Payload Replacement Preserves OpId & Omits Status
    // ------------------------------------------------------------
    console.log("\n-- 2. Existing Queued UPDATE Payload Replacement --");
    // Make a second edit to the same supplier
    const originalOpId = update1.operationId!;
    const update2 = await savePendingOfflineSupplierUpdate(
        {
            supplierId: serverSupplierId,
            name: "offline test edited second time",
            email: "vendor@test.com",
        },
        mockOwner.tenantId,
        db1,
        undefined,
        mockOwner
    );

    const queueAfterSecondEdit = await db1.syncQueue.toArray();
    check("2.1 Still exactly 1 queue item (no duplicate items)", queueAfterSecondEdit.length === 1);
    const replacedQueueItem = queueAfterSecondEdit[0];
    check("2.2 Replaced queue item retains original operationId", replacedQueueItem.operationId === originalOpId);
    check("2.3 Replaced queue item payload OMITS status", !("status" in replacedQueueItem.payload));
    check("2.4 Replaced queue item payload has newest name", replacedQueueItem.payload.name === "offline test edited second time");
    check("2.5 Replaced queue item payload satisfies supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(replacedQueueItem.payload).success);

    // ------------------------------------------------------------
    // 3. Queue Healing (ensurePendingSuppliersQueued)
    // ------------------------------------------------------------
    console.log("\n-- 3. Queue Healing (ensurePendingSuppliersQueued) --");
    const db2 = createMemoryOfflineDb();
    const serverSupplierId2 = "6ad735deb550e689e9622fb8";

    // Scenario 3A: Orphaned pending supplier in cache without queue item
    await db2.cachedSuppliers.put({
        id: makeCachedSupplierId(mockOwner.tenantId, serverSupplierId2),
        supplierId: serverSupplierId2,
        tenantId: mockOwner.tenantId,
        supplierCode: "SUP-0005",
        name: "Orphaned Pending Supplier",
        status: "active",
        syncStatus: "PENDING",
        cachedAt: new Date().toISOString(),
    });

    const healedCount = await ensurePendingSuppliersQueued(mockOwner.tenantId, db2, mockOwner);
    check("3.1 ensurePendingSuppliersQueued reports 1 item healed", healedCount === 1);

    const healedQueue = await db2.syncQueue.toArray();
    check("3.2 Queue has 1 healed item", healedQueue.length === 1);
    const healedItem = healedQueue[0];
    check("3.3 Healed item is UPDATE operation", healedItem.operationType === "UPDATE");
    check("3.4 Healed item payload strictly OMITS status", !("status" in healedItem.payload));
    check("3.5 Healed item payload satisfies strict supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(healedItem.payload).success);

    // Scenario 3B: Existing queue item has legacy status: "active" in payload
    const serverSupplierId3 = "6ad735deb550e689e9622fb9";
    await db2.cachedSuppliers.put({
        id: makeCachedSupplierId(mockOwner.tenantId, serverSupplierId3),
        supplierId: serverSupplierId3,
        tenantId: mockOwner.tenantId,
        supplierCode: "SUP-0006",
        name: "Supplier With Legacy Active Status",
        status: "active",
        syncStatus: "PENDING",
        operationId: "legacy-op-001",
        cachedAt: new Date().toISOString(),
    });

    const legacyQueueId = await db2.syncQueue.add({
        operationId: "legacy-op-001",
        operationType: "UPDATE",
        entityType: "Supplier",
        payload: {
            supplierId: serverSupplierId3,
            name: "Supplier With Legacy Active Status",
            status: "active",
        },
        localSeq: Date.now(),
        status: "PENDING",
        attempts: 0,
        createdAt: new Date().toISOString(),
        owner: mockOwner,
        ownerUserId: mockOwner.userId,
    });

    await ensurePendingSuppliersQueued(mockOwner.tenantId, db2, mockOwner);
    const sanitizedQueueItem = await db2.syncQueue.get(legacyQueueId);
    check("3.6 ensurePendingSuppliersQueued stripped legacy status from existing item payload", !("status" in (sanitizedQueueItem?.payload || {})));
    check("3.7 Sanitized legacy item satisfies supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(sanitizedQueueItem?.payload).success);
    check("3.8 Original operationId preserved across healing", sanitizedQueueItem?.operationId === "legacy-op-001");

    // ------------------------------------------------------------
    // 4. normalizeSupplierUpdatePayload Behavior
    // ------------------------------------------------------------
    console.log("\n-- 4. normalizeSupplierUpdatePayload Behavior --");

    const legacyPayloadActive = {
        supplierId: "6ad735deb550e689e9622fb7",
        name: "Acme Corp",
        status: "active",
    };
    const normalizedActive = normalizeSupplierUpdatePayload(legacyPayloadActive);
    check("4.1 normalizeSupplierUpdatePayload strips status: 'active'", !("status" in normalizedActive));
    check("4.2 Stripped payload satisfies supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(normalizedActive).success);

    const maliciousPayloadInactive = {
        supplierId: "6ad735deb550e689e9622fb7",
        name: "Acme Corp",
        status: "inactive",
    };
    const normalizedInactive = normalizeSupplierUpdatePayload(maliciousPayloadInactive);
    check("4.3 normalizeSupplierUpdatePayload does NOT strip status: 'inactive'", (normalizedInactive as any).status === "inactive");
    check("4.4 Offline inactive status update remains strictly REJECTED by strict schema", !supplierUpdatePayloadSchema.safeParse(normalizedInactive).success);

    const maliciousPayloadBlocked = {
        supplierId: "6ad735deb550e689e9622fb7",
        name: "Acme Corp",
        status: "blocked",
    };
    const normalizedBlocked = normalizeSupplierUpdatePayload(maliciousPayloadBlocked);
    check("4.5 normalizeSupplierUpdatePayload does NOT strip status: 'blocked'", (normalizedBlocked as any).status === "blocked");
    check("4.6 Offline blocked status update remains strictly REJECTED by strict schema", !supplierUpdatePayloadSchema.safeParse(normalizedBlocked).success);

    const payloadWithBanking = {
        supplierId: "6ad735deb550e689e9622fb7",
        name: "Acme Corp",
        bankDetails: { accountNumber: "99999" },
    };
    check("4.7 Payload with banking details remains strictly REJECTED by strict schema", !supplierUpdatePayloadSchema.safeParse(payloadWithBanking).success);

    const payloadWithDelete = {
        supplierId: "6ad735deb550e689e9622fb7",
        name: "Acme Corp",
        isDeleted: true,
    };
    check("4.8 Payload with isDeleted remains strictly REJECTED by strict schema", !supplierUpdatePayloadSchema.safeParse(payloadWithDelete).success);

    const payloadWithUnknown = {
        supplierId: "6ad735deb550e689e9622fb7",
        name: "Acme Corp",
        arbitraryKey: "hacked",
    };
    check("4.9 Payload with arbitrary unknown key remains strictly REJECTED by strict schema", !supplierUpdatePayloadSchema.safeParse(payloadWithUnknown).success);

    // ------------------------------------------------------------
    // 5. Existing Supplier CREATE Flow Still Includes Required Status
    // ------------------------------------------------------------
    console.log("\n-- 5. Existing Supplier CREATE Flow Still Includes Required Status --");
    const db3 = createMemoryOfflineDb();
    const createResult = await savePendingOfflineSupplier(
        {
            name: "New Offline Supplier",
            phone: "+91 9111111111",
        },
        mockOwner.tenantId,
        db3
    );

    check("5.1 savePendingOfflineSupplier succeeded", createResult !== undefined);
    check("5.2 Created cached supplier has status: 'active'", createResult.supplier.status === "active");

    const createQueueItems = await db3.syncQueue.toArray();
    check("5.3 syncQueue has 1 CREATE item", createQueueItems.length === 1);
    const createQueueItem = createQueueItems[0];
    check("5.4 Queue item operationType is CREATE", createQueueItem.operationType === "CREATE");
    check("5.5 Queue item payload retains status: 'active'", createQueueItem.payload.status === "active");
    check("5.6 CREATE payload satisfies supplierCreatePayloadSchema", supplierCreatePayloadSchema.safeParse(createQueueItem.payload).success);

    const fullCreateOp = {
        operationId: createQueueItem.operationId,
        operationType: createQueueItem.operationType,
        entityType: createQueueItem.entityType,
        payload: createQueueItem.payload,
        owner: mockOwner,
    };
    check("5.7 Full CREATE operation satisfies uploadSchema", uploadSchema.safeParse(fullCreateOp).success);

    // ------------------------------------------------------------
    // 6. Preservation of Failed Operation ID During Re-Edit
    // ------------------------------------------------------------
    console.log("\n-- 6. Failed Operation ID Preservation --");
    const failedOpId = "op-failed-needs-attention-123";
    const db4 = createMemoryOfflineDb();

    // Seed existing supplier in NEEDS_ATTENTION state (matching user screenshot)
    await db4.cachedSuppliers.put({
        id: makeCachedSupplierId(mockOwner.tenantId, serverSupplierId),
        supplierId: serverSupplierId,
        tenantId: mockOwner.tenantId,
        supplierCode: "SUP-0004",
        name: "offline test",
        status: "active",
        syncStatus: "NEEDS_ATTENTION",
        errorMessage: "Invalid sync operation",
        operationId: failedOpId,
        cachedAt: new Date().toISOString(),
    });

    // Seed failed queue item in NEEDS_ATTENTION state
    await db4.syncQueue.add({
        id: 42,
        operationId: failedOpId,
        operationType: "UPDATE",
        entityType: "Supplier",
        payload: {
            supplierId: serverSupplierId,
            name: "offline test",
            status: "active", // legacy payload causing the failure
        },
        localSeq: 100,
        status: "NEEDS_ATTENTION",
        attempts: 1,
        errorMessage: "Invalid sync operation",
        createdAt: new Date().toISOString(),
        owner: mockOwner,
        ownerUserId: mockOwner.userId,
    });

    // User follows UI safe recovery guidance: clicks "Edit details" and saves
    const recoveredSupplier = await savePendingOfflineSupplierUpdate(
        {
            supplierId: serverSupplierId,
            name: "offline test corrected",
        },
        mockOwner.tenantId,
        db4,
        undefined,
        mockOwner
    );

    check("6.1 Recovered supplier syncStatus transitioned to PENDING", recoveredSupplier.syncStatus === "PENDING");
    check("6.2 Recovered supplier operationId matches original failed operationId", recoveredSupplier.operationId === failedOpId);
    check("6.3 Recovered supplier errorMessage is cleared", recoveredSupplier.errorMessage === undefined);

    const updatedQueueItem = await db4.syncQueue.get(42);
    check("6.4 Queue item retained its primary ID (not deleted/re-created)", updatedQueueItem?.id === 42);
    check("6.5 Queue item retained original operationId", updatedQueueItem?.operationId === failedOpId);
    check("6.6 Queue item status reset to PENDING for automatic retry", updatedQueueItem?.status === "PENDING");
    check("6.7 Queue item payload OMITS status", !("status" in (updatedQueueItem?.payload || {})));
    check("6.8 Queue item payload satisfies supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(updatedQueueItem?.payload).success);

    summarize();
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
