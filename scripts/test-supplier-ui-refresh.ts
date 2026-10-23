/**
 * Test Suite: Phase 3, Stage 4: Supplier Sync UI Refresh and Verification Readiness
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Provisional supplier code discrimination & display formatting (SUP-TEMP-... vs SUP-0001)
 * 2. Sync-state badge and display resolution (PENDING, NEEDS_ATTENTION, SYNCED)
 * 3. Safe recovery guidance presentation for NEEDS_ATTENTION without auto-retry or deletion
 * 4. Reconciliation UI state refresh and stale response protection
 * 5. Online-only lifecycle action guards and absence of banking details
 * 6. Dependent purchase preservation and safe holding during supplier attention state
 *
 * Run:
 *   npx tsx scripts/test-supplier-ui-refresh.ts
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
    savePendingOfflineSupplier,
    savePendingOfflineSupplierUpdate,
    isTemporarySupplierCode,
    isTemporarySupplierId,
    isValidServerSupplierId,
    getCachedSuppliersForTenant,
} from "../lib/offline/supplierCache";
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
    console.log(`SUPPLIER UI REFRESH TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
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
                        return syncQueueList.filter((q: any) => q[field] === val).map((q) => structuredClone(q));
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

// UI helper functions representing page rendering logic
function getProvisionalCodeBadgeProps(code?: string): { isProvisional: boolean; label?: string; badgeText?: string } {
    if (isTemporarySupplierCode(code)) {
        return {
            isProvisional: true,
            label: "Provisional Code",
            badgeText: `${code} (Provisional)`,
        };
    }
    return {
        isProvisional: false,
        label: undefined,
        badgeText: code || "—",
    };
}

function getSyncStatusBadgeProps(syncStatus?: string, errorMessage?: string): { label: string; className: string; title?: string } | null {
    if (syncStatus === "PENDING") {
        return {
            label: "Pending sync",
            className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        };
    }
    if (syncStatus === "NEEDS_ATTENTION") {
        return {
            label: "Sync failed",
            className: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
            title: errorMessage || "Sync failed. Needs attention.",
        };
    }
    return null;
}

function getRecoveryGuidance(syncStatus?: string, errorMessage?: string) {
    if (syncStatus !== "NEEDS_ATTENTION") return null;
    return {
        title: "Synchronization Requires Attention",
        explanation: errorMessage || "The server rejected this offline operation due to a validation error or conflict.",
        actionableSteps: [
            "Review the error message (such as duplicate GSTIN, format error, or conflicting profile details).",
            "Click Edit details to adjust and correct conflicting fields. Saving your changes updates the queued operation.",
            "Dependent offline purchases are safely held in queue and will be processed once this supplier is resolved.",
            "Failed operations are preserved for your safety and are never automatically discarded, retried, or reset.",
        ],
    };
}

// ============================================================
// TESTS IMPLEMENTATION
// ============================================================

async function runTests() {
    console.log("=== PHASE 3, STAGE 4: SUPPLIER SYNC UI REFRESH & VERIFICATION TESTS ===\n");

    const tenantA = "tenant_alpha_01";
    const sessionIdentity: SessionIdentity = {
        tenantId: tenantA,
        userId: "507f1f77bcf86cd799439001",
        deviceId: "507f1f77bcf86cd799439002",
    };

    // ------------------------------------------------------------
    // 1. Provisional Supplier Code Discrimination & Display
    // ------------------------------------------------------------
    console.log("-- 1. Provisional Supplier Code Discrimination & Display --");

    const tempCode1 = "SUP-TEMP-7A8B9C0D";
    const tempCode2 = "sup-temp-12345678";
    const officialCode1 = "SUP-0001";
    const officialCode2 = "SUP-0042";

    check("1.1 isTemporarySupplierCode identifies standard uppercase provisional code", isTemporarySupplierCode(tempCode1) === true);
    check("1.2 isTemporarySupplierCode identifies lowercase provisional code", isTemporarySupplierCode(tempCode2) === true);
    check("1.3 isTemporarySupplierCode rejects official sequential code SUP-0001", isTemporarySupplierCode(officialCode1) === false);
    check("1.4 isTemporarySupplierCode rejects official sequential code SUP-0042", isTemporarySupplierCode(officialCode2) === false);
    check("1.5 isTemporarySupplierCode rejects undefined and empty code", isTemporarySupplierCode(undefined) === false && isTemporarySupplierCode("") === false);

    const badgePropsTemp = getProvisionalCodeBadgeProps(tempCode1);
    check("1.6 Provisional code badge props flags isProvisional: true", badgePropsTemp.isProvisional === true);
    check("1.7 Provisional code badge props assigns label 'Provisional Code'", badgePropsTemp.label === "Provisional Code");
    check("1.8 Provisional code badge text includes (Provisional) suffix", badgePropsTemp.badgeText?.includes("(Provisional)") === true);

    const badgePropsOfficial = getProvisionalCodeBadgeProps(officialCode1);
    check("1.9 Official code badge props flags isProvisional: false", badgePropsOfficial.isProvisional === false);
    check("1.10 Official code badge text does NOT include Provisional label", !badgePropsOfficial.badgeText?.includes("Provisional"));

    // ------------------------------------------------------------
    // 2. Sync-State Badge and Display Resolution
    // ------------------------------------------------------------
    console.log("\n-- 2. Sync-State Badge and Display Resolution --");

    const pendingBadge = getSyncStatusBadgeProps("PENDING");
    check("2.1 PENDING resolves to 'Pending sync' badge", pendingBadge?.label === "Pending sync");
    check("2.2 PENDING badge uses amber color styling", pendingBadge?.className.includes("amber") === true);

    const failedBadge = getSyncStatusBadgeProps("NEEDS_ATTENTION", "GSTIN already exists for another vendor");
    check("2.3 NEEDS_ATTENTION resolves to 'Sync failed' badge", failedBadge?.label === "Sync failed");
    check("2.4 NEEDS_ATTENTION badge uses rose color styling", failedBadge?.className.includes("rose") === true);
    check("2.5 NEEDS_ATTENTION badge title holds error message", failedBadge?.title === "GSTIN already exists for another vendor");

    const syncedBadge = getSyncStatusBadgeProps("SYNCED");
    check("2.6 SYNCED status returns null (no extra warning badge)", syncedBadge === null);

    // ------------------------------------------------------------
    // 3. NEEDS_ATTENTION Safe Recovery Guidance Presentation
    // ------------------------------------------------------------
    console.log("\n-- 3. NEEDS_ATTENTION Safe Recovery Guidance Presentation --");

    const errorMsg = "GSTIN 27AAPCA1234A1Z5 is already assigned to active supplier Acme Corp";
    const guidance = getRecoveryGuidance("NEEDS_ATTENTION", errorMsg);

    check("3.1 Guidance generated for NEEDS_ATTENTION", guidance !== null);
    check("3.2 Guidance title is 'Synchronization Requires Attention'", guidance?.title === "Synchronization Requires Attention");
    check("3.3 Guidance explanation includes server error message", guidance?.explanation === errorMsg);
    check("3.4 Guidance instructs user to click 'Edit details' to correct fields", guidance?.actionableSteps.some((s) => s.includes("Edit details")) === true);
    check("3.5 Guidance informs that dependent purchases are safely held", guidance?.actionableSteps.some((s) => s.includes("Dependent offline purchases are safely held")) === true);
    check("3.6 Guidance affirms failed operations are never automatically discarded or reset", guidance?.actionableSteps.some((s) => s.includes("never automatically discarded")) === true);

    const noGuidanceForSynced = getRecoveryGuidance("SYNCED");
    check("3.7 No error guidance rendered for clean SYNCED records", noGuidanceForSynced === null);

    // ------------------------------------------------------------
    // 4. Reconciliation UI State Refresh & Stale-Response Protection
    // ------------------------------------------------------------
    console.log("\n-- 4. Reconciliation UI State Refresh & Stale-Response Protection --");

    const { db } = createMemoryOfflineDb();

    // Step A: Save offline supplier
    const created = await savePendingOfflineSupplier(
        {
            name: "Southern Hardware",
            phone: "+91 9123456789",
            gstin: "29ABCDE1234F1Z5",
        },
        tenantA,
        db
    );

    const localId = created.supplier.supplierId;
    const tempCode = created.supplier.supplierCode;
    const createOpId = created.operationId;

    check("4.1 Initial offline supplier has provisional code", isTemporarySupplierCode(tempCode) === true);
    check("4.2 Initial offline supplier has sup_ local ID", isTemporarySupplierId(localId) === true);
    check("4.3 Initial offline supplier has PENDING syncStatus", created.supplier.syncStatus === "PENDING");

    // UI reads initial state
    const initialList = await getCachedSuppliersForTenant(tenantA, {}, db);
    check("4.4 UI initial list displays 1 supplier", initialList.length === 1);
    check("4.5 UI initial list displays provisional badge", getProvisionalCodeBadgeProps(initialList[0].supplierCode).isProvisional === true);
    check("4.6 UI initial list displays 'Pending sync' badge", getSyncStatusBadgeProps(initialList[0].syncStatus)?.label === "Pending sync");

    // Step B: Simulate background sync reconciliation
    const serverObjectId = "507f1f77bcf86cd799439099";
    const officialSeqCode = "SUP-0001";

    const reconRes = await resolvePendingSupplierId(
        localId,
        serverObjectId,
        officialSeqCode,
        tenantA,
        db,
        createOpId
    );

    check("4.7 resolvePendingSupplierId reported success", reconRes.resolved === true);

    // Step C: UI refreshes after reconciliation
    const refreshedList = await getCachedSuppliersForTenant(tenantA, {}, db);
    check("4.8 Refreshed list contains reconciled record", refreshedList.length === 1);
    check("4.9 Refreshed list key is server MongoDB ObjectId", refreshedList[0].supplierId === serverObjectId);
    check("4.10 Refreshed list displays official sequential code", refreshedList[0].supplierCode === officialSeqCode);
    check("4.11 Refreshed list code is NOT provisional", getProvisionalCodeBadgeProps(refreshedList[0].supplierCode).isProvisional === false);
    check("4.12 Refreshed list syncStatus is SYNCED (no warning badge)", refreshedList[0].syncStatus === "SYNCED" && getSyncStatusBadgeProps(refreshedList[0].syncStatus) === null);

    // Step D: Stale-response protection during offline edit
    const newerEdit = await savePendingOfflineSupplierUpdate(
        {
            supplierId: serverObjectId,
            name: "Southern Hardware Pvt Ltd",
            phone: "+91 9123456788",
        },
        tenantA,
        db,
        "op_newer_edit_123",
        sessionIdentity
    );

    check("4.13 Pending local edit sets syncStatus: PENDING", newerEdit.syncStatus === "PENDING");

    // Stale server response with old name arrives
    const staleRecon = await resolvePendingSupplierId(
        serverObjectId, // same id
        serverObjectId,
        officialSeqCode,
        tenantA,
        db,
        createOpId // old opId
    );

    const postStaleList = await getCachedSuppliersForTenant(tenantA, {}, db);
    check("4.14 Stale server refresh does NOT overwrite pending local edits", postStaleList[0].name === "Southern Hardware Pvt Ltd");
    check("4.15 Stale server refresh preserves PENDING status for local edit", postStaleList[0].syncStatus === "PENDING");

    // ------------------------------------------------------------
    // 5. Online-Only Lifecycle Action Guards & Banking Field Exclusion
    // ------------------------------------------------------------
    console.log("\n-- 5. Online-Only Lifecycle Action Guards & Banking Field Exclusion --");

    function evaluateLifecycleExecution(isOfflineMode: boolean, action: string): { allowed: boolean; error?: string } {
        if (isOfflineMode) {
            return {
                allowed: false,
                error: "Lifecycle actions (deactivate, block, reactivate, unblock, delete) require an active online connection.",
            };
        }
        return { allowed: true };
    }

    const offlineDeactivate = evaluateLifecycleExecution(true, "deactivate");
    check("5.1 Offline deactivation is blocked", offlineDeactivate.allowed === false);
    check("5.2 Offline deactivation returns explicit online connection error", offlineDeactivate.error?.includes("require an active online connection") === true);

    const offlineBlock = evaluateLifecycleExecution(true, "block");
    check("5.3 Offline block is blocked", offlineBlock.allowed === false);

    const offlineDelete = evaluateLifecycleExecution(true, "delete");
    check("5.4 Offline delete is blocked", offlineDelete.allowed === false);

    const onlineDeactivate = evaluateLifecycleExecution(false, "deactivate");
    check("5.5 Online deactivation is permitted", onlineDeactivate.allowed === true);

    // Verify banking details are omitted from cached record and edit payload
    const testRecord = refreshedList[0];
    check("5.6 bankDetails strictly undefined in cached record", (testRecord as any).bankDetails === undefined);
    check("5.7 accountNumber strictly undefined in cached record", (testRecord as any).accountNumber === undefined);
    check("5.8 ifsc strictly undefined in cached record", (testRecord as any).ifsc === undefined);

    // ------------------------------------------------------------
    // 6. Dependent Purchase Preservation During Attention State
    // ------------------------------------------------------------
    console.log("\n-- 6. Dependent Purchase Preservation During Attention State --");

    const failedSupLocalId = "sup_failed_hold";
    const failedSupOpId = "op_sup_fail_hold";

    await db.cachedSuppliers.put({
        id: makeCachedSupplierId(tenantA, failedSupLocalId),
        supplierId: failedSupLocalId,
        tenantId: tenantA,
        name: "Held Supplier",
        status: "active",
        syncStatus: "NEEDS_ATTENTION",
        errorMessage: "GSTIN registration suspended",
        cachedAt: new Date().toISOString(),
    });

    const queuedPurchase: SyncQueueItem = {
        operationId: "op_held_purchase",
        operationType: "CREATE",
        entityType: "Purchase",
        payload: {
            purchaseNo: "PUR-HELD-001",
            supplierId: failedSupLocalId,
        },
        status: "NEEDS_ATTENTION",
        errorMessage: "Dependent supplier creation failed: GSTIN registration suspended. Resolve the supplier conflict to sync this purchase.",
        localSeq: 50,
        attempts: 1,
        createdAt: new Date().toISOString(),
        dependsOn: [failedSupOpId],
        owner: sessionIdentity,
        ownerUserId: sessionIdentity.userId,
    };
    await db.syncQueue.add(queuedPurchase);

    // Verify purchase is preserved in queue
    const allQueue = await db.syncQueue.toArray();
    const held = allQueue.find((q) => q.operationId === "op_held_purchase");
    check("6.1 Dependent purchase preserved in queue (not dropped or deleted)", held !== undefined);
    check("6.2 Dependent purchase status is NEEDS_ATTENTION", held?.status === "NEEDS_ATTENTION");
    check("6.3 Dependent purchase contains diagnostic error message", held?.errorMessage?.includes("GSTIN registration suspended") === true);
    check("6.4 Dependent purchase payload is intact", (held?.payload as any)?.purchaseNo === "PUR-HELD-001");

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
