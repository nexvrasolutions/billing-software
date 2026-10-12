
/*
 * Browser side of the offline session (see offlineSession.ts): IndexedDB
 * storage, the per-tab unlock marker, offline sign-out and the pending
 * server logout. Nothing here authorizes a server request: the server
 * session cookie and the server's own checks do that.
 */

import { LAST_IDENTITY_KEY, offlineDB } from "./db";
import {
    checkOfflineWorkAllowed,
    createOfflineSession,
    deleteOfflineSession,
    getOfflineSessionState,
    offlineSessionKey,
    renewOfflineSession,
    unlockOfflineSession,
    type OfflineIdentity,
    type OfflineSessionState,
    type OfflineSessionStore,
    type UnlockMarker,
    type UnlockResult,
} from "./offlineSession";

const UNLOCK_MARKER_KEY = "billing-offline-unlock";
const PENDING_LOGOUT_KEY = "pendingServerLogout";

const store: OfflineSessionStore = {
    get: (key) => offlineDB.offlineSessions.get(key),
    put: async (record) => { await offlineDB.offlineSessions.put(record); },
    delete: (key) => offlineDB.offlineSessions.delete(key),
};

// ---------------------------------------------------------- unlock marker
// Kept in sessionStorage: it lasts only for this browser tab and holds no
// secret (a reload of the tab keeps it; closing the tab locks).

function readMarker(): UnlockMarker | null {
    try {
        const raw = sessionStorage.getItem(UNLOCK_MARKER_KEY);
        const value = raw ? (JSON.parse(raw) as Partial<UnlockMarker>) : null;
        return value && typeof value.key === "string" && typeof value.nonce === "string" && typeof value.unlockedAt === "number"
            ? { key: value.key, nonce: value.nonce, unlockedAt: value.unlockedAt }
            : null;
    } catch {
        return null;
    }
}

function writeMarker(marker: UnlockMarker) {
    try {
        sessionStorage.setItem(UNLOCK_MARKER_KEY, JSON.stringify(marker));
    } catch {
        // Without sessionStorage the session simply stays locked.
    }
}

/** Lock this tab: offline work needs the PIN again. */
export function lockOfflineSession() {
    try {
        sessionStorage.removeItem(UNLOCK_MARKER_KEY);
    } catch {
        // nothing to remove
    }
}

// ---------------------------------------------------------- identity

function toIdentity(value: unknown): OfflineIdentity | null {
    const v = value as Partial<OfflineIdentity> | null;
    return v && typeof v.tenantId === "string" && typeof v.userId === "string" && typeof v.deviceId === "string"
        ? { tenantId: v.tenantId, userId: v.userId, deviceId: v.deviceId }
        : null;
}

/** The account that last signed in online on this device (a label only). */
export async function readRememberedIdentity(): Promise<OfflineIdentity | null> {
    return toIdentity((await offlineDB.meta.get(LAST_IDENTITY_KEY))?.value ?? null);
}

// ---------------------------------------------------------- queries

/** Queued items of this account that are not yet synced (never modified here). */
export async function countUnsyncedItems(identity: OfflineIdentity): Promise<number> {
    const items = await offlineDB.syncQueue.where("ownerUserId").equals(identity.userId).toArray();
    return items.filter((item) =>
        item.status !== "SYNCED" &&
        item.owner?.tenantId === identity.tenantId &&
        item.owner?.deviceId === identity.deviceId
    ).length;
}

export interface OfflineAccessOverview {
    identity: OfflineIdentity | null;
    state: OfflineSessionState;
    unlocked: boolean;
    unsyncedItems: number;
    pendingServerLogout: boolean;
}

/** Everything the dashboard needs to show the offline session. */
export async function getOfflineAccessOverview(): Promise<OfflineAccessOverview> {
    const identity = await readRememberedIdentity();
    const pendingServerLogout = await hasPendingServerLogout();
    if (!identity) {
        return { identity: null, state: { status: "none" }, unlocked: false, unsyncedItems: 0, pendingServerLogout };
    }
    const now = Date.now();
    const state = await getOfflineSessionState(store, identity, now);
    const unlocked = (await checkOfflineWorkAllowed(store, readMarker(), identity, now)).ok;
    return { identity, state, unlocked, unsyncedItems: await countUnsyncedItems(identity), pendingServerLogout };
}

