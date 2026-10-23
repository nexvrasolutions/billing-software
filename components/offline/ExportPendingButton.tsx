"use client";

import { useState } from "react";

import { createPendingExport, rememberExport } from "@/lib/offline/pendingQueue";

/*
 * Saves a verified JSON file of every waiting (unsynced) operation on this
 * device. Nothing in the queue is changed or deleted. The file is a record
 * for audit and manual recovery: it is NOT imported by the application
 * (no import endpoint exists). The operations stay on this device, owned by
 * their original account, and only that account can send them.
 */
export function ExportPendingButton({
    className = "rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60",
    onSaved,
}: {
    className?: string;
    onSaved?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    async function save() {
        setBusy(true);
        setMessage("");

        try {
            const created = await createPendingExport();

            if (created.file.itemCount === 0) {
                setMessage("Nothing is waiting, so there is nothing to save.");
                return;
            }

            const url = URL.createObjectURL(new Blob([created.json], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = created.filename;
            link.click();
            URL.revokeObjectURL(url);

            await rememberExport(created);

            setMessage(
                `Saved ${created.file.itemCount} waiting operation(s) to ${created.filename} ` +
                `(digest ${created.file.digest.slice(0, 12)}…). This file is not an import: the application cannot ` +
                "read it back. The operations stay on this device and can only be sent by the account that made them."
            );
            onSaved?.();
        } catch {
            setMessage("The file could not be created or verified. Nothing was changed.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <span className="inline-flex flex-col gap-1">
            <button type="button" className={className} disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save a copy of waiting operations"}
            </button>
            {message && <span role="status" className="text-xs text-gray-600">{message}</span>}
        </span>
    );
}
