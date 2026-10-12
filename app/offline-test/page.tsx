"use client";

import {
    useCallback,
    useState,
} from "react";

import {
    addToSyncQueue,
    getQueueItemsForOwner,
    deleteSyncQueueItem,
} from "@/lib/offline/SyncQueueService";
import { fetchSessionIdentity } from "@/lib/offline/sessionIdentity";

import { syncPendingOperations } from "@/lib/offline/SyncManager";

import { useOnlineStatus } from "@/lib/offline/useOnlineStatus";

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
                        `Sync skipped: ${results.reason}.`
                    );

                    return;
                }

                if (results.results.length === 0) {
                    setMessage(
                        "No pending operations to sync."
                    );

                    return;
                }

                setMessage(
                    `Sync completed. ${results.results.length} operation(s) processed: ` +
                    results.results.map((r) => r.status).join(", ")
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

    async function addTestOperation() {
        try {
            // The queue generates a secure random operation ID itself.
            // NOTE: invoice numbering for offline sales is an open design
            // decision; this demo value can collide across devices.
            const invoiceNo =
                `INV - OFFLINE - BROWSER - ${Date.now()} `;

            const result =
                await addToSyncQueue({
                    operationType: "CREATE",
                    entityType: "Sale",

                    payload: {
                        invoiceNo,

                        customerId:
                            "6abe4d406ae4b08a3e335467",

                        warehouse: {
                            name: "Main Warehouse",
                            location: "Nagercoil",
                        },

                        items: [
                            {
                                productId:
                                    "6abe4d406ae4b08a3e335466",

                                quantity: 1,

                                unitPrice: 120,

                                discountRate: 0,

                                taxRate: 0,
                            },
                        ],

                        paidAmount: 120,

                        paymentMethod: "cash",

                        notes:
                            "Browser automatic sync test",
                    },

                    localSeq: Date.now(),
                });

            setMessage(
                `Operation added successfully: ${result.operationId} `
            );
        } catch (error) {
            console.error(error);

            setMessage(
                "Failed to add offline operation."
            );
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

            setMessage(
                `Queued operations for this account: ${operations.length} ` +
                JSON.stringify(counts)
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

    async function deleteOldTestOperation() {
        try {
            await deleteSyncQueueItem(
                "OP-OFFLINE-TEST-1791348653781"
            );

            setMessage(
                "Old test operation deleted successfully."
            );
        } catch (error) {
            console.error(error);

            setMessage(
                "Failed to delete old test operation."
            );
        }
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
                }}
            >
                <button
                    onClick={addTestOperation}
                >
                    Add Offline Test Sale
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

                <button
                    onClick={deleteOldTestOperation}
                    style={{
                        marginLeft: "10px",
                    }}
                >
                    Delete Old Test
                </button>
            </div>

            <p
                style={{
                    marginTop: "20px",
                }}
            >
                {message}
            </p>
        </main>
    );
}

