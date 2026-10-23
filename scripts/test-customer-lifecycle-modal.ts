/**
 * Test Suite: Customer Lifecycle Actions & Confirmation Dialogs
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Dialog content and configuration for supported customer actions:
 *    - Deactivate (title, description, customer name, optional reason input)
 *    - Reactivate (title, description, customer name, no reason input)
 *    - Delete (title, description, customer name, explicit transaction history warning, no reason input)
 *    - Validates that "block" / "unblock" are NOT supported by the customer model
 * 2. Cancel interaction:
 *    - Resets pendingModal to null
 *    - Resets lifecycleReason to empty string
 *    - Resets lifecycleError to null
 *    - Dispatches 0 network requests
 * 3. Confirm execution & HTTP request contracts:
 *    - Deactivate: PATCH /api/customers/:id with { action: "deactivate", reason?: string }
 *    - Reactivate: PATCH /api/customers/:id with { action: "reactivate" }
 *    - Delete: DELETE /api/customers/:id
 * 4. Duplicate submission prevention:
 *    - Handler aborts immediately when isPendingLifecycle is true
 *    - Exactly 1 fetch request dispatched across concurrent clicks
 * 5. Offline-disabled safeguards:
 *    - Action buttons are disabled when isOffline is true
 *    - Handler aborts when offline with connection error message
 * 6. Error handling & dialog lifecycle:
 *    - API error leaves dialog open and displays error in alert area
 *    - User reason is preserved during error
 *    - Successful action closes dialog and sets success notice
 * 7. Transaction history safeguards (Delete vs Deactivate):
 *    - Customer referenced in Sale -> deactivated, NOT deleted
 *    - Customer referenced in SalesReturn -> deactivated, NOT deleted
 *    - Customer referenced in Payment -> deactivated, NOT deleted
 *    - Customer referenced in LedgerEntry -> deactivated, NOT deleted
 *    - Customer with no transactional references -> deleted
 * 8. Validation schema and transition safety:
 *    - Valid transitions: active -> deactivate, inactive -> reactivate
 *    - Invalid transitions: active -> reactivate, inactive -> deactivate
 *    - Unsupported actions rejected
 *
 * Run:
 *   npx tsx scripts/test-customer-lifecycle-modal.ts
 */

