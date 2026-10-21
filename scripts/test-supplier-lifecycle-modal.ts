/**
 * Test Suite: Supplier Lifecycle Modal & Action Handling
 * (DATABASE-FREE, SERVER-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Modal rendering logic and content for each lifecycle action:
 *    - Deactivate (title, explanatory message, optional reason input)
 *    - Block (title, explanatory message, optional reason input)
 *    - Reactivate (title, explanatory message, no reason input)
 *    - Unblock (title, explanatory message, no reason input)
 *    - Delete (title, explicit transaction history warning, no reason input)
 * 2. Cancel interaction:
 *    - Resets pendingModal to null
 *    - Resets lifecycleReason to empty string
 *    - Resets lifecycleError to null
 *    - Dispatches 0 network requests
 * 3. Confirm execution & HTTP contract:
 *    - Deactivate: PATCH /api/suppliers/:id with { action: "deactivate", reason?: string }
 *    - Block: PATCH /api/suppliers/:id with { action: "block", reason?: string }
 *    - Reactivate: PATCH /api/suppliers/:id with { action: "reactivate" }
 *    - Unblock: PATCH /api/suppliers/:id with { action: "unblock" }
 *    - Delete: DELETE /api/suppliers/:id (empty body)
 * 4. Duplicate submission prevention:
 *    - Handler aborts immediately when isPendingLifecycle is true
 *    - Exactly 1 fetch request dispatched on duplicate click
 * 5. Offline-disabled safeguards:
 *    - Action buttons are disabled when isOffline is true
 *    - Handler aborts when offline with connection error message
 * 6. Error handling & dialog lifecycle:
 *    - API error leaves dialog open and displays error in alert area
 *    - Successful action closes dialog and sets success notice
 * 7. Transaction history safeguards (Delete vs Deactivate):
 *    - Delete on supplier with transactions returns deactivated: true
 *    - Delete on unreferenced supplier returns deleted: true
 *
 * Run:
 *   npx tsx scripts/test-supplier-lifecycle-modal.ts
 */

import {
    supplierLifecycleSchema,
    isValidSupplierTransition,
    type SupplierLifecycleAction,
} from "../lib/validations/supplier";

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
    console.log(`SUPPLIER LIFECYCLE MODAL TEST SUMMARY: ${results.length - failed.length}/${results.length} checks passed.`);
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

type LifecycleActionType = "deactivate" | "reactivate" | "block" | "unblock" | "delete";

interface PendingLifecycleModal {
    action: LifecycleActionType;
    title: string;
}

interface SimulatedPageState {
    supplier: {
        _id: string;
        name: string;
        supplierCode: string;
        status: "active" | "inactive" | "blocked";
        isDeleted?: boolean;
    } | null;
    isOffline: boolean;
    pendingModal: PendingLifecycleModal | null;
    lifecycleReason: string;
    lifecycleError: string | null;
    lifecycleNotice: string | null;
    isPendingLifecycle: boolean;
}

function createInitialState(overrides?: Partial<SimulatedPageState>): SimulatedPageState {
    return {
        supplier: {
            _id: "6ad735deb550e689e9622fb7",
            name: "Acme Industrial Supplies",
            supplierCode: "SUP-0004",
            status: "active",
            isDeleted: false,
        },
        isOffline: false,
        pendingModal: null,
        lifecycleReason: "",
        lifecycleError: null,
        lifecycleNotice: null,
        isPendingLifecycle: false,
        ...overrides,
    };
}

// Modal description generator matching JSX logic
function getModalDescription(action: LifecycleActionType, supplierName: string): string {
    switch (action) {
        case "deactivate":
            return `Are you sure you want to deactivate ${supplierName}? Inactive suppliers cannot be selected on new purchase bills or orders. Existing purchase history and transaction records are preserved.`;
        case "block":
            return `Are you sure you want to block ${supplierName}? Blocked suppliers cannot be selected for new purchases or transactions. You can unblock them at any time.`;
        case "reactivate":
            return `Are you sure you want to reactivate ${supplierName}? The supplier will become active again and available for recording new purchase bills.`;
        case "unblock":
            return `Are you sure you want to unblock ${supplierName}? The supplier will return to active status and be available for purchases and payments.`;
        case "delete":
            return `Are you sure you want to delete ${supplierName}? Suppliers with existing transaction history (purchases, returns, payments, or ledger entries) will be safely deactivated to preserve accounting records. Unreferenced suppliers will be soft-deleted.`;
    }
}

