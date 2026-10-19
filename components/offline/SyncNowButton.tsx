"use client";

import { useState } from "react";

import { syncPendingOperations } from "@/lib/offline/SyncManager";
import { describeAfterRun, describeRunReason } from "@/lib/offline/queueStatus";

/*
 * "Sync now": sends the queued operations of the account that is signed in
 * right now. The identity comes from the server session; items of any other
 * account are never sent. A sync never renews the 72-hour offline
 * authorization (only login, the dashboard and the account page do).
 */
export function SyncNowButton({
    className = "rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60",
    onDone,
}: {
    className?: string;
    onDone?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    async function run() {
        setBusy(true);
        setMessage("Syncing…");

        try {
            const outcome = await syncPendingOperations();
            const after = describeAfterRun(outcome.remaining, outcome.reason);

            if (!outcome.ran) {
                setMessage(`Sync skipped: ${outcome.reason}. ${describeRunReason(outcome.reason)}`.trim());
            } else if (outcome.results.length === 0) {
                // "Nothing sent" is not "nothing waiting": items may be
                // waiting for their retry time or need attention.
                setMessage(
                    outcome.remaining && outcome.remaining.unsynced > 0
                        ? `Nothing was due to send right now. ${after}`
                        : `No waiting operations to send for this account. ${describeRunReason(outcome.reason)}`.trim()
                );
            } else {
                const sent = outcome.results.filter((r) => r.status === "SYNCED").length;
                setMessage(`${sent} of ${outcome.results.length} operation(s) sent. ${after}`.trim());
            }
        } catch {
            setMessage("Sync failed. Your waiting operations are still on this device.");
        } finally {
            setBusy(false);
            onDone?.();
        }
    }

    return (
        <span className="inline-flex flex-col gap-1">
            <button type="button" className={className} disabled={busy} onClick={run}>
                {busy ? "Syncing…" : "Sync now"}
            </button>
            {message && <span role="status" className="text-xs text-gray-600">{message}</span>}
        </span>
    );
}
