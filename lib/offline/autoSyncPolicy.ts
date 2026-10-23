
/*
 * When the app starts a sync by itself (pure; no browser APIs, testable).
 *
 * Triggers (no timers, no loops): the page opens ("open"), the browser goes
 * back online ("online"), or the tab becomes visible again ("visible").
 * Each trigger starts at most one run. "online" and "visible" are ignored
 * within MIN_AUTO_SYNC_INTERVAL_MS of the previous automatic start, so a
 * flapping connection or tab switching cannot flood the server.
 *
 * A run itself is still protected by SyncManager: one tab at a time (Web
 * Locks), only the signed-in account's items, backoff for items the server
 * said to retry later, and NEEDS_ATTENTION items are never retried.
 */

export type AutoSyncTrigger = "open" | "online" | "visible";

export const MIN_AUTO_SYNC_INTERVAL_MS = 30_000;

export function shouldStartAutoSync(input: {
    trigger: AutoSyncTrigger;
    /** navigator.onLine at the moment of the trigger. */
    online: boolean;
    /** A run started by this page is still in progress. */
    inFlight: boolean;
    /** When this page last started an automatic run (ms), or null. */
    lastStartedAt: number | null;
    now: number;
}): boolean {
    if (!input.online || input.inFlight) return false;
    if (input.trigger === "open" || input.lastStartedAt === null) return true;
    return input.now - input.lastStartedAt >= MIN_AUTO_SYNC_INTERVAL_MS;
}
