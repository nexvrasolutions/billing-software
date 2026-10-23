/*
 * POS Offline Sale Queueing & Error Handling Tests
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER).
 *
 * Validates Stage 6A Fix A:
 * 1. Network failure with valid offline identity & permission -> queues into offline queue (offline_queued).
 * 2. Network failure with missing identity -> returns clear queue_failed reason ("Please sign in online...").
 * 3. Network failure with expired offline session -> returns clear queue_failed reason ("The offline session has expired...").
 * 4. Network failure with missing offline permission -> returns clear queue_failed reason ("This account is not allowed...").
 * 5. Network failure with clock rollback -> returns clear queue_failed reason ("The device clock appears to have moved backwards...").
 * 6. Network failure with disk quota exceeded -> returns clear queue_failed reason ("...the browser's storage is full...").
 * 7. HTTP 4xx business/validation errors -> rejected with server error message, NEVER queued.
 * 8. HTTP 403 permission denied -> rejected with server message, NEVER queued.
 * 9. Server 5xx error with valid offline session -> queues into offline queue (server_error_queued).
 * 10. Server 5xx error when queueing fails -> returns clear queue_failed reason.
 * 11. Online success (201) -> returns online_saved with invoice ID, NEVER queued.
 *
 * Run:
 *   npx tsx scripts/test-pos-offline-queue.ts
 */

import { submitPosSale, type PosSaleSubmitOutcome } from "../components/pos/pos-screen";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function mockResponse(status: number, body: Record<string, unknown>): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

const sampleSalePayload = {
    invoiceNo: "POS-1792054774-TEST1",
    warehouse: { name: "Main Store" },
    items: [
        {
            productId: "6ac898efbdd27fd9f705701a",
            quantity: 1,
            unitPrice: 100,
            taxRate: 18,
        },
    ],
    paidAmount: 118,
    paymentMethod: "cash",
    saleDate: new Date().toISOString(),
};