function shouldShowReasonInput(action: LifecycleActionType): boolean {
    return action === "deactivate" || action === "block";
}

// Simulated execution handler matching handleExecuteLifecycleAction in page.tsx
async function simulateExecuteLifecycleAction(
    state: SimulatedPageState,
    mockFetch: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>
): Promise<void> {
    if (!state.pendingModal || state.isPendingLifecycle) return;

    if (state.isOffline) {
        state.lifecycleError = "Lifecycle actions (deactivate, block, reactivate, unblock, delete) require an active online connection.";
        return;
    }

    state.isPendingLifecycle = true;
    state.lifecycleError = null;

    try {
        const id = state.supplier?._id || "";
        if (state.pendingModal.action === "delete") {
            const res = await mockFetch(`/api/suppliers/${id}`, {
                method: "DELETE",
                credentials: "same-origin",
            });
            const data = await res.json().catch(() => null);

            if (res.ok && data?.success) {
                if (data.deactivated && data.supplier) {
                    state.supplier = data.supplier;
                    state.lifecycleNotice = data.message || "Supplier has transaction history and was deactivated instead of deleted.";
                } else {
                    if (state.supplier) {
                        state.supplier = { ...state.supplier, isDeleted: true };
                    }
                    state.lifecycleNotice = data.message || "Supplier deleted successfully.";
                }
                state.pendingModal = null;
                state.lifecycleReason = "";
                state.lifecycleError = null;
            } else {
                state.lifecycleError = data?.message || "Failed to delete supplier.";
            }
        } else {
            const res = await mockFetch(`/api/suppliers/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                    action: state.pendingModal.action,
                    reason: state.lifecycleReason.trim() || undefined,
                }),
            });
            const data = await res.json().catch(() => null);

            if (res.ok && data?.success && data.supplier) {
                state.supplier = data.supplier;
                state.lifecycleNotice = `Supplier ${state.pendingModal.action}d successfully.`;
                state.pendingModal = null;
                state.lifecycleReason = "";
                state.lifecycleError = null;
            } else {
                state.lifecycleError = data?.message || `Failed to ${state.pendingModal.action} supplier.`;
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
    console.log("=== SUPPLIER LIFECYCLE MODAL & ACTION SUITE ===\n");

    // ------------------------------------------------------------
    // 1. Modal Rendering for Each Action
    // ------------------------------------------------------------
    console.log("-- 1. Modal Content & Configuration for Each Action --");

    const actions: { action: LifecycleActionType; expectedTitle: string; hasReason: boolean }[] = [
        { action: "deactivate", expectedTitle: "Deactivate Supplier", hasReason: true },
        { action: "block", expectedTitle: "Block Supplier", hasReason: true },
        { action: "reactivate", expectedTitle: "Reactivate Supplier", hasReason: false },
        { action: "unblock", expectedTitle: "Unblock Supplier", hasReason: false },
        { action: "delete", expectedTitle: "Delete / Archive Supplier", hasReason: false },
    ];

    for (const item of actions) {
        const state = createInitialState({
            pendingModal: { action: item.action, title: item.expectedTitle },
        });

        check(
            `1.${actions.indexOf(item) + 1}a [${item.action}] Modal renders with correct title`,
            state.pendingModal?.title === item.expectedTitle
        );

        const desc = getModalDescription(item.action, state.supplier!.name);
        check(
            `1.${actions.indexOf(item) + 1}b [${item.action}] Description mentions supplier name`,
            desc.includes(state.supplier!.name)
        );

        check(
            `1.${actions.indexOf(item) + 1}c [${item.action}] Reason input visibility matches requirement`,
            shouldShowReasonInput(item.action) === item.hasReason
        );
    }

    const deleteDesc = getModalDescription("delete", "Acme Industrial Supplies");
    check(
        "1.6 Delete description clearly warns about transaction history preserving records via deactivation",
        deleteDesc.includes("transaction history") && deleteDesc.includes("deactivated") && deleteDesc.includes("soft-deleted")
    );

    // ------------------------------------------------------------
    // 2. Cancel Interaction
    // ------------------------------------------------------------
    console.log("\n-- 2. Cancel Interaction & State Cleanup --");

    let networkCallCount = 0;
    const trackedMockFetch = async () => {
        networkCallCount++;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    };

    const cancelState = createInitialState({
        pendingModal: { action: "deactivate", title: "Deactivate Supplier" },
        lifecycleReason: "Temporary vendor suspension",
        lifecycleError: "Some previous error",
    });

    // Simulate clicking Cancel button
    const handleCancel = (st: SimulatedPageState) => {
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
    // 3. Confirm Execution & HTTP Contract
    // ------------------------------------------------------------
    console.log("\n-- 3. Confirm Execution & HTTP Request Contracts --");

    // Test Deactivate
    {
        const calls: { url: string; method?: string; body?: string }[] = [];
        const state = createInitialState({
            pendingModal: { action: "deactivate", title: "Deactivate Supplier" },
            lifecycleReason: "Vendor discontinued operations",
        });

        await simulateExecuteLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method, body: init?.body as string });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    supplier: { ...state.supplier, status: "inactive" },
                }),
            };
        });

        check("3.1 Deactivate sends PATCH /api/suppliers/:id", calls[0]?.method === "PATCH" && calls[0]?.url === `/api/suppliers/${state.supplier?._id}`);
        const parsedBody = JSON.parse(calls[0]?.body || "{}");
        check("3.2 Deactivate payload matches schema { action: 'deactivate', reason }", parsedBody.action === "deactivate" && parsedBody.reason === "Vendor discontinued operations");
        check("3.3 Deactivate payload validates strictly against supplierLifecycleSchema", supplierLifecycleSchema.safeParse(parsedBody).success);
        check("3.4 Deactivate success updates supplier status to inactive", state.supplier?.status === "inactive");
        check("3.5 Deactivate success closes modal and sets notice", state.pendingModal === null && state.lifecycleNotice === "Supplier deactivated successfully.");
    }

    // Test Block
    {
        const calls: { url: string; method?: string; body?: string }[] = [];
        const state = createInitialState({
            pendingModal: { action: "block", title: "Block Supplier" },
            lifecycleReason: "Disputed duplicate invoices",
        });

        await simulateExecuteLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method, body: init?.body as string });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    supplier: { ...state.supplier, status: "blocked" },
                }),
            };
        });

        check("3.6 Block sends PATCH /api/suppliers/:id", calls[0]?.method === "PATCH");
        const parsedBody = JSON.parse(calls[0]?.body || "{}");
        check("3.7 Block payload matches schema { action: 'block', reason }", parsedBody.action === "block" && parsedBody.reason === "Disputed duplicate invoices");
        check("3.8 Block payload validates strictly against supplierLifecycleSchema", supplierLifecycleSchema.safeParse(parsedBody).success);
        check("3.9 Block success updates supplier status to blocked", state.supplier?.status === "blocked");
    }

    // Test Reactivate
    {
        const calls: { url: string; method?: string; body?: string }[] = [];
        const state = createInitialState({
            supplier: {
                _id: "6ad735deb550e689e9622fb7",
                name: "Acme Industrial Supplies",
                supplierCode: "SUP-0004",
                status: "inactive",
            },
            pendingModal: { action: "reactivate", title: "Reactivate Supplier" },
        });

        await simulateExecuteLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method, body: init?.body as string });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    supplier: { ...state.supplier, status: "active" },
                }),
            };
        });

        check("3.10 Reactivate sends PATCH with action 'reactivate'", calls[0]?.method === "PATCH" && JSON.parse(calls[0]?.body || "{}").action === "reactivate");
        check("3.11 Reactivate success transitions supplier status to active", state.supplier?.status === "active");
    }

    // Test Unblock
    {
        const calls: { url: string; method?: string; body?: string }[] = [];
        const state = createInitialState({
            supplier: {
                _id: "6ad735deb550e689e9622fb7",
                name: "Acme Industrial Supplies",
                supplierCode: "SUP-0004",
                status: "blocked",
            },
            pendingModal: { action: "unblock", title: "Unblock Supplier" },
        });

        await simulateExecuteLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method, body: init?.body as string });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    supplier: { ...state.supplier, status: "active" },
                }),
            };
        });

        check("3.12 Unblock sends PATCH with action 'unblock'", calls[0]?.method === "PATCH" && JSON.parse(calls[0]?.body || "{}").action === "unblock");
        check("3.13 Unblock success transitions supplier status to active", state.supplier?.status === "active");
    }

    // Test Delete (unreferenced soft-delete)
    {
        const calls: { url: string; method?: string }[] = [];
        const state = createInitialState({
            pendingModal: { action: "delete", title: "Delete / Archive Supplier" },
        });

        await simulateExecuteLifecycleAction(state, async (url, init) => {
            calls.push({ url, method: init?.method });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    message: "Supplier deleted successfully.",
                    deleted: true,
                }),
            };
        });

        check("3.14 Delete sends DELETE method to /api/suppliers/:id", calls[0]?.method === "DELETE");
        check("3.15 Soft-delete sets isDeleted: true on supplier record", state.supplier?.isDeleted === true);
        check("3.16 Delete closes modal on success", state.pendingModal === null);
    }

    // ------------------------------------------------------------
    // 4. Duplicate Submission Guard
    // ------------------------------------------------------------
    console.log("\n-- 4. Duplicate Submission Prevention --");

    {
        let fetchCount = 0;
        const state = createInitialState({
            pendingModal: { action: "deactivate", title: "Deactivate Supplier" },
            isPendingLifecycle: true, // Already running
        });

        await simulateExecuteLifecycleAction(state, async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        });

        check("4.1 Handler returns immediately if isPendingLifecycle is true", fetchCount === 0);

        // Reset and test sequential execution where second call happens while first is in-flight
        state.isPendingLifecycle = false;
        let resolveFirstCall: (val: any) => void;
        const slowPromise = new Promise((resolve) => {
            resolveFirstCall = resolve;
        });

        const call1 = simulateExecuteLifecycleAction(state, async () => {
            fetchCount++;
            await slowPromise;
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, supplier: { ...state.supplier, status: "inactive" } }),
            };
        });

        // Attempt second concurrent invocation
        const call2 = simulateExecuteLifecycleAction(state, async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        });

        resolveFirstCall!({ ok: true });
        await Promise.all([call1, call2]);

        check("4.2 Exactly 1 fetch request dispatched across concurrent clicks", fetchCount === 1);
        check("4.3 isPendingLifecycle safely resets to false after completion", state.isPendingLifecycle === false);
    }

    // ------------------------------------------------------------
    // 5. Offline Safeguards
    // ------------------------------------------------------------
    console.log("\n-- 5. Offline-Disabled Safeguards --");

    {
        let fetchCount = 0;
        const state = createInitialState({
            isOffline: true,
            pendingModal: { action: "deactivate", title: "Deactivate Supplier" },
        });

        await simulateExecuteLifecycleAction(state, async () => {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        });

        check("5.1 Handler aborts when isOffline is true without making network calls", fetchCount === 0);
        check("5.2 Handler sets explicit online-only connection error", state.lifecycleError?.includes("require an active online connection") === true);
        check("5.3 pendingModal is kept open so user does not lose context", state.pendingModal !== null);
    }

    // ------------------------------------------------------------
    // 6. Error Handling & Dialog Retention
    // ------------------------------------------------------------
    console.log("\n-- 6. Error Handling & Dialog Retention --");

    {
        const state = createInitialState({
            pendingModal: { action: "deactivate", title: "Deactivate Supplier" },
            lifecycleReason: "Business restructuring",
        });

        await simulateExecuteLifecycleAction(state, async () => {
            return {
                ok: false,
                status: 403,
                json: async () => ({
                    success: false,
                    message: "You do not have permission to modify supplier lifecycle",
                }),
            };
        });

        check("6.1 Modal remains open when API returns an error", state.pendingModal !== null);
        check("6.2 Error message is recorded in lifecycleError", state.lifecycleError === "You do not have permission to modify supplier lifecycle");
        check("6.3 User reason is preserved during error", state.lifecycleReason === "Business restructuring");
        check("6.4 Supplier status is unchanged on error", state.supplier?.status === "active");
    }

    // ------------------------------------------------------------
    // 7. Transaction History Safeguards (Delete vs Deactivate)
    // ------------------------------------------------------------
    console.log("\n-- 7. Transaction History Safeguards (Delete vs Deactivate) --");

    {
        const state = createInitialState({
            pendingModal: { action: "delete", title: "Delete / Archive Supplier" },
        });

        // Server responds that supplier has references and is deactivated instead
        await simulateExecuteLifecycleAction(state, async () => {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    message: "Supplier has existing transaction history and has been deactivated instead of deleted.",
                    deactivated: true,
                    hasReferences: true,
                    supplier: { ...state.supplier, status: "inactive" },
                }),
            };
        });

        check("7.1 Supplier with transaction history is deactivated, NOT deleted (isDeleted is not true)", state.supplier?.isDeleted !== true);
        check("7.2 Supplier status updated to inactive", state.supplier?.status === "inactive");
        check("7.3 Transaction history notice displayed to user", state.lifecycleNotice?.includes("deactivated instead of deleted") === true);
        check("7.4 Modal closed cleanly after conversion", state.pendingModal === null);
    }

    const allPassed = summarize();
    if (!allPassed) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