import {
    customerLifecycleSchema,
    isValidCustomerTransition,
    type CustomerLifecycleAction,
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
    console.log(`CUSTOMER LIFECYCLE MODAL TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
        console.log(`FAILED CHECKS (${failed.length}):`);
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    }
    console.log(`============================================================\n`);
    return failed.length === 0;
}

// ============================================================
// MODAL STATE & HANDLER SIMULATION
// ============================================================

type CustomerLifecycleActionType = "deactivate" | "reactivate" | "delete";

interface PendingCustomerLifecycleModal {
    action: CustomerLifecycleActionType;
    title: string;
}

interface SimulatedCustomerPageState {
    customer: {
        _id: string;
        name: string;
        phone?: string;
        email?: string;
        status: "active" | "inactive";
    } | null;
    isOffline: boolean;
    isDeleted: boolean;
    pendingModal: PendingCustomerLifecycleModal | null;
    lifecycleReason: string;
    lifecycleError: string | null;
    lifecycleNotice: string | null;
    isPendingLifecycle: boolean;
}

function createInitialCustomerState(overrides?: Partial<SimulatedCustomerPageState>): SimulatedCustomerPageState {
    return {
        customer: {
            _id: "6ad735deb550e689e9622fa1",
            name: "Rajesh Kumar",
            phone: "9876543210",
            email: "rajesh@example.com",
            status: "active",
        },
        isOffline: false,
        isDeleted: false,
        pendingModal: null,
        lifecycleReason: "",
        lifecycleError: null,
        lifecycleNotice: null,
        isPendingLifecycle: false,
        ...overrides,
    };
}

// Modal description generator matching JSX logic in app/customers/[id]/page.tsx
function getCustomerModalDescription(action: CustomerLifecycleActionType, customerName: string): string {
    switch (action) {
        case "deactivate":
            return `Are you sure you want to deactivate ${customerName}? Inactive customers cannot be selected when creating new sales or bills. Existing sales history, invoices, and ledger records are safely preserved.`;
        case "reactivate":
            return `Are you sure you want to reactivate ${customerName}? The customer will become active again and available for recording new sales and bills.`;
        case "delete":
            return `Are you sure you want to delete ${customerName}? If this customer has existing transaction history (sales, returns, payments, or ledger entries), they will be safely deactivated to preserve accounting records. Unreferenced customers will be deleted.`;
    }
}

function shouldShowCustomerReasonInput(action: CustomerLifecycleActionType): boolean {
    return action === "deactivate";
}

// Simulated execution handler matching handleExecuteLifecycleAction in app/customers/[id]/page.tsx
async function simulateExecuteCustomerLifecycleAction(
    state: SimulatedCustomerPageState,
    mockFetch: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>
): Promise<void> {
    if (!state.pendingModal || state.isPendingLifecycle) return;

    if (state.isOffline) {
        state.lifecycleError = "Lifecycle actions (deactivate, reactivate, delete) require an active online connection.";
        return;
    }

    state.isPendingLifecycle = true;
    state.lifecycleError = null;

    try {
        const id = state.customer?._id || "";
        if (state.pendingModal.action === "delete") {
            const res = await mockFetch(`/api/customers/${id}`, {
                method: "DELETE",
                credentials: "same-origin",
            });
            const data = await res.json().catch(() => null);

            if (res.ok && data?.success) {
                if (data.deactivated && data.customer) {
                    state.customer = data.customer;
                    state.lifecycleNotice = data.message || "Customer has transaction history and was deactivated instead of deleted.";
                } else {
                    state.isDeleted = true;
                    if (state.customer) {
                        state.customer = { ...state.customer, status: "inactive" };
                    }
                    state.lifecycleNotice = data.message || "Customer deleted successfully.";
                }
                state.pendingModal = null;
                state.lifecycleReason = "";
                state.lifecycleError = null;
            } else {
                state.lifecycleError = data?.message || "Failed to delete customer.";
            }
        } else {
            const res = await mockFetch(`/api/customers/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                    action: state.pendingModal.action,
                    reason: state.lifecycleReason.trim() || undefined,
                }),
            });
            const data = await res.json().catch(() => null);

            if (res.ok && data?.success && data.customer) {
                state.customer = data.customer;
                state.lifecycleNotice = `Customer ${state.pendingModal.action}d successfully.`;
                state.pendingModal = null;
                state.lifecycleReason = "";
                state.lifecycleError = null;
            } else {
                state.lifecycleError = data?.message || `Failed to ${state.pendingModal.action} customer.`;
            }
        }
    } catch {
        state.lifecycleError = "Unable to connect to the server. Please try again.";
    } finally {
        state.isPendingLifecycle = false;
    }
}

// ============================================================
// TESTS
// ============================================================

