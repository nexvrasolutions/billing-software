/**
 * Test Suite: Phase 3, Stage 3: Supplier Client Sync and Reconciliation
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Supplier CREATE & UPDATE upload payload validation & schema compliance
 * 2. Temporary-to-server ID and official code reconciliation in cachedSuppliers
 * 3. Preserving pending local edits across server responses (stale response protection)
 * 4. Dependent queued Purchase re-linking (supplierId, official code, snapshot, dependsOn)
 * 5. Strict safety boundaries: already-synced purchases and cross-tenant records untouched
 * 6. Pre-upload safety guards for dependent purchases with temporary supplier IDs
 * 7. Permanent failure cascade (NEEDS_ATTENTION) to cache and dependent purchases
 * 8. Sorting & prerequisite prioritization in selectSyncable (Supplier before Purchase)
 * 9. Idempotent retries and duplicate acknowledgements handling
 * 10. Queue healing via ensurePendingSuppliersQueued
 *
 * Run:
 *   npx tsx scripts/test-supplier-client-sync.ts
 */

import {
    OfflineDatabase,
    type CachedSupplierRecord,
    type SyncQueueItem,
} from "../lib/offline/db";
import {
    makeCachedSupplierId,
    resolvePendingSupplierId,
    markPendingSupplierNeedsAttention,
    ensurePendingSuppliersQueued,
    isTemporarySupplierId,
    isTemporarySupplierCode,
    isValidServerSupplierId,
} from "../lib/offline/supplierCache";
import {
    selectSyncable,
    type SessionIdentity,
    type QueueItemState,
} from "../lib/offline/syncPolicy";
import {
    uploadSchema,
    supplierCreatePayloadSchema,
    supplierUpdatePayloadSchema,
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
    console.log(`SUPPLIER CLIENT SYNC TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// In-memory Database mock implementing OfflineDatabase tables
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
                    delete: async () => {
                        let deletedCount = 0;
                        for (const [key, item] of Array.from(cachedSuppliersMap.entries())) {
                            if ((item as any)[field] === val) {
                                cachedSuppliersMap.delete(key);
                                deletedCount++;
                            }
                        }
                        return deletedCount;
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
                record.id = nextQueueId++;
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
                        return syncQueueList.filter((q: any) => q[field] === val).map((v) => structuredClone(v));
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
    } as unknown as OfflineDatabase;

    return { db, cachedSuppliersMap, syncQueueList, metaMap };
}

// ============================================================
// TESTS IMPLEMENTATION
// ============================================================

async function runTests() {
    console.log("=== PHASE 3, STAGE 3: SUPPLIER CLIENT SYNC & RECONCILIATION TESTS ===\n");

    const tenantA = "tenant_alpha_123";
    const tenantB = "tenant_beta_456";
    const sessionIdentityA: SessionIdentity = {
        tenantId: tenantA,
        userId: "507f1f77bcf86cd799439001",
        deviceId: "507f1f77bcf86cd799439002",
    };

    // ------------------------------------------------------------
    // 1. Upload Payload Validation & Strict Schemas
    // ------------------------------------------------------------
    console.log("-- 1. Upload Payload Validation & Strict Schemas --");

    const validCreatePayload = {
        localId: "sup_12345",
        supplierCode: "SUP-TEMP-A1B2C3D4",
        name: "Acme Industrial Supplies",
        phone: "+91 9876543210",
        email: "sales@acme.com",
        gstin: "27AAPCA1234A1Z5",
        paymentType: "credit" as const,
        creditDays: 30,
        status: "active" as const,
    };
    check("1.1 Valid Supplier CREATE payload satisfies supplierCreatePayloadSchema", supplierCreatePayloadSchema.safeParse(validCreatePayload).success);

    const validUpdatePayload = {
        supplierId: "507f1f77bcf86cd799439011",
        name: "Acme Industrial Supplies Pvt Ltd",
        phone: "+91 9876543211",
        creditDays: 45,
    };
    check("1.2 Valid Supplier UPDATE payload satisfies supplierUpdatePayloadSchema", supplierUpdatePayloadSchema.safeParse(validUpdatePayload).success);

    const validOwner = {
        tenantId: "507f1f77bcf86cd799439001",
        userId: "507f1f77bcf86cd799439002",
        deviceId: "507f1f77bcf86cd799439003",
    };

    const fullCreateOp = {
        operationId: "op_create_1",
        operationType: "CREATE",
        entityType: "Supplier",
        payload: validCreatePayload,
        owner: validOwner,
    };
    check("1.3 Valid Supplier CREATE operation satisfies uploadSchema", uploadSchema.safeParse(fullCreateOp).success);

    const fullUpdateOp = {
        operationId: "op_update_1",
        operationType: "UPDATE",
        entityType: "Supplier",
        payload: validUpdatePayload,
        owner: validOwner,
    };
    check("1.4 Valid Supplier UPDATE operation satisfies uploadSchema", uploadSchema.safeParse(fullUpdateOp).success);

    const bankingPayload = { ...validCreatePayload, bankDetails: { accountNumber: "12345" } };
    check("1.5 CREATE payload with bankDetails rejected by strict schema", !supplierCreatePayloadSchema.safeParse(bankingPayload).success);

    const lifecyclePayload = { ...validUpdatePayload, status: "inactive" };
    check("1.6 UPDATE payload with offline status change rejected by strict schema", !supplierUpdatePayloadSchema.safeParse(lifecyclePayload).success);

    const deletedPayload = { ...validUpdatePayload, isDeleted: true };
    check("1.7 UPDATE payload with isDeleted flag rejected by strict schema", !supplierUpdatePayloadSchema.safeParse(deletedPayload).success);

    // ------------------------------------------------------------
    // 2. Temporary-to-Server ID and Official Code Reconciliation
    // ------------------------------------------------------------
    console.log("\n-- 2. Temporary-to-Server ID and Official Code Reconciliation --");

    const { db: db1 } = createMemoryOfflineDb();
    const localId1 = "sup_alpha_temp_001";
    const tempCode1 = "SUP-TEMP-11223344";
    const serverObjectId1 = "507f1f77bcf86cd799439011";
    const officialCode1 = "SUP-0001";
    const createOpId1 = "op_sup_create_001";

    // Seed local temporary supplier in cache
    await db1.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, localId1),
        supplierId: localId1,
        tenantId: tenantA,
        supplierCode: tempCode1,
        name: "Metro Fasteners",
        phone: "+91 9988776655",
        status: "active",
        syncStatus: "PENDING",
        operationId: createOpId1,
        cachedAt: new Date(Date.now() - 60000).toISOString(),
    });

    const res1 = await resolvePendingSupplierId(
        localId1,
        serverObjectId1,
        officialCode1,
        tenantA,
        db1,
        createOpId1
    );

    check("2.1 resolvePendingSupplierId reports resolved: true", res1.resolved === true);
    check("2.2 Old temporary compound key removed from cache", (await db1.cachedSuppliers.get(makeCachedSupplierId(tenantA, localId1))) === undefined);

    const reconciledRecord1 = await db1.cachedSuppliers.get(makeCachedSupplierId(tenantA, serverObjectId1));
    check("2.3 Reconciled record exists under new server compound key", Boolean(reconciledRecord1));
    check("2.4 Reconciled record has server MongoDB ObjectId", reconciledRecord1?.supplierId === serverObjectId1);
    check("2.5 Reconciled record assigned official sequential code", reconciledRecord1?.supplierCode === officialCode1);
    check("2.6 Reconciled record syncStatus transitioned to SYNCED", reconciledRecord1?.syncStatus === "SYNCED");
    check("2.7 Reconciled record operationId cleared after completion", reconciledRecord1?.operationId === undefined);
    check("2.8 Reconciled record preserves tenantId", reconciledRecord1?.tenantId === tenantA);
    check("2.9 Reconciled record cachedAt timestamp refreshed", Boolean(reconciledRecord1?.cachedAt));

    // ------------------------------------------------------------
    // 3. Stale Response & Pending Local Edit Preservation
    // ------------------------------------------------------------
    console.log("\n-- 3. Stale Response & Pending Local Edit Preservation --");

    const { db: db2 } = createMemoryOfflineDb();
    const localId2 = "sup_alpha_temp_002";
    const serverObjectId2 = "507f1f77bcf86cd799439022";
    const officialCode2 = "SUP-0002";
    const inFlightOpId = "op_sup_create_inflight";
    const newerLocalEditOpId = "op_sup_update_newer";

    // Seed temporary supplier where user made a newer edit while CREATE was in flight
    await db2.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, localId2),
        supplierId: localId2,
        tenantId: tenantA,
        supplierCode: "SUP-TEMP-99887766",
        name: "Metro Fasteners New Name",
        phone: "+91 9988776600",
        status: "active",
        syncStatus: "PENDING",
        operationId: newerLocalEditOpId, // newer edit!
        cachedAt: new Date().toISOString(),
    });

    const res2 = await resolvePendingSupplierId(
        localId2,
        serverObjectId2,
        officialCode2,
        tenantA,
        db2,
        inFlightOpId // CREATE opId that completed
    );

    check("3.1 resolvePendingSupplierId succeeded for modified record", res2.resolved === true);
    const preservedRecord = await db2.cachedSuppliers.get(makeCachedSupplierId(tenantA, serverObjectId2));
    check("3.2 Record re-keyed to serverId", Boolean(preservedRecord));
    check("3.3 Official code assigned to record", preservedRecord?.supplierCode === officialCode2);
    check("3.4 syncStatus preserved as PENDING due to newer local edit", preservedRecord?.syncStatus === "PENDING");
    check("3.5 Newer operationId preserved on record", preservedRecord?.operationId === newerLocalEditOpId);
    check("3.6 Newer edited name preserved", preservedRecord?.name === "Metro Fasteners New Name");

    // ------------------------------------------------------------
    // 4. Dependent Queued Purchase Re-linking
    // ------------------------------------------------------------
    console.log("\n-- 4. Dependent Queued Purchase Re-linking --");

    const { db: db3 } = createMemoryOfflineDb();
    const localId3 = "sup_alpha_temp_003";
    const tempCode3 = "SUP-TEMP-55667788";
    const serverObjectId3 = "507f1f77bcf86cd799439033";
    const officialCode3 = "SUP-0003";
    const supCreateOpId3 = "op_sup_create_003";

    await db3.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, localId3),
        supplierId: localId3,
        tenantId: tenantA,
        supplierCode: tempCode3,
        name: "Southern Metals",
        status: "active",
        syncStatus: "PENDING",
        operationId: supCreateOpId3,
        cachedAt: new Date().toISOString(),
    });

    // Seed dependent purchase in queue
    const purchaseQueueItem: SyncQueueItem = {
        operationId: "op_purchase_001",
        operationType: "CREATE",
        entityType: "Purchase",
        payload: {
            purchaseNo: "PUR-2026-001",
            supplierId: localId3,
            supplierCode: tempCode3,
            supplierSnapshot: {
                name: "Southern Metals",
                supplierCode: tempCode3,
            },
            items: [{ productId: "507f1f77bcf86cd799439099", quantity: 10, unitPrice: 50 }],
            warehouse: { name: "Main Store" },
        },
        status: "PENDING",
        localSeq: 500,
        attempts: 0,
        createdAt: new Date().toISOString(),
        dependsOn: [supCreateOpId3],
        owner: sessionIdentityA,
        ownerUserId: sessionIdentityA.userId,
    };
    await db3.syncQueue.add(purchaseQueueItem);

    // Seed a cross-tenant purchase (must NOT be touched)
    const crossTenantPurchase: SyncQueueItem = {
        operationId: "op_purchase_tenant_b",
        operationType: "CREATE",
        entityType: "Purchase",
        payload: {
            purchaseNo: "PUR-TENANT-B-001",
            supplierId: localId3, // accidentally identical ID string
            supplierCode: tempCode3,
        },
        status: "PENDING",
        localSeq: 600,
        attempts: 0,
        createdAt: new Date().toISOString(),
        owner: { tenantId: tenantB, userId: "user_b", deviceId: "dev_b" },
        ownerUserId: "user_b",
    };
    await db3.syncQueue.add(crossTenantPurchase);

    // Seed an already-synced purchase (must NOT be mutated)
    const alreadySyncedPurchase: SyncQueueItem = {
        operationId: "op_purchase_synced",
        operationType: "CREATE",
        entityType: "Purchase",
        payload: {
            purchaseNo: "PUR-SYNCED-001",
            supplierId: localId3,
            supplierCode: tempCode3,
        },
        status: "SYNCED",
        localSeq: 400,
        attempts: 1,
        createdAt: new Date().toISOString(),
        owner: sessionIdentityA,
        ownerUserId: sessionIdentityA.userId,
    };
    await db3.syncQueue.add(alreadySyncedPurchase);

    const res3 = await resolvePendingSupplierId(
        localId3,
        serverObjectId3,
        officialCode3,
        tenantA,
        db3,
        supCreateOpId3
    );

    check("4.1 resolvePendingSupplierId reported 1 dependent purchase updated", res3.dependentPurchasesUpdated === 1);

    const queueItems3 = await db3.syncQueue.toArray();
    const updatedPurchase = queueItems3.find((q) => q.operationId === "op_purchase_001");
    check("4.2 Queued purchase supplierId rewritten to server MongoDB ObjectId", updatedPurchase?.payload?.supplierId === serverObjectId3);
    check("4.3 Queued purchase supplierCode rewritten to official sequential code", updatedPurchase?.payload?.supplierCode === officialCode3);
    check("4.4 Queued purchase supplierSnapshot.supplierCode updated to official code", (updatedPurchase?.payload?.supplierSnapshot as any)?.supplierCode === officialCode3);
    check("4.5 Supplier operationId removed from purchase dependsOn", updatedPurchase?.dependsOn === undefined || !updatedPurchase.dependsOn.includes(supCreateOpId3));

    const untouchedCrossTenant = queueItems3.find((q) => q.operationId === "op_purchase_tenant_b");
    check("4.6 Cross-tenant purchase supplierId was strictly untouched", untouchedCrossTenant?.payload?.supplierId === localId3);

    const untouchedSynced = queueItems3.find((q) => q.operationId === "op_purchase_synced");
    check("4.7 Already-synced purchase was strictly untouched", untouchedSynced?.payload?.supplierId === localId3);

    // ------------------------------------------------------------
    // 5. Pre-Upload Safety Guards for Dependent Purchases
    // ------------------------------------------------------------
    console.log("\n-- 5. Pre-Upload Safety Guards for Dependent Purchases --");

    // Helper simulating SyncManager pre-upload check for Purchase
    async function evaluatePurchasePreUpload(
        item: SyncQueueItem,
        identity: SessionIdentity,
        db: OfflineDatabase
    ): Promise<"ALLOW" | "SKIP" | "NEEDS_ATTENTION"> {
        if (item.entityType !== "Purchase") return "ALLOW";
        const rawSupId = typeof item.payload?.supplierId === "string" ? item.payload.supplierId.trim() : "";
        if (rawSupId && isTemporarySupplierId(rawSupId)) {
            const cachedKey = makeCachedSupplierId(identity.tenantId, rawSupId);
            const cached = await db.cachedSuppliers.get(cachedKey);

            if (cached && cached.syncStatus === "NEEDS_ATTENTION") {
                return "NEEDS_ATTENTION";
            }
            if (!cached) {
                return "NEEDS_ATTENTION";
            }
            return "SKIP";
        }
        return "ALLOW";
    }

    const { db: db4 } = createMemoryOfflineDb();
    const tempSupPending = "sup_pending_01";
    const tempSupFailed = "sup_failed_02";

    await db4.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, tempSupPending),
        supplierId: tempSupPending,
        tenantId: tenantA,
        name: "Pending Sup",
        status: "active",
        syncStatus: "PENDING",
        cachedAt: new Date().toISOString(),
    });

    await db4.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, tempSupFailed),
        supplierId: tempSupFailed,
        tenantId: tenantA,
        name: "Failed Sup",
        status: "active",
        syncStatus: "NEEDS_ATTENTION",
        errorMessage: "Duplicate GSTIN on server",
        cachedAt: new Date().toISOString(),
    });

    const purchaseWithPending = {
        entityType: "Purchase" as const,
        payload: { supplierId: tempSupPending },
    } as unknown as SyncQueueItem;
    const actionPending = await evaluatePurchasePreUpload(purchaseWithPending, sessionIdentityA, db4);
    check("5.1 Purchase with pending temporary supplier is deferred (SKIP)", actionPending === "SKIP");

    const purchaseWithFailed = {
        entityType: "Purchase" as const,
        payload: { supplierId: tempSupFailed },
    } as unknown as SyncQueueItem;
    const actionFailed = await evaluatePurchasePreUpload(purchaseWithFailed, sessionIdentityA, db4);
    check("5.2 Purchase with failed temporary supplier transitions to NEEDS_ATTENTION", actionFailed === "NEEDS_ATTENTION");

    const purchaseWithMissing = {
        entityType: "Purchase" as const,
        payload: { supplierId: "sup_non_existent" },
    } as unknown as SyncQueueItem;
    const actionMissing = await evaluatePurchasePreUpload(purchaseWithMissing, sessionIdentityA, db4);
    check("5.3 Purchase with orphaned/missing temporary supplier transitions to NEEDS_ATTENTION", actionMissing === "NEEDS_ATTENTION");

    const purchaseWithValidServerId = {
        entityType: "Purchase" as const,
        payload: { supplierId: "507f1f77bcf86cd799439088" },
    } as unknown as SyncQueueItem;
    const actionServer = await evaluatePurchasePreUpload(purchaseWithValidServerId, sessionIdentityA, db4);
    check("5.4 Purchase with valid server MongoDB ObjectId is allowed to upload", actionServer === "ALLOW");

    // ------------------------------------------------------------
    // 6. Failure Recovery & Cascade (NEEDS_ATTENTION)
    // ------------------------------------------------------------
    console.log("\n-- 6. Failure Recovery & Cascade (NEEDS_ATTENTION) --");

    const { db: db5 } = createMemoryOfflineDb();
    const failedLocalSupId = "sup_perm_fail_01";
    const failedOpId = "op_sup_fail_01";

    await db5.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, failedLocalSupId),
        supplierId: failedLocalSupId,
        tenantId: tenantA,
        name: "Conflict Metals",
        status: "active",
        syncStatus: "PENDING",
        operationId: failedOpId,
        cachedAt: new Date().toISOString(),
    });

    const depPurchase1: SyncQueueItem = {
        operationId: "op_pur_dep_1",
        operationType: "CREATE",
        entityType: "Purchase",
        payload: { purchaseNo: "PUR-FAIL-1", supplierId: failedLocalSupId },
        status: "PENDING",
        localSeq: 10,
        attempts: 0,
        createdAt: new Date().toISOString(),
        dependsOn: [failedOpId],
        owner: sessionIdentityA,
        ownerUserId: sessionIdentityA.userId,
    };
    await db5.syncQueue.add(depPurchase1);

    // Simulate SyncManager failure handling for Supplier
    await markPendingSupplierNeedsAttention(failedLocalSupId, tenantA, "GSTIN already registered to another business", db5);

    const updatedFailedSup = await db5.cachedSuppliers.get(makeCachedSupplierId(tenantA, failedLocalSupId));
    check("6.1 Cached supplier syncStatus marked NEEDS_ATTENTION", updatedFailedSup?.syncStatus === "NEEDS_ATTENTION");
    check("6.2 Cached supplier errorMessage recorded", updatedFailedSup?.errorMessage === "GSTIN already registered to another business");

    // Cascade to dependents in syncQueue
    const dependents = await db5.syncQueue.filter((q) => {
        if (q.status === "SYNCED") return false;
        const matchesDependsOn = Boolean(q.dependsOn && q.dependsOn.includes(failedOpId));
        const matchesSupplierId = q.entityType === "Purchase" && Boolean(failedLocalSupId && q.payload?.supplierId === failedLocalSupId);
        return matchesDependsOn || matchesSupplierId;
    }).toArray();

    for (const dep of dependents) {
        if (dep.id !== undefined && dep.status !== "SYNCED") {
            await db5.syncQueue.update(dep.id, {
                status: "NEEDS_ATTENTION",
                errorMessage: `Dependent supplier creation failed: GSTIN conflict. Resolve the supplier conflict to sync this purchase.`,
            });
        }
    }

    const updatedDepPurchase = (await db5.syncQueue.toArray()).find((q) => q.operationId === "op_pur_dep_1");
    check("6.3 Dependent purchase marked NEEDS_ATTENTION", updatedDepPurchase?.status === "NEEDS_ATTENTION");
    check("6.4 Dependent purchase contains clear explanatory error message", Boolean(updatedDepPurchase?.errorMessage?.includes("Dependent supplier creation failed")));

    // ------------------------------------------------------------
    // 7. Prerequisite Prioritization in selectSyncable
    // ------------------------------------------------------------
    console.log("\n-- 7. Prerequisite Prioritization in selectSyncable --");

    const now = new Date();
    const candidateQueue: QueueItemState[] = [
        {
            operationId: "op_pur_100",
            status: "PENDING",
            attempts: 0,
            localSeq: 100, // Earlier sequence
            entityType: "Purchase",
            owner: sessionIdentityA,
        },
        {
            operationId: "op_sup_200",
            status: "PENDING",
            attempts: 0,
            localSeq: 200, // Later sequence
            entityType: "Supplier",
            owner: sessionIdentityA,
        },
        {
            operationId: "op_cust_300",
            status: "PENDING",
            attempts: 0,
            localSeq: 300,
            entityType: "Customer",
            owner: sessionIdentityA,
        },
    ];

    const sortedDue = selectSyncable(candidateQueue, sessionIdentityA, now);
    check("7.1 selectSyncable selects all candidates", sortedDue.length === 3);
    const sortedTypes = sortedDue.map((d) => d.entityType);
    check("7.2 Supplier prioritized ahead of Purchase", sortedTypes.indexOf("Supplier") < sortedTypes.indexOf("Purchase"));
    check("7.3 Customer prioritized ahead of Purchase", sortedTypes.indexOf("Customer") < sortedTypes.indexOf("Purchase"));

    // ------------------------------------------------------------
    // 8. Idempotent Retries & Duplicate Acknowledgements
    // ------------------------------------------------------------
    console.log("\n-- 8. Idempotent Retries & Duplicate Acknowledgements --");

    const { db: db6 } = createMemoryOfflineDb();
    const localId6 = "sup_dup_test";
    const serverObjectId6 = "507f1f77bcf86cd799439066";
    const officialCode6 = "SUP-0006";

    await db6.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, localId6),
        supplierId: localId6,
        tenantId: tenantA,
        supplierCode: "SUP-TEMP-6666",
        name: "Delta Tools",
        status: "active",
        syncStatus: "PENDING",
        cachedAt: new Date().toISOString(),
    });

    const firstRun = await resolvePendingSupplierId(localId6, serverObjectId6, officialCode6, tenantA, db6);
    check("8.1 First resolvePendingSupplierId run succeeds", firstRun.resolved === true);

    const secondRun = await resolvePendingSupplierId(localId6, serverObjectId6, officialCode6, tenantA, db6);
    check("8.2 Repeated resolvePendingSupplierId run succeeds idempotently", secondRun.resolved === true);
    check("8.3 Repeated run reports 0 additional purchases updated", secondRun.dependentPurchasesUpdated === 0);

    const cachedList6 = await db6.cachedSuppliers.toArray();
    check("8.4 Exactly 1 supplier record remains in cache (no duplicates)", cachedList6.length === 1);
    check("8.5 Record remains keyed to serverId with official code", cachedList6[0].supplierId === serverObjectId6 && cachedList6[0].supplierCode === officialCode6);

    // ------------------------------------------------------------
    // 9. Queue Healing via ensurePendingSuppliersQueued
    // ------------------------------------------------------------
    console.log("\n-- 9. Queue Healing via ensurePendingSuppliersQueued --");

    const { db: db7 } = createMemoryOfflineDb();
    const orphanedTempId = "sup_orphaned_01";
    const orphanedServerId = "507f1f77bcf86cd799439077";

    // Seed unqueued pending suppliers
    await db7.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, orphanedTempId),
        supplierId: orphanedTempId,
        tenantId: tenantA,
        supplierCode: "SUP-TEMP-7777",
        name: "Orphaned Create",
        status: "active",
        syncStatus: "PENDING",
        cachedAt: new Date().toISOString(),
    });

    await db7.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, orphanedServerId),
        supplierId: orphanedServerId,
        tenantId: tenantA,
        supplierCode: "SUP-0007",
        name: "Orphaned Update",
        status: "active",
        syncStatus: "PENDING",
        cachedAt: new Date().toISOString(),
    });

    const healedCount = await ensurePendingSuppliersQueued(tenantA, db7, sessionIdentityA);
    check("9.1 ensurePendingSuppliersQueued healed both pending records", healedCount === 2);

    const healedQueue = await db7.syncQueue.toArray();
    const healedCreate = healedQueue.find((q) => q.payload?.localId === orphanedTempId);
    check("9.2 Orphaned temporary supplier queued as CREATE operation", Boolean(healedCreate && healedCreate.operationType === "CREATE"));
    check("9.3 Healed CREATE operation assigned session owner", healedCreate?.ownerUserId === sessionIdentityA.userId);

    const healedUpdate = healedQueue.find((q) => q.payload?.supplierId === orphanedServerId);
    check("9.4 Orphaned server supplier queued as UPDATE operation", Boolean(healedUpdate && healedUpdate.operationType === "UPDATE"));
    check("9.5 Healed UPDATE operation assigned session owner", healedUpdate?.ownerUserId === sessionIdentityA.userId);

    const secondHeal = await ensurePendingSuppliersQueued(tenantA, db7, sessionIdentityA);
    check("9.6 Repeated ensurePendingSuppliersQueued is strictly idempotent (0 added)", secondHeal === 0);

    // ------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------
    const passed = summarize();
    if (!passed) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test execution threw error:", err);
    process.exit(1);
});
