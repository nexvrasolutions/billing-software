/*
 * Database-free unit tests for Server-Side Maintenance Write-Pause Mechanism.
 *
 * Validates:
 * 1. Configuration switch (disabled by default, enabled via env flags, case/whitespace insensitive).
 * 2. Response shape and contract (HTTP 503, Retry-After header, MAINTENANCE_PAUSED code, retryable flag).
 * 3. SyncProcessError constructor and serialization contract.
 * 4. Route decision logic and scope isolation:
 *    - Rejects Purchase creations and Purchase sync uploads/processing when enabled.
 *    - Allows non-Purchase entities (Sales, Customers, Suppliers, Products) unhindered when enabled.
 *    - Allows all operations through when disabled.
 * 5. Offline client retry policy (interpretResponse, stateAfterFailure, queue retention):
 *    - 503 MAINTENANCE_PAUSED is treated as retryable.
 *    - Queued operations remain in IndexedDB with status "FAILED" and nextAttemptAt set.
 *    - Items are NEVER deleted or marked "NEEDS_ATTENTION" prematurely.
 *    - Once pause is lifted, retried operation successfully transitions to "SYNCED".
 * 6. Defense-in-depth in PurchaseService:
 *    - Direct invocation throws maintenance error when enabled.
 * 7. Security and secrecy invariants:
 *    - Responses never log or leak customer payloads, credentials, or secrets.
 *
 * Run:
 *   npx tsx scripts/test-server-write-pause.ts
 */

import {
    isPurchaseWritePaused,
    createMaintenancePausedResponse,
    createMaintenancePausedError,
    MaintenancePausedError,
    isMaintenancePausedError,
    MAINTENANCE_PAUSED_CODE,
    DEFAULT_RETRY_AFTER_SECONDS,
    DEFAULT_PURCHASE_PAUSED_MESSAGE,
    DEFAULT_PURCHASE_SYNC_UPLOAD_PAUSED_MESSAGE,
    DEFAULT_PURCHASE_SYNC_PROCESS_PAUSED_MESSAGE,
} from "../lib/config/writePause";

import {
    interpretResponse,
    stateAfterFailure,
    decideAfterOutcome,
    type QueueItemState,
    MAX_CLIENT_ATTEMPTS,
} from "../lib/offline/syncPolicy";

import {
    SyncProcessError,
    classifySyncError,
    statusAfterFailure,
} from "../lib/services/SyncErrors";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n============================================================`);
    console.log(`WRITE-PAUSE TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    console.log(`============================================================`);
    if (failed.length > 0) {
        console.log("\nFailed checks:");
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    return failed.length === 0;
}

