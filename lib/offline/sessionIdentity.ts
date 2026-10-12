
import { LAST_IDENTITY_KEY, offlineDB } from "./db";
import {
    assertOfflineWorkAllowed,
    lockOfflineSession,
    readRememberedIdentity,
    removeOfflineAccess,
    renewOfflineAccess,
    settlePendingServerLogout,
} from "./offlineAccess";
import type { SessionIdentity } from "./syncPolicy";

/*
 * Which account the device is working for.
 *
 * The authoritative identity always comes from the server session
 * (/api/auth/me). The last confirmed identity is remembered only so work can
 * be queued while offline, and offline work additionally needs an unlocked,
 * unexpired PIN session (offlineAccess.ts). It is replaced at login and
 * cleared at logout.
 */

function toIdentity(value: unknown): SessionIdentity | null {
    const v = value as Partial<SessionIdentity> | null;
    return v && typeof v.tenantId === "string" && typeof v.userId === "string" && typeof v.deviceId === "string"
        ? { tenantId: v.tenantId, userId: v.userId, deviceId: v.deviceId }
        : null;
}

/** HTTP statuses with which /api/auth/me definitively rejects a session. */
export function isSessionRejected(status: number): boolean {
    return status === 401 || status === 403;
}

/** Identity reported by a successful /api/auth/me response body. */
export function identityFromMe(data: unknown): SessionIdentity | null {
    const body = data as { user?: { tenantId?: unknown; id?: unknown }; device?: { id?: unknown } } | null;
    return toIdentity({
        tenantId: body?.user?.tenantId,
        userId: body?.user?.id,
        deviceId: body?.device?.id,
    });
}

/**
 * Apply a SUCCESSFUL server session check (/api/auth/me 200 body):
 *  - temporary password pending: that account's offline session is removed
 *    and the remembered identity forgotten (queued work is kept); null;
 *  - otherwise the offline session's 24-hour window is renewed and its
 *    permission list refreshed; returns the identity.
 */
export async function confirmServerSession(data: unknown): Promise<SessionIdentity | null> {
    const identity = identityFromMe(data);
    const body = data as { user?: { mustChangePassword?: unknown }; permissions?: unknown } | null;

    if (!identity) return null;

    if (body?.user?.mustChangePassword === true) {
        await removeOfflineAccess(identity).catch(() => undefined);
        await forgetSessionIdentity();
        return null;
    }

    const permissions = Array.isArray(body?.permissions)
        ? body.permissions.filter((p): p is string => typeof p === "string")
        : [];
    await renewOfflineAccess(identity, permissions).catch(() => undefined);
    return identity;
}

/**
 * Current identity according to the server session.
 *
 * - null: the server definitively rejected the session (signed out,
 *   expired, revoked, user/tenant/device inactive), or the user must first
 *   change a temporary password, or a pending offline sign-out was just
 *   completed. The remembered identity and that account's offline session
 *   are then removed, so no offline work can be queued for it. Queued
 *   business items are never deleted here.
 * - throws: the server could not be reached or had an error (or a pending
 *   offline sign-out could not be completed yet). That says nothing about
 *   the session, so nothing is removed.
 */
export async function fetchSessionIdentity(): Promise<SessionIdentity | null> {
    // An offline sign-out must reach the server before the old session is
    // used for anything (such as uploading queued work).
    const pending = await settlePendingServerLogout();
    if (pending === "unreachable") {
        throw new Error("A pending sign-out could not be completed yet");
    }
    if (pending === "done") {
        return null;
    }

    const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });

    if (isSessionRejected(response.status)) {
        await endOfflineAccess();
        return null;
    }

    if (!response.ok) {
        throw new Error(`Session check failed (HTTP ${response.status})`);
    }

    return confirmServerSession(await response.json());
}

export async function rememberSessionIdentity(identity: SessionIdentity): Promise<void> {
    await offlineDB.meta.put({ key: LAST_IDENTITY_KEY, value: identity });
}

/**
 * A new sign-in attempt: lock any unlocked offline session in this tab and
 * forget the remembered account (its PIN record stays; it can only be used
 * again after that account signs in online on this device).
 */
export async function forgetSessionIdentity(): Promise<void> {
    lockOfflineSession();
    await offlineDB.meta.delete(LAST_IDENTITY_KEY);
}

/**
 * Logout, or the server definitively rejected the session: remove the
 * remembered account's offline session and forget the account. Queued
 * offline work is kept and syncs when that account signs in again.
 */
export async function endOfflineAccess(): Promise<void> {
    const identity = await readRememberedIdentity();
    if (identity) await removeOfflineAccess(identity).catch(() => undefined);
    await forgetSessionIdentity();
}

export async function getRememberedIdentity(): Promise<SessionIdentity | null> {
    return readRememberedIdentity();
}

/**
 * Identity to stamp on newly queued work.
 *  - Online: the live server session (unchanged behaviour).
 *  - Offline or server unreachable: the remembered account, ONLY with an
 *    unlocked, unexpired offline PIN session of that same tenant, user and
 *    device that reported sales.create. It is a local gate; the server
 *    checks the real session and permissions again when the work is
 *    uploaded.
 */
export async function getIdentityForQueueing(): Promise<SessionIdentity> {
    if (typeof navigator !== "undefined" && navigator.onLine) {
        try {
            const live = await fetchSessionIdentity();
            if (live) {
                await rememberSessionIdentity(live);
                return live;
            }
            // Online but the session was rejected, or a temporary password
            // must be changed first (identity already forgotten): never
            // queue work for that account.
            throw new Error("Please sign in before recording offline work");
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Please sign in")) throw error;
            // Network or server failure: treated as offline (below).
        }
    }

    const remembered = await getRememberedIdentity();
    if (!remembered) {
        throw new Error("Please sign in online at least once before working offline");
    }
    await assertOfflineWorkAllowed(remembered);
    return remembered;
}