/** Offline session state of one identity (e.g. for the account page). */
export function getOfflineStateFor(identity: OfflineIdentity): Promise<OfflineSessionState> {
    return getOfflineSessionState(store, identity, Date.now());
}

// ---------------------------------------------------------- actions

/**
 * Create or change the PIN. Call ONLY right after a live server check
 * confirmed this identity's session, no pending temporary password and the
 * sales.create permission. Any earlier unlock in this tab is cancelled.
 */
export async function setUpOfflinePin(input: {
    identity: OfflineIdentity;
    pin: string;
    permissions: string[];
    displayName?: string;
}) {
    lockOfflineSession();
    return createOfflineSession(store, { ...input, now: Date.now() });
}

/** Unlock the remembered account's offline session in this tab. */
export async function unlockRememberedOfflineSession(pin: string): Promise<UnlockResult> {
    const identity = await readRememberedIdentity();
    if (!identity) return { ok: false, reason: "none" };
    const result = await unlockOfflineSession(store, identity, pin, Date.now());
    if (result.ok) writeMarker(result.marker);
    else lockOfflineSession();
    return result;
}

/** Throws (with a plain-language reason) unless offline work is allowed. */
export async function assertOfflineWorkAllowed(identity: OfflineIdentity): Promise<void> {
    const result = await checkOfflineWorkAllowed(store, readMarker(), identity, Date.now());
    if (!result.ok) throw new Error(result.reason);
}

/** After a SUCCESSFUL server session check: renew the 24-hour window. */
export async function renewOfflineAccess(identity: OfflineIdentity, permissions: string[]): Promise<void> {
    await renewOfflineSession(store, identity, permissions, Date.now());
}

/** Remove an identity's offline session (logout, revocation, temporary password). Queued work is kept. */
export async function removeOfflineAccess(identity: OfflineIdentity): Promise<void> {
    const marker = readMarker();
    if (marker && marker.key === offlineSessionKey(identity)) lockOfflineSession();
    await deleteOfflineSession(store, identity);
}

// ---------------------------------------------------------- offline sign-out

export async function hasPendingServerLogout(): Promise<boolean> {
    return Boolean((await offlineDB.meta.get(PENDING_LOGOUT_KEY))?.value);
}

/**
 * Sign out while offline: remove this account's offline session and the
 * remembered identity on this device, and remember that the SERVER session
 * must still be ended when the device reconnects. Queued work is kept.
 */
export async function signOutOffline(): Promise<void> {
    const identity = await readRememberedIdentity();
    lockOfflineSession();
    if (identity) await deleteOfflineSession(store, identity);
    await offlineDB.meta.put({ key: PENDING_LOGOUT_KEY, value: { since: new Date().toISOString() } });
    await offlineDB.meta.delete(LAST_IDENTITY_KEY);
}

/**
 * If an offline sign-out is pending, end the server session now.
 *   "none"        nothing pending
 *   "done"        the server confirmed the logout; the flag is cleared
 *   "unreachable" could not confirm it; the flag is kept for later
 * Until "done", the old session must not be used (callers stop).
 */
export async function settlePendingServerLogout(): Promise<"none" | "done" | "unreachable"> {
    if (!(await hasPendingServerLogout())) return "none";
    try {
        const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include", cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (response.ok && data?.success) {
            await offlineDB.meta.delete(PENDING_LOGOUT_KEY);
            return "done";
        }
    } catch {
        // offline or unreachable: try again later
    }
    return "unreachable";
}

/** A new online sign-in replaced the old session cookie: nothing left to end. */
export async function clearPendingServerLogout(): Promise<void> {
    await offlineDB.meta.delete(PENDING_LOGOUT_KEY);
}