async function main() {
    console.log("=== SERVER-SIDE WRITE-PAUSE MECHANISM (DATABASE-FREE TESTS) ===\n");

    // ============================================================
    // 1. CONFIGURATION SWITCH INVARIANTS
    // ============================================================
    console.log("-- 1. Configuration Switch Invariants --");

    // 1.1 Disabled by default with empty/undefined env
    check("1.1. Disabled by default with empty env", !isPurchaseWritePaused({}));
    check("1.2. Disabled when PURCHASE_WRITES_PAUSED is undefined",
        !isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: undefined }));
    check("1.3. Disabled when PURCHASE_WRITES_PAUSED is false",
        !isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "false" }));
    check("1.4. Disabled when PURCHASE_WRITES_PAUSED is random string",
        !isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "off" }));

    // 1.5 Enabled explicitly via PURCHASE_WRITES_PAUSED
    check("1.5. Enabled when PURCHASE_WRITES_PAUSED is 'true'",
        isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "true" }));
    check("1.6. Enabled when PURCHASE_WRITES_PAUSED has whitespace '  true  '",
        isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "  true  " }));
    check("1.7. Enabled when PURCHASE_WRITES_PAUSED is uppercase 'TRUE'",
        isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "TRUE" }));
    check("1.8. Enabled when PURCHASE_WRITES_PAUSED is '1'",
        isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "1" }));
    check("1.9. Enabled when PURCHASE_WRITES_PAUSED is 'yes'",
        isPurchaseWritePaused({ PURCHASE_WRITES_PAUSED: "yes" }));

    // 1.10 Enabled via fallback MAINTENANCE_PAUSED
    check("1.10. Enabled when MAINTENANCE_PAUSED is 'true'",
        isPurchaseWritePaused({ MAINTENANCE_PAUSED: "true" }));

    // ============================================================
    // 2. RESPONSE SHAPE & CONTRACT FOR DIRECT API ROUTES
    // ============================================================
    console.log("\n-- 2. Response Shape & Contract (Direct Routes) --");

    const defaultResponse = createMaintenancePausedResponse();
    check("2.1. Response status is strictly HTTP 503", defaultResponse.status === 503);
    check("2.2. Response header Retry-After is '30'", defaultResponse.headers.get("Retry-After") === "30");
    check("2.3. Response header Cache-Control is 'no-store'", defaultResponse.headers.get("Cache-Control") === "no-store");

    const bodyDefault = await defaultResponse.json();
    check("2.4. Response body success is false", bodyDefault.success === false);
    check("2.5. Response body code is 'MAINTENANCE_PAUSED'", bodyDefault.code === MAINTENANCE_PAUSED_CODE);
    check("2.6. Response body retryable is true", bodyDefault.retryable === true);
    check("2.7. Response body retryAfterSeconds is 30", bodyDefault.retryAfterSeconds === DEFAULT_RETRY_AFTER_SECONDS);
    check("2.8. Response body default message is clear", bodyDefault.message === DEFAULT_PURCHASE_PAUSED_MESSAGE);

    // Custom message and custom delay override
    const customResponse = createMaintenancePausedResponse("Custom maintenance message", 60);
    const bodyCustom = await customResponse.json();
    check("2.9. Custom message is preserved", bodyCustom.message === "Custom maintenance message");
    check("2.10. Custom retryAfterSeconds overrides default in body", bodyCustom.retryAfterSeconds === 60);
    check("2.11. Custom retryAfterSeconds overrides default in Retry-After header",
        customResponse.headers.get("Retry-After") === "60");

    // ============================================================
    // 3. TYPED MAINTENANCE ERROR & CLASSIFIER CONTRACT
    // ============================================================
    console.log("\n-- 3. Typed Maintenance Error & Classifier Contract --");

    const syncError = createMaintenancePausedError();
    check("3.1. Error is instance of SyncProcessError", syncError instanceof SyncProcessError);
    check("3.2. Error is instance of MaintenancePausedError", syncError instanceof MaintenancePausedError);
    check("3.3. Error httpStatus is 503", syncError.httpStatus === 503);
    check("3.4. Error code is 'MAINTENANCE_PAUSED'", syncError.code === "MAINTENANCE_PAUSED");
    check("3.5. Error retryable is true", syncError.retryable === true);
    check("3.6. Error retryAfterSeconds is 30", syncError.retryAfterSeconds === 30);
    check("3.7. Error default message matches sync process advisory",
        syncError.message === DEFAULT_PURCHASE_SYNC_PROCESS_PAUSED_MESSAGE);

    const jsonError = syncError.toJSON();
    check("3.8. toJSON() produces expected client payload",
        jsonError.success === false &&
        jsonError.code === "MAINTENANCE_PAUSED" &&
        jsonError.retryable === true &&
        jsonError.retryAfterSeconds === 30);

    // 3.9 Type guard isMaintenancePausedError
    check("3.9. isMaintenancePausedError recognizes MaintenancePausedError",
        isMaintenancePausedError(syncError));
    check("3.10. isMaintenancePausedError recognizes SyncProcessError with MAINTENANCE_PAUSED code",
        isMaintenancePausedError(new SyncProcessError(503, "MAINTENANCE_PAUSED", "msg", true)));
    check("3.11. isMaintenancePausedError recognizes plain object with code MAINTENANCE_PAUSED",
        isMaintenancePausedError({ code: "MAINTENANCE_PAUSED" }));
    check("3.12. isMaintenancePausedError rejects standard validation Error",
        !isMaintenancePausedError(new Error("Standard validation error")));
    check("3.13. isMaintenancePausedError rejects PERMANENT_FAILURE error",
        !isMaintenancePausedError(new SyncProcessError(422, "PERMANENT_FAILURE", "msg", false)));

    // 3.14 classifySyncError
    check("3.14. classifySyncError classifies MaintenancePausedError as RETRYABLE",
        classifySyncError(syncError) === "RETRYABLE");
    check("3.15. classifySyncError classifies plain Error as PERMANENT (baseline intact)",
        classifySyncError(new Error("Uncaught business validation error")) === "PERMANENT");

    // 3.16 statusAfterFailure with maintenance flag
    const maintStatus = statusAfterFailure("RETRYABLE", 8, true);
    check("3.16. statusAfterFailure with isMaintenance preserves FAILED at attempt 8 (NOT NEEDS_ATTENTION)",
        maintStatus.status === "FAILED" && maintStatus.failureKind === "RETRYABLE");
    const nonMaintStatus = statusAfterFailure("RETRYABLE", 8, false);
    check("3.17. statusAfterFailure without isMaintenance escalates to RETRIES_EXHAUSTED at attempt 8",
        nonMaintStatus.status === "NEEDS_ATTENTION" && nonMaintStatus.failureKind === "RETRIES_EXHAUSTED");

    // ============================================================
    // 4. ROUTE DECISION LOGIC & SCOPE ISOLATION (NON-PURCHASE ENTITIES)
    // ============================================================
    console.log("\n-- 4. Route Decision Logic & Scope Isolation --");

    // Helper simulating /api/sync-operations upload routing decision
    function simulateSyncUploadGate(entityType: string, env: Record<string, string | undefined>): {
        allowed: boolean;
        response?: { status: number; code: string };
    } {
        if (entityType === "Purchase" && isPurchaseWritePaused(env)) {
            return {
                allowed: false,
                response: { status: 503, code: MAINTENANCE_PAUSED_CODE },
            };
        }
        return { allowed: true };
    }

    const pausedEnv = { PURCHASE_WRITES_PAUSED: "true" };
    const unpausedEnv = { PURCHASE_WRITES_PAUSED: "false" };

    // When paused:
    check("4.1. When paused: Purchase upload is BLOCKED with 503 MAINTENANCE_PAUSED",
        !simulateSyncUploadGate("Purchase", pausedEnv).allowed &&
        simulateSyncUploadGate("Purchase", pausedEnv).response?.status === 503);

    check("4.2. When paused: Sale upload is ALLOWED (unaffected)",
        simulateSyncUploadGate("Sale", pausedEnv).allowed);

    check("4.3. When paused: Customer upload is ALLOWED (unaffected)",
        simulateSyncUploadGate("Customer", pausedEnv).allowed);

    check("4.4. When paused: Supplier upload is ALLOWED (unaffected)",
        simulateSyncUploadGate("Supplier", pausedEnv).allowed);

    check("4.5. When paused: Product upload is ALLOWED (unaffected)",
        simulateSyncUploadGate("Product", pausedEnv).allowed);

    check("4.6. When paused: Payment upload is ALLOWED (unaffected)",
        simulateSyncUploadGate("Payment", pausedEnv).allowed);

    // When unpaused:
    check("4.7. When unpaused: Purchase upload is ALLOWED",
        simulateSyncUploadGate("Purchase", unpausedEnv).allowed);

    // Helper simulating SyncService.processOperation routing decision
    function simulateSyncProcessGate(entityType: string, env: Record<string, string | undefined>): {
        allowed: boolean;
        error?: SyncProcessError;
    } {
        if (entityType === "Purchase" && isPurchaseWritePaused(env)) {
            return {
                allowed: false,
                error: createMaintenancePausedError(),
            };
        }
        return { allowed: true };
    }

    check("4.8. When paused: Purchase sync process is BLOCKED with 503 SyncProcessError",
        !simulateSyncProcessGate("Purchase", pausedEnv).allowed &&
        simulateSyncProcessGate("Purchase", pausedEnv).error?.httpStatus === 503);

    check("4.9. When paused: Sale sync process is ALLOWED",
        simulateSyncProcessGate("Sale", pausedEnv).allowed);

    check("4.10. When paused: Customer sync process is ALLOWED",
        simulateSyncProcessGate("Customer", pausedEnv).allowed);

    check("4.11. When unpaused: Purchase sync process is ALLOWED",
        simulateSyncProcessGate("Purchase", unpausedEnv).allowed);

    // ============================================================
    // 5. OFFLINE CLIENT RETRY POLICY & QUEUE RETENTION
    // ============================================================
    console.log("\n-- 5. Offline Client Retry Policy & Queue Retention --");

    const maintenanceResponseBody = {
        success: false,
        code: "MAINTENANCE_PAUSED",
        retryable: true,
        message: DEFAULT_PURCHASE_PAUSED_MESSAGE,
        retryAfterSeconds: 30,
    };

    // 5.1 interpretResponse handles HTTP 503 with MAINTENANCE_PAUSED
    const outcome = interpretResponse(503, maintenanceResponseBody);
    check("5.1. interpretResponse returns kind 'retryable' for 503 MAINTENANCE_PAUSED",
        outcome.kind === "retryable");
    check("5.2. interpretResponse preserves retryAfterSeconds (30s)",
        outcome.kind === "retryable" && outcome.retryAfterSeconds === 30);

    // 5.2 stateAfterFailure schedules next attempt with Retry-After backoff
    const now = new Date("2026-10-21T12:00:00.000Z");
    const retryableOutcome = outcome.kind === "retryable" ? outcome : { kind: "retryable" as const, message: "Paused", retryAfterSeconds: 30 };
    const nextState = stateAfterFailure(retryableOutcome, 1, now, () => 0.5);

    check("5.3. stateAfterFailure sets status to 'FAILED' (NOT 'NEEDS_ATTENTION')",
        nextState.status === "FAILED");
    check("5.4. stateAfterFailure schedules nextAttemptAt at least 30s in future",
        Boolean(nextState.nextAttemptAt && new Date(nextState.nextAttemptAt).getTime() >= now.getTime() + 30_000));

    // 5.5 decideAfterOutcome retains the item in the queue
    const decision = decideAfterOutcome(outcome, 0, now, () => 0.5);
    check("5.5. decideAfterOutcome marks action 'failed' with status 'FAILED'",
        decision.action === "failed" && decision.status === "FAILED");
    check("5.6. Operation is NEVER marked 'synced' or permanently dropped",
        decision.action !== "synced");

    // 5.7 Simulate queue item lifecycle through maintenance pause and resumption
    const initialItem: QueueItemState = {
        status: "PENDING",
        attempts: 0,
        localSeq: 1,
        operationId: "OP-TEST-PURCHASE-1",
        entityType: "Purchase",
    };

    // Attempt 1: Encounter MAINTENANCE_PAUSED
    const decision1 = decideAfterOutcome(outcome, initialItem.attempts, now, () => 0.5);
    const updatedItem1: QueueItemState = {
        ...initialItem,
        status: decision1.action === "failed" ? decision1.status : "PENDING",
        attempts: decision1.action === "failed" ? decision1.attempts : initialItem.attempts,
        nextAttemptAt: decision1.action === "failed" ? decision1.nextAttemptAt : undefined,
    };
    check("5.7. In-flight item is retained in queue after 503 rejection (attempts: 0, status: FAILED)",
        updatedItem1.status === "FAILED" && updatedItem1.attempts === 0);

    // 5.8 Prolonged Maintenance: 12 consecutive 503 responses must NOT exhaust attempts or enter NEEDS_ATTENTION
    let prolongedItem: QueueItemState = { ...initialItem };
    let allProlongedRetriesScheduledSafely = true;
    for (let cycle = 1; cycle <= 12; cycle++) {
        const cycleTime = new Date(now.getTime() + cycle * 35_000);
        const cycleDecision = decideAfterOutcome(outcome, prolongedItem.attempts, cycleTime, () => 0.5);
        if (cycleDecision.action === "failed") {
            if (cycleDecision.status !== "FAILED") {
                allProlongedRetriesScheduledSafely = false;
            }
            if (!cycleDecision.nextAttemptAt || new Date(cycleDecision.nextAttemptAt).getTime() < cycleTime.getTime() + 30_000) {
                allProlongedRetriesScheduledSafely = false;
            }
            prolongedItem = {
                ...prolongedItem,
                status: cycleDecision.status,
                attempts: cycleDecision.attempts,
                nextAttemptAt: cycleDecision.nextAttemptAt,
            };
        } else {
            allProlongedRetriesScheduledSafely = false;
        }
    }
    check("5.8. Prolonged maintenance (12 retries) NEVER marks item NEEDS_ATTENTION",
        prolongedItem.status === "FAILED");
    check("5.9. Prolonged maintenance preserves attempts < MAX_CLIENT_ATTEMPTS",
        prolongedItem.attempts < MAX_CLIENT_ATTEMPTS);
    check("5.10. Prolonged maintenance always enforces minimum 30s delay (no hot loop)",
        allProlongedRetriesScheduledSafely);

    // 5.11 Contrast: Permanent error (422) immediately marks NEEDS_ATTENTION
    const permOutcome = interpretResponse(422, { success: false, code: "OPERATION_ID_CONFLICT", message: "Conflict" });
    const permDecision = decideAfterOutcome(permOutcome, 0, now);
    check("5.11. Permanent failure (422) immediately marks item NEEDS_ATTENTION",
        permDecision.action === "failed" && permDecision.status === "NEEDS_ATTENTION");

    // 5.12 Contrast: Generic retryable 500 errors eventually exhaust attempts at MAX_CLIENT_ATTEMPTS
    const generic500Outcome = interpretResponse(500, { success: false, message: "Internal Server Error" });
    let genericItem: QueueItemState = { ...initialItem };
    for (let c = 0; c < MAX_CLIENT_ATTEMPTS; c++) {
        const d = decideAfterOutcome(generic500Outcome, genericItem.attempts, now);
        genericItem = {
            ...genericItem,
            status: d.action === "failed" ? d.status : "PENDING",
            attempts: d.action === "failed" ? d.attempts : genericItem.attempts,
        };
    }
    check("5.12. Non-maintenance errors exhaust retry quota and enter NEEDS_ATTENTION at attempt 8",
        genericItem.status === "NEEDS_ATTENTION");

    // Resumption: Maintenance lifted, server responds 201 success
    const successOutcome = interpretResponse(201, { success: true, message: "Purchase created successfully" });
    const decision2 = decideAfterOutcome(successOutcome, prolongedItem.attempts, new Date(now.getTime() + 500_000));
    check("5.13. After maintenance window ends, retry transitions cleanly to 'synced'",
        decision2.action === "synced");

    // ============================================================
    // 6. DEFENSE-IN-DEPTH IN PURCHASESERVICE
    // ============================================================
    console.log("\n-- 6. Defense-in-Depth in PurchaseService --");

    const { PurchaseService } = await import("../lib/services/PurchaseService");
    const mongoose = (await import("mongoose")).default;

    // Set env to paused
    process.env.PURCHASE_WRITES_PAUSED = "true";
    let threwWhenPaused = false;
    let thrownErrorInstance: unknown = null;

    try {
        await PurchaseService.createPurchase(
            { userId: new mongoose.Types.ObjectId(), tenantId: new mongoose.Types.ObjectId() },
            { purchaseNo: "PO-MOCK", supplierId: new mongoose.Types.ObjectId().toString(), warehouse: { name: "Main" }, items: [] }
        );
    } catch (err: unknown) {
        threwWhenPaused = true;
        thrownErrorInstance = err;
    }

    check("6.1. PurchaseService.createPurchase throws error when PURCHASE_WRITES_PAUSED is true", threwWhenPaused);
    check("6.2. Thrown error is instance of MaintenancePausedError",
        thrownErrorInstance instanceof MaintenancePausedError);
    check("6.3. Thrown error satisfies isMaintenancePausedError type guard",
        isMaintenancePausedError(thrownErrorInstance));
    check("6.4. Thrown error is classified as RETRYABLE by classifySyncError",
        classifySyncError(thrownErrorInstance) === "RETRYABLE");

    // Reset env to unpaused
    process.env.PURCHASE_WRITES_PAUSED = "false";
    let threwPausedErrorWhenUnpaused = false;
    try {
        await PurchaseService.createPurchase(
            { userId: new mongoose.Types.ObjectId(), tenantId: new mongoose.Types.ObjectId() },
            { purchaseNo: "PO-MOCK", supplierId: new mongoose.Types.ObjectId().toString(), warehouse: { name: "Main" }, items: [] }
        );
    } catch (err: unknown) {
        // Will fail on item validation, not maintenance pause!
        threwPausedErrorWhenUnpaused = isMaintenancePausedError(err);
    }
    check("6.5. PurchaseService does NOT throw MAINTENANCE_PAUSED when unpaused", !threwPausedErrorWhenUnpaused);

    // Clean up env
    delete process.env.PURCHASE_WRITES_PAUSED;

    // ============================================================
    // 7. SECURITY & CREDENTIAL SANITIZATION
    // ============================================================
    console.log("\n-- 7. Security & Credential Sanitization --");

    check("7.1. Default response message contains no internal paths, hosts, or secrets",
        !DEFAULT_PURCHASE_PAUSED_MESSAGE.includes("mongodb") &&
        !DEFAULT_PURCHASE_PAUSED_MESSAGE.includes("Atlas") &&
        !DEFAULT_PURCHASE_PAUSED_MESSAGE.includes("billing_inventory"));

    check("7.2. Default sync upload message contains no internal secrets",
        !DEFAULT_PURCHASE_SYNC_UPLOAD_PAUSED_MESSAGE.includes("mongodb") &&
        !DEFAULT_PURCHASE_SYNC_UPLOAD_PAUSED_MESSAGE.includes("Atlas"));

    check("7.3. Default sync process message contains no internal secrets",
        !DEFAULT_PURCHASE_SYNC_PROCESS_PAUSED_MESSAGE.includes("mongodb") &&
        !DEFAULT_PURCHASE_SYNC_PROCESS_PAUSED_MESSAGE.includes("Atlas"));

    return summarize();
}

main().then((ok) => {
    process.exit(ok ? 0 : 1);
}).catch((err) => {
    console.error("Test execution error:", err);
    process.exit(1);
});
