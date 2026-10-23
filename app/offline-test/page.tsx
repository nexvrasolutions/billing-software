"use client";

import {
    useCallback,
    useRef,
    useState,
} from "react";

import {
    addToSyncQueue,
    getQueueItemsForOwner,
} from "@/lib/offline/SyncQueueService";
import { fetchSessionIdentity } from "@/lib/offline/sessionIdentity";

import { syncPendingOperations } from "@/lib/offline/SyncManager";

import { useOnlineStatus } from "@/lib/offline/useOnlineStatus";
import {
    CATEGORY_LABELS,
    attentionAdvice,
    categorize,
    describeAfterRun,
    describeRunReason,
    describeUnsynced,
    safeReason,
    summarizeQueue,
} from "@/lib/offline/queueStatus";
import type { SyncQueueItem } from "@/lib/offline/db";
import { describeQueueWriteError } from "@/lib/offline/storageDurability";

export default function OfflineTestPage() {
    const [message, setMessage] = useState("");

    const syncOperations = useCallback(
        async () => {
            try {
                setMessage(
                    "Syncing operations..."
                );

                const results =
                    await syncPendingOperations();

                console.log(
                    "Automatic sync results:",
                    results
                );

                if (!results.ran) {
                    setMessage(
                        `Sync skipped: ${results.reason}. ${describeRunReason(results.reason)}`.trim()
                    );

                    return;
                }

                const after =
                    describeAfterRun(results.remaining, results.reason);

                if (results.results.length === 0) {
                    // "Nothing sent" is not "nothing waiting": items may be
                    // waiting for their retry time or need attention.
                    setMessage(
                        results.remaining && results.remaining.unsynced > 0
                            ? `No pending operations were due to send now. ${after}`
                            : `No pending operations to sync. ${describeRunReason(results.reason)}`.trim()
                    );

                    return;
                }

                setMessage(
                    `Sync completed. ${results.results.length} operation(s) processed: ` +
                    results.results.map((r) => CATEGORY_LABELS[categorize(r.status)]).join(", ") +
                    `. ${after}`
                );
            } catch (error) {
                console.error(
                    "Automatic sync error:",
                    error
                );

                setMessage(
                    "Automatic sync failed."
                );
            }
        },
        []
    );

    const isOnline =
        useOnlineStatus(syncOperations);

    // Test sale details. A valid Product ID from the signed-in tenant is
    // required to queue an offline test sale. Customer ID is optional.
    const [productId, setProductId] = useState("");
    const [quantity, setQuantity] = useState("1");
    const [customerId, setCustomerId] = useState("");

    // This account's queue as last read by "Check Queue" (read-only view).
    const [queueItems, setQueueItems] = useState<SyncQueueItem[] | null>(null);

    // True while a test sale is being saved to the local queue.
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);

    function buildPayload(): Record<string, unknown> | string {
        const trimmedProductId = productId.trim();

        if (!trimmedProductId) {
            return "Product ID is required.";
        }

        const objectIdPattern = /^[a-f\d]{24}$/i;
        const trimmedCustomerId = customerId.trim();
        const parsedQuantity = Number(quantity);

        if (!objectIdPattern.test(trimmedProductId)) {
            return "Product ID must be a 24-character ID.";
        }

        if (trimmedCustomerId && !objectIdPattern.test(trimmedCustomerId)) {
            return "Customer ID must be empty or a 24-character ID.";
        }

        if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
            return "Quantity must be a number greater than 0.";
        }

        // No unitPrice: the server uses the product's selling price, so no
        // price-override permission is needed. No paidAmount: the total is
        // only known on the server.
        return {
            invoiceNo: `OFFTEST-${Date.now()}`,

            ...(trimmedCustomerId
                ? { customerId: trimmedCustomerId }
                : {}),

            warehouse: {
                name: "Main Warehouse",
            },

            items: [
                {
                    productId: trimmedProductId,

                    quantity: parsedQuantity,
                },
            ],

            paymentMethod: "cash",

            notes:
                "Controlled offline test sale",
        };
    }

    async function addTestOperation() {
        // Each click queues a NEW operation ID, so a second click while the
        // first sale is still being saved would record the sale twice. The
        // ref blocks it at once; the state disables the button.
        if (savingRef.current) {
            return;
        }

        const payload = buildPayload();

        if (typeof payload === "string") {
            setMessage(payload);

            return;
        }

        savingRef.current = true;
        setSaving(true);

        try {
            // The queue generates a secure random operation ID itself.
            const result =
                await addToSyncQueue({
                    operationType: "CREATE",
                    entityType: "Sale",

                    payload,

                    localSeq: Date.now(),
                });

            setMessage(
                `Operation added successfully: ${result.operationId} `
            );
        } catch (error) {
            console.error(error);

            // Success is only ever shown after the queue write resolved.
            setMessage(
                `Failed to add offline operation. ${describeQueueWriteError(error)}`
            );
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }

    async function checkQueue() {
        try {
            const identity =
                await fetchSessionIdentity();

            if (!identity) {
                setMessage(
                    "Sign in to see this account's queued operations."
                );

                return;
            }

            // Only the signed-in account's items are shown.
            const operations =
                await getQueueItemsForOwner(identity);

            const counts: Record<string, number> = {};
            for (const operation of operations) {
                counts[operation.status] = (counts[operation.status] ?? 0) + 1;
            }

            const summary =
                summarizeQueue(operations);
            const unsyncedText =
                describeUnsynced(summary);

            setMessage(
                `Queued operations for this account: ${operations.length} ` +
                JSON.stringify(counts) +
                (unsyncedText
                    ? ` Not yet confirmed by the server: ${unsyncedText}.${attentionAdvice(summary)}`
                    : "")
            );

            // Newest first; read-only view.
            setQueueItems(
                [...operations].reverse()
            );
        } catch (error) {
            console.error(error);

            setMessage(
                "Failed to read offline queue."
            );
        }
    }

    async function manualSync() {
        await syncOperations();
    }

    return (
        <main
            style={{
                padding: "40px",
            }}
        >
            <h1>
                Offline Database Test
            </h1>

            <h2
                style={{
                    marginTop: "20px",
                }}
            >
                Network Status:{" "}
                {isOnline
                    ? "ONLINE"
                    : "OFFLINE"}
            </h2>

            <div
                style={{
                    marginTop: "20px",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "10px",
                }}
            >
                <label>
                    Product ID{" "}
                    <input
                        type="text"
                        value={productId}
                        onChange={(event) => setProductId(event.target.value)}
                        placeholder="24-character product ID"
                    />
                </label>

                <label>
                    Quantity{" "}
                    <input
                        type="number"
                        min="0"
                        step="any"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value)}
                    />
                </label>

                <label>
                    Customer ID (optional){" "}
                    <input
                        type="text"
                        value={customerId}
                        onChange={(event) => setCustomerId(event.target.value)}
                    />
                </label>
            </div>

            <div
                style={{
                    marginTop: "20px",
                }}
            >
                <button
                    onClick={addTestOperation}
                    disabled={saving}
                >
                    {saving
                        ? "Saving..."
                        : "Add Offline Test Sale"}
                </button>

                <button
                    onClick={checkQueue}
                    style={{
                        marginLeft: "10px",
                    }}
                >
                    Check Queue
                </button>

                <button
                    onClick={manualSync}
                    style={{
                        marginLeft: "10px",
                    }}
                >
                    Sync Operations
                </button>
            </div>

            <p
                style={{
                    marginTop: "20px",
                }}
            >
                {message}
            </p>

            {/* No paragraph elements below: the message above must stay
                the page's last paragraph (the browser test resets it). */}
            {queueItems && queueItems.length > 0 && (
                <table
                    style={{
                        marginTop: "20px",
                        borderCollapse: "collapse",
                        fontSize: "14px",
                    }}
                >
                    <caption style={{ textAlign: "left", fontWeight: 600 }}>
                        This account&apos;s operations on this device (newest first)
                    </caption>
                    <thead>
                        <tr>
                            {["Queued at", "Invoice", "Status", "Attempts", "Next try", "Reason"].map((heading) => (
                                <th key={heading} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid #ccc" }}>
                                    {heading}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {queueItems.map((item) => {
                            const invoice = item.payload?.invoiceNo;
                            const nextTry = item.status === "FAILED" && item.nextAttemptAt
                                ? new Date(item.nextAttemptAt).toLocaleString()
                                : "";

                            return (
                                <tr key={item.operationId}>
                                    <td style={{ padding: "4px 8px" }}>{new Date(item.createdAt).toLocaleString()}</td>
                                    <td style={{ padding: "4px 8px" }}>{typeof invoice === "string" ? invoice : ""}</td>
                                    <td style={{ padding: "4px 8px" }}>{CATEGORY_LABELS[categorize(item.status)]}</td>
                                    <td style={{ padding: "4px 8px" }}>{item.attempts}</td>
                                    <td style={{ padding: "4px 8px" }}>{nextTry}</td>
                                    <td style={{ padding: "4px 8px" }}>
                                        {item.status === "SYNCED" ? "" : safeReason(item.errorMessage) ?? ""}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </main>
    );
}