async function main() {
    console.log("=== STAGE 6A: POS OFFLINE SALE QUEUEING TESTS ===\n");

    // ------------------------------------------------------------
    // 1. GENUINE NETWORK FAILURES
    // ------------------------------------------------------------
    console.log("-- 1. Genuine Network Failures (Fetch Throws) --");

    // A1. Valid offline session & permissions: queued successfully
    let queueCalls = 0;
    let queuedPayload: Record<string, unknown> | null = null;

    const netFailFetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const successEnqueue = async (item: { payload: Record<string, unknown> }) => {
        queueCalls++;
        queuedPayload = item.payload;
        return { id: 101, operationId: "op-uuid-101" };
    };

    const resA1 = await submitPosSale(sampleSalePayload, {
        fetchFn: netFailFetch as unknown as typeof fetch,
        addToSyncQueueFn: successEnqueue as unknown as any,
    });

    check("A1. Network failure with valid offline session queues into offline queue",
        resA1.outcome === "offline_queued" && queueCalls === 1 && queuedPayload !== null
    );
    check("A2. Queued outcome gives clear reassuring offline message to cashier",
        resA1.outcome === "offline_queued" && resA1.message.includes("Offline bill saved locally to IndexedDB queue")
    );

    // A3. Missing identity: queueing rejected
    const missingIdentityEnqueue = async () => {
        throw new Error("Please sign in online at least once before working offline");
    };

    const resA3 = await submitPosSale(sampleSalePayload, {
        fetchFn: netFailFetch as unknown as typeof fetch,
        addToSyncQueueFn: missingIdentityEnqueue as unknown as any,
    });

    check("A3. Missing remembered identity fails queueing with clear cashier reason",
        resA3.outcome === "queue_failed" &&
        resA3.message === "The sale was NOT saved: Please sign in online at least once before working offline"
    );

    // A4. Expired offline session (> 72h): queueing rejected
    const expiredSessionEnqueue = async () => {
        throw new Error("The offline session has expired; sign in online to continue");
    };

    const resA4 = await submitPosSale(sampleSalePayload, {
        fetchFn: netFailFetch as unknown as typeof fetch,
        addToSyncQueueFn: expiredSessionEnqueue as unknown as any,
    });

    check("A4. Expired offline session fails queueing with clear cashier reason",
        resA4.outcome === "queue_failed" &&
        resA4.message === "The sale was NOT saved: The offline session has expired; sign in online to continue"
    );

    // A5. Missing sales.create permission: queueing rejected
    const noPermissionEnqueue = async () => {
        throw new Error("This account is not allowed to record sales offline");
    };

    const resA5 = await submitPosSale(sampleSalePayload, {
        fetchFn: netFailFetch as unknown as typeof fetch,
        addToSyncQueueFn: noPermissionEnqueue as unknown as any,
    });

    check("A5. Missing sales.create permission fails queueing with clear cashier reason",
        resA5.outcome === "queue_failed" &&
        resA5.message === "The sale was NOT saved: This account is not allowed to record sales offline"
    );

    // A6. Clock rollback suspected: queueing rejected
    const clockRollbackEnqueue = async () => {
        throw new Error("The device clock appears to have moved backwards; sign in online to continue");
    };

    const resA6 = await submitPosSale(sampleSalePayload, {
        fetchFn: netFailFetch as unknown as typeof fetch,
        addToSyncQueueFn: clockRollbackEnqueue as unknown as any,
    });

    check("A6. Clock rollback fails queueing with clear cashier reason",
        resA6.outcome === "queue_failed" &&
        resA6.message === "The sale was NOT saved: The device clock appears to have moved backwards; sign in online to continue"
    );

    // A7. Storage quota exceeded (disk full): queueing rejected with quota message
    const quotaErrorEnqueue = async () => {
        const err = Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
        throw err;
    };

    const resA7 = await submitPosSale(sampleSalePayload, {
        fetchFn: netFailFetch as unknown as typeof fetch,
        addToSyncQueueFn: quotaErrorEnqueue as unknown as any,
    });

    check("A7. Storage quota error warns cashier that browser disk storage is full",
        resA7.outcome === "queue_failed" &&
        resA7.message.includes("browser's storage is full")
    );

    // ------------------------------------------------------------
    // 2. HTTP 4XX BUSINESS & VALIDATION REJECTIONS (NEVER QUEUED)
    // ------------------------------------------------------------
    console.log("\n-- 2. HTTP 4xx Business Errors (Must Never Queue) --");

    let illegalQueueCalls = 0;
    const forbidEnqueue = async () => {
        illegalQueueCalls++;
        return { id: 999, operationId: "bad-op" };
    };

    // B1. HTTP 400 Bad Request
    const fetch400 = () => Promise.resolve(mockResponse(400, { success: false, message: "Invalid product ID" }));
    const resB1 = await submitPosSale(sampleSalePayload, {
        fetchFn: fetch400 as unknown as typeof fetch,
        addToSyncQueueFn: forbidEnqueue as unknown as any,
    });

    check("B1. HTTP 400 validation error is rejected and NOT queued",
        resB1.outcome === "rejected_by_server" &&
        resB1.message === "Invalid product ID" &&
        illegalQueueCalls === 0
    );

    // B2. HTTP 403 Permission Denied
    const fetch403 = () => Promise.resolve(mockResponse(403, { success: false, message: "Permission denied for sales.create" }));
    const resB2 = await submitPosSale(sampleSalePayload, {
        fetchFn: fetch403 as unknown as typeof fetch,
        addToSyncQueueFn: forbidEnqueue as unknown as any,
    });

    check("B2. HTTP 403 permission error is rejected and NOT queued",
        resB2.outcome === "rejected_by_server" &&
        resB2.message === "Permission denied for sales.create" &&
        illegalQueueCalls === 0
    );

    // B3. HTTP 409 Conflict
    const fetch409 = () => Promise.resolve(mockResponse(409, { success: false, message: "Invoice already exists" }));
    const resB3 = await submitPosSale(sampleSalePayload, {
        fetchFn: fetch409 as unknown as typeof fetch,
        addToSyncQueueFn: forbidEnqueue as unknown as any,
    });

    check("B3. HTTP 409 conflict error is rejected and NOT queued",
        resB3.outcome === "rejected_by_server" &&
        resB3.message === "Invoice already exists" &&
        illegalQueueCalls === 0
    );

    // ------------------------------------------------------------
    // 3. SERVER 5XX ERRORS
    // ------------------------------------------------------------
    console.log("\n-- 3. Server 5xx Errors (Temporary Server Failure) --");

    let server5xxQueueCalls = 0;
    const server5xxEnqueue = async () => {
        server5xxQueueCalls++;
        return { id: 202, operationId: "op-uuid-202" };
    };

    const fetch503 = () => Promise.resolve(mockResponse(503, { message: "Database temporarily unreachable" }));
    const resC1 = await submitPosSale(sampleSalePayload, {
        fetchFn: fetch503 as unknown as typeof fetch,
        addToSyncQueueFn: server5xxEnqueue as unknown as any,
    });

    check("C1. Server 503 error queues bill locally for later synchronization",
        resC1.outcome === "server_error_queued" &&
        server5xxQueueCalls === 1 &&
        resC1.message.includes("Server temporarily unreachable. Bill saved locally to IndexedDB queue.")
    );

    // C2. Server 500 error when offline queue fails
    const resC2 = await submitPosSale(sampleSalePayload, {
        fetchFn: fetch503 as unknown as typeof fetch,
        addToSyncQueueFn: expiredSessionEnqueue as unknown as any,
    });

    check("C2. Server 500 error reports queue failure reason if local queue fails",
        resC2.outcome === "queue_failed" &&
        resC2.message.includes("The offline session has expired")
    );

    // ------------------------------------------------------------
    // 4. ONLINE SUCCESS (201)
    // ------------------------------------------------------------
    console.log("\n-- 4. Online Success --");

    let successQueueCalls = 0;
    const fetch201 = () => Promise.resolve(mockResponse(201, {
        success: true,
        sale: { _id: "6ac898efbdd27fd9f705701a" },
    }));

    const resD1 = await submitPosSale(sampleSalePayload, {
        fetchFn: fetch201 as unknown as typeof fetch,
        addToSyncQueueFn: (async () => { successQueueCalls++; }) as unknown as any,
    });

    check("D1. Online successful sale returns online_saved and is NOT queued",
        resD1.outcome === "online_saved" &&
        resD1.invoiceId === "6ac898efbdd27fd9f705701a" &&
        successQueueCalls === 0
    );

    // ------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }

    process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error("Test execution failed:", err);
    process.exitCode = 1;
});