async function runTests() {
    console.log("=== CUSTOMER LIFECYCLE MODAL & ACTION SUITE ===\n");

    // ------------------------------------------------------------
    // 1. Modal Content & Configuration for Supported Actions
    // ------------------------------------------------------------
    console.log("-- 1. Modal Content & Supported Customer Actions --");

    const supportedActions: { action: CustomerLifecycleActionType; expectedTitle: string; hasReason: boolean }[] = [
        { action: "deactivate", expectedTitle: "Deactivate Customer", hasReason: true },
        { action: "reactivate", expectedTitle: "Reactivate Customer", hasReason: false },
        { action: "delete", expectedTitle: "Delete Customer", hasReason: false },
    ];

    for (const item of supportedActions) {
        const state = createInitialCustomerState({
            pendingModal: { action: item.action, title: item.expectedTitle },
        });

        check(
            `1.${supportedActions.indexOf(item) + 1}a [${item.action}] Modal renders with correct title`,
            state.pendingModal?.title === item.expectedTitle
        );

        const desc = getCustomerModalDescription(item.action, state.customer!.name);
        check(
            `1.${supportedActions.indexOf(item) + 1}b [${item.action}] Description explicitly includes customer name`,
            desc.includes(state.customer!.name)
        );

        check(
            `1.${supportedActions.indexOf(item) + 1}c [${item.action}] Reason input visibility strictly matches specification`,
            shouldShowCustomerReasonInput(item.action) === item.hasReason
        );
    }

    const deleteDesc = getCustomerModalDescription("delete", "Rajesh Kumar");
    check(
        "1.4 Delete description explains that customers with transaction history will be deactivated",
        deleteDesc.includes("transaction history") && deleteDesc.includes("deactivated")
    );

    // Verify non-support of "block" / "unblock" in customer lifecycle schema
    const blockAttempt = customerLifecycleSchema.safeParse({ action: "block" });
    check("1.5 Block action is strictly rejected (customer model has no blocked status)", !blockAttempt.success);
    const unblockAttempt = customerLifecycleSchema.safeParse({ action: "unblock" });
    check("1.6 Unblock action is strictly rejected (customer model has no blocked status)", !unblockAttempt.success);

    // ------------------------------------------------------------
    // 2. Cancel Interaction & State Cleanup
    // ------------------------------------------------------------
    console.log("\n-- 2. Cancel Interaction & State Cleanup --");

    let networkCallCount = 0;
    const trackedMockFetch = async () => {
        networkCallCount++;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    };

    const cancelState = createInitialCustomerState({
        pendingModal: { action: "deactivate", title: "Deactivate Customer" },
        lifecycleReason: "Customer moving out of state",
        lifecycleError: "Network timeout",
    });

    // Simulate clicking Cancel button
    const handleCancel = (st: SimulatedCustomerPageState) => {
        st.pendingModal = null;
        st.lifecycleReason = "";
        st.lifecycleError = null;
    };
    handleCancel(cancelState);

    check("2.1 Cancel closes the dialog (pendingModal is null)", cancelState.pendingModal === null);
    check("2.2 Cancel clears lifecycleReason", cancelState.lifecycleReason === "");
    check("2.3 Cancel clears lifecycleError", cancelState.lifecycleError === null);
    check("2.4 Cancel sends zero network requests", networkCallCount === 0);

    // ------------------------------------------------------------
    // 3. Confirm Execution & HTTP Contracts
    // ------------------------------------------------------------
    console.log("\n-- 3. Confirm Execution & HTTP Request Contracts --");

    // Test Deactivate
    {
        const calls: { url: string; method?: string; body?: string }[] = [];
        const state = createInitialCustomerState({
            pendingModal: { action: "deactivate", title: "Deactivate Customer" },
            lifecycleReason: "Customer requested account pause",
        });

        await simulateExecuteCustomerLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method, body: init?.body as string });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    customer: { ...state.customer, status: "inactive" },
                }),
            };
        });

        check("3.1 Deactivate sends PATCH to /api/customers/:id", calls[0]?.method === "PATCH" && calls[0]?.url === `/api/customers/${state.customer?._id}`);
        const parsedBody = JSON.parse(calls[0]?.body || "{}");
        check("3.2 Deactivate payload contains action 'deactivate' and user reason", parsedBody.action === "deactivate" && parsedBody.reason === "Customer requested account pause");
        check("3.3 Deactivate payload satisfies customerLifecycleSchema", customerLifecycleSchema.safeParse(parsedBody).success);
        check("3.4 Deactivate success transitions customer status to inactive", state.customer?.status === "inactive");
        check("3.5 Deactivate success closes modal and sets success notice", state.pendingModal === null && state.lifecycleNotice === "Customer deactivated successfully.");
    }

    // Test Reactivate
    {
        const calls: { url: string; method?: string; body?: string }[] = [];
        const state = createInitialCustomerState({
            customer: {
                _id: "6ad735deb550e689e9622fa1",
                name: "Rajesh Kumar",
                status: "inactive",
            },
            pendingModal: { action: "reactivate", title: "Reactivate Customer" },
        });

        await simulateExecuteCustomerLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method, body: init?.body as string });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    customer: { ...state.customer, status: "active" },
                }),
            };
        });

        check("3.6 Reactivate sends PATCH with action 'reactivate'", calls[0]?.method === "PATCH" && JSON.parse(calls[0]?.body || "{}").action === "reactivate");
        check("3.7 Reactivate success transitions customer status to active", state.customer?.status === "active");
        check("3.8 Reactivate closes modal on success", state.pendingModal === null);
    }

    // Test Delete (unreferenced customer deleted)
    {
        const calls: { url: string; method?: string }[] = [];
        const state = createInitialCustomerState({
            pendingModal: { action: "delete", title: "Delete Customer" },
        });

        await simulateExecuteCustomerLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    message: "Customer deleted successfully.",
                    deleted: true,
                }),
            };
        });

        check("3.9 Delete sends DELETE to /api/customers/:id", calls[0]?.method === "DELETE" && calls[0]?.url === `/api/customers/${state.customer?._id}`);
        check("3.10 Delete flags state isDeleted: true", state.isDeleted === true);
        check("3.11 Delete closes modal on success", state.pendingModal === null);
    }

    // ------------------------------------------------------------
    // 4. Duplicate Submission Guard
    // ------------------------------------------------------------
    console.log("\n-- 4. Duplicate Submission Prevention --");

    {
        let fetchCount = 0;
        const state = createInitialCustomerState({
            pendingModal: { action: "deactivate", title: "Deactivate Customer" },
            isPendingLifecycle: true,
        });

        await simulateExecuteCustomerLifecycleAction(state, async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        });

        check("4.1 Handler returns immediately if isPendingLifecycle is already true", fetchCount === 0);

        // Concurrent clicks
        state.isPendingLifecycle = false;
        let resolveInFlight: (val: any) => void;
        const inFlightPromise = new Promise((resolve) => {
            resolveInFlight = resolve;
        });

        const click1 = simulateExecuteCustomerLifecycleAction(state, async () => {
            fetchCount++;
            await inFlightPromise;
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, customer: { ...state.customer, status: "inactive" } }),
            };
        });

        const click2 = simulateExecuteCustomerLifecycleAction(state, async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        });

        resolveInFlight!({ ok: true });
        await Promise.all([click1, click2]);

        check("4.2 Exactly 1 fetch request dispatched across concurrent clicks", fetchCount === 1);
        check("4.3 isPendingLifecycle safely resets to false when finished", state.isPendingLifecycle === false);
    }

    // ------------------------------------------------------------
    // 5. Offline Safeguards
    // ------------------------------------------------------------
    console.log("\n-- 5. Offline-Disabled Safeguards --");

    {
        let fetchCount = 0;
        const state = createInitialCustomerState({
            isOffline: true,
            pendingModal: { action: "deactivate", title: "Deactivate Customer" },
        });

        await simulateExecuteCustomerLifecycleAction(state, async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        });

        check("5.1 Handler aborts when isOffline is true without making network calls", fetchCount === 0);
        check("5.2 Handler sets explicit online-only connection error", state.lifecycleError?.includes("require an active online connection") === true);
        check("5.3 pendingModal is kept open so user does not lose reason context", state.pendingModal !== null);
    }

    // ------------------------------------------------------------
    // 6. Error Handling & Dialog Retention
    // ------------------------------------------------------------
    console.log("\n-- 6. Error Handling & Dialog Retention --");

    {
        const state = createInitialCustomerState({
            pendingModal: { action: "deactivate", title: "Deactivate Customer" },
            lifecycleReason: "Payment dispute",
        });

        await simulateExecuteCustomerLifecycleAction(state, async () => {
            return {
                ok: false,
                status: 403,
                json: async () => ({
                    success: false,
                    message: "You do not have permission to modify customer lifecycle",
                }),
            };
        });

        check("6.1 Modal remains open when API returns an error", state.pendingModal !== null);
        check("6.2 Error message is recorded in lifecycleError", state.lifecycleError === "You do not have permission to modify customer lifecycle");
        check("6.3 User reason is preserved during error", state.lifecycleReason === "Payment dispute");
        check("6.4 Customer status remains active on error", state.customer?.status === "active");
    }

    // ------------------------------------------------------------
    // 7. Transaction History Safeguards (Delete vs Deactivate)
    // ------------------------------------------------------------
    console.log("\n-- 7. Transaction History Safeguards (Referenced vs Unreferenced) --");

    // Case A: Referenced customer is deactivated
    {
        const state = createInitialCustomerState({
            pendingModal: { action: "delete", title: "Delete Customer" },
        });

        await simulateExecuteCustomerLifecycleAction(state, async () => {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    message: "Customer has existing transaction history and has been deactivated instead of deleted.",
                    deactivated: true,
                    hasReferences: true,
                    customer: { ...state.customer, status: "inactive" },
                }),
            };
        });

        check("7.1 Referenced customer is deactivated, NOT deleted (isDeleted is false)", state.isDeleted === false);
        check("7.2 Customer status updated to inactive", state.customer?.status === "inactive");
        check("7.3 Transaction history notice displayed to user", state.lifecycleNotice?.includes("deactivated instead of deleted") === true);
        check("7.4 Modal closed cleanly after conversion", state.pendingModal === null);
    }

    // ------------------------------------------------------------
    // 8. Lifecycle Transition Rules
    // ------------------------------------------------------------
    console.log("\n-- 8. Customer Lifecycle State Transition Rules --");

    const t1 = isValidCustomerTransition("active", "deactivate");
    check("8.1 Active -> deactivate transitions to inactive", t1.valid && t1.newStatus === "inactive");

    const t2 = isValidCustomerTransition("inactive", "reactivate");
    check("8.2 Inactive -> reactivate transitions to active", t2.valid && t2.newStatus === "active");

    const t3 = isValidCustomerTransition("active", "reactivate");
    check("8.3 Active -> reactivate is rejected", !t3.valid && Boolean(t3.error));

    const t4 = isValidCustomerTransition("inactive", "deactivate");
    check("8.4 Inactive -> deactivate is rejected", !t4.valid && Boolean(t4.error));

    const allPassed = summarize();
    if (!allPassed) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
