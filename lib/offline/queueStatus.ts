
/*
 * Plain-language queue status for the cashier (pure; no browser APIs,
 * unit-testable). Read-only: nothing here changes a queue item.
 *
 * Local states (syncPolicy.ts) and what the cashier sees:
 *   PENDING          -> "Waiting to send"
 *   SYNCING          -> "Sending"
 *   FAILED           -> "Will retry"       (a real server answer said "try
 *                                           again later"; retried
 *                                           automatically after nextAttemptAt)
 *   NEEDS_ATTENTION  -> "Needs attention"  (never retried automatically)
 *   SYNCED           -> "Sent to server"   (only after the server confirmed it)
 * Any unknown status is shown as "Needs attention", never hidden.
 */

import { isInternalError } from "@/lib/api/publicError";

export type QueueCategory = "waiting" | "sending" | "retry" | "attention" | "synced";

export interface QueueSummary {
    waiting: number;
    sending: number;
    retry: number;
    attention: number;
    synced: number;
    /** Everything not yet confirmed by the server (all but synced). */
    unsynced: number;
}

export function categorize(status: string): QueueCategory {
    switch (status) {
        case "PENDING": return "waiting";
        case "SYNCING": return "sending";
        case "FAILED": return "retry";
        case "SYNCED": return "synced";
        default: return "attention"; // NEEDS_ATTENTION and anything unknown
    }
}

export const CATEGORY_LABELS: Record<QueueCategory, string> = {
    waiting: "Waiting to send",
    sending: "Sending",
    retry: "Will retry",
    attention: "Needs attention",
    synced: "Sent to server",
};

export function emptySummary(): QueueSummary {
    return { waiting: 0, sending: 0, retry: 0, attention: 0, synced: 0, unsynced: 0 };
}

export function summarizeQueue(items: { status: string }[]): QueueSummary {
    const summary = emptySummary();
    for (const item of items) {
        const category = categorize(item.status);
        summary[category] += 1;
        if (category !== "synced") summary.unsynced += 1;
    }
    return summary;
}

/** "1 waiting to send, 2 will retry later, 1 needs attention" ("" when nothing is unsynced). */
export function describeUnsynced(summary: QueueSummary): string {
    const parts: string[] = [];
    if (summary.waiting) parts.push(`${summary.waiting} waiting to send`);
    if (summary.sending) parts.push(`${summary.sending} sending`);
    if (summary.retry) parts.push(`${summary.retry} will retry later`);
    if (summary.attention) parts.push(`${summary.attention} need${summary.attention === 1 ? "s" : ""} attention`);
    return parts.join(", ");
}

/** Extra advice when something needs a person. */
export function attentionAdvice(summary: QueueSummary): string {
    return summary.attention > 0
        ? " Operations that need attention are kept on this device and are not retried automatically; ask a manager to review them."
        : "";
}

export const INTERNAL_REASON_TEXT = "An internal problem occurred";

/**
 * A stored failure reason made safe to show. Messages from the server are
 * already sanitized; items saved by older versions may hold raw text.
 */
export function safeReason(text: string | undefined | null): string | undefined {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return undefined;
    if (isInternalError({ message: trimmed })) return INTERNAL_REASON_TEXT;
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

/** Plain text for the reason a sync run did not start or stopped early. */
export function describeRunReason(reason: string | undefined): string {
    switch (reason) {
        case "offline": return "This device is offline. Waiting operations stay on this device.";
        case "server unreachable": return "The server could not be reached. Waiting operations stay on this device.";
        case "not signed in": return "Sign in online to send this account's waiting operations.";
        case "another tab is syncing": return "Another tab is already sending; try again in a moment.";
        case "server unreachable during sync": return "The connection was lost while sending; the rest will be sent next time.";
        case "session changed or ended during sync": return "The sign-in changed while sending; sign in again to send the rest.";
        default: return "";
    }
}

/** What a finished sync run means for the account's queue (after the run). */
export function describeAfterRun(remaining: QueueSummary | undefined, stopReason?: string): string {
    const stop = stopReason ? describeRunReason(stopReason) : "";
    if (!remaining) return stop;
    const left = describeUnsynced(remaining);
    const still = left ? `Still on this device: ${left}.${attentionAdvice(remaining)}` : "Nothing is left waiting for this account.";
    return [stop, still].filter(Boolean).join(" ");
}
