
/*
 * Browser storage durability and "not saved" messages (pure apart from the
 * storage object passed in; testable without a browser).
 *
 * Offline sales live only in this browser's IndexedDB until they are synced.
 * Browsers may clear a site's storage when the disk runs low unless the
 * site's storage is "persistent". A request can be refused (the decision is
 * the browser's), so the result is shown to the user, never assumed.
 *
 * Nothing here deletes, clears or rewrites stored data.
 */

/** The part of navigator.storage used here (feature-detected). */
export interface StorageLike {
    persisted?: () => Promise<boolean>;
    persist?: () => Promise<boolean>;
}

export type PersistenceResult = "persisted" | "not-granted" | "unsupported";

/** Ask for persistent storage once; never throws. */
export async function requestPersistentStorage(storage: StorageLike | null | undefined): Promise<PersistenceResult> {
    if (!storage || typeof storage.persisted !== "function" || typeof storage.persist !== "function") {
        return "unsupported";
    }
    try {
        if (await storage.persisted()) return "persisted";
        return (await storage.persist()) ? "persisted" : "not-granted";
    } catch {
        return "unsupported";
    }
}

export function persistenceText(result: PersistenceResult): string {
    switch (result) {
        case "persisted":
            return "Storage on this device is protected from automatic clean-up by the browser.";
        case "not-granted":
            return "The browser did not protect this site's storage: if the disk runs low it may delete data, including waiting operations. Sync regularly.";
        default:
            return "This browser cannot protect this site's storage: sync waiting operations regularly.";
    }
}

// Plain-language refusals thrown by the offline queueing code itself
// (sessionIdentity.ts, offlineSession.ts); safe to show as they are.
const OWN_REFUSALS = /^(Please sign in|Offline access is not available|The offline session has expired|The device clock appears|This account is not allowed)/;

function errorName(value: unknown): string | undefined {
    const name = (value as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : undefined;
}

/** True when saving failed because the browser's storage is full. */
export function isQuotaError(error: unknown): boolean {
    // Dexie wraps the browser's DOMException in `inner`.
    return [error, (error as { inner?: unknown } | null)?.inner]
        .some((value) => errorName(value) === "QuotaExceededError");
}

/**
 * Why a sale could not be queued, for the cashier. It always says the sale
 * was NOT saved; storage details and internal error text are never shown.
 */
export function describeQueueWriteError(error: unknown): string {
    if (isQuotaError(error)) {
        return "The sale was NOT saved on this device: the browser's storage is full. Free up disk space, sync waiting operations, then try again.";
    }
    const message = error instanceof Error ? error.message.trim() : "";
    if (OWN_REFUSALS.test(message)) {
        return `The sale was NOT saved: ${message}`;
    }
    return "The sale was NOT saved on this device. Try again; if it keeps failing, record the sale another way and contact support.";
}
