
import { clearRuntimeCaches } from "./cacheCleanup";
import { LAST_IDENTITY_KEY, offlineDB } from "./db";
import {
    activateOfflineAccess,
    assertOfflineWorkAllowed,
    checkOfflineProductCreation,
    readRememberedIdentity,
    removeOfflineAccess,
    restoreOfflineSession,
    settlePendingServerLogout,
    type OfflineRestorationResult,
} from "./offlineAccess";
import { OfflineVerificationError } from "./offlineSession";
import { identityFromMe, planSessionConfirmation, pricingModeFromMe } from "./sessionConfirmation";
import type { SessionIdentity } from "./syncPolicy";

export { identityFromMe, pricingModeFromMe, restoreOfflineSession, checkOfflineProductCreation, type OfflineRestorationResult };

/*
 * Which account the device is working for.
 *
 * The authoritative identity always comes from the server session
 * (/api/auth/me). The last confirmed identity is remembered only so work can
 * be queued while offline, and offline work additionally needs a valid,
 * unexpired offline session (72 hours since the last successful server
 * verification, offlineAccess.ts). It is replaced at login and
 * cleared at logout.
 */

/**
 * Longest wait for the session check. A connected network without internet
 * can otherwise leave the request hanging; a timeout is "server
 * unreachable" (fetchSessionIdentity throws), never "signed out".
 */
export const SESSION_CHECK_TIMEOUT_MS = 5_000;

/** HTTP statuses with which /api/auth/me definitively rejects a session. */
export function isSessionRejected(status: number): boolean {
    return status === 401 || status === 403;
}

/** What happened to the offline authorization at the last confirmation. */
export type RenewalOutcome = "not-requested" | "renewed" | "clock-skew" | "no-server-time" | "failed";

let lastRenewalOutcome: RenewalOutcome = "not-requested";

/** Outcome of the latest renewal attempt in this page session (for status messages). */
export function getLastRenewalOutcome(): RenewalOutcome {
    return lastRenewalOutcome;
}

/** Plain-language text for a renewal problem, or null when there is none. */
export function renewalProblemText(outcome: RenewalOutcome): string | null {
    if (outcome === "clock-skew") {
        return "Offline access was not renewed: this device's clock differs from the server's by more than 5 minutes. Correct the clock and sign in or reload while online.";
    }
    if (outcome === "no-server-time") {
        return "Offline access was not renewed: the server did not report its time. Reload while online.";
    }
    if (outcome === "failed") {
        return "Offline access could not be renewed. Reload while online.";
    }
    return null;
}

/**
 * Apply a SUCCESSFUL server session check (/api/auth/me 200 body):
 *  - temporary password pending: that account's offline session is removed
 *    and the remembered identity forgotten (queued work is kept); null;
 *  - otherwise returns the identity. The 72-hour offline session is created
 *    or renewed ONLY when options.renew is true, which login, the dashboard
 *    and the account page pass after their own successful verification.
 *    Sync, queueing, queue inspection and the users page never pass it.
 *    A renewal is refused (nothing changes) when the device clock differs
 *    from the server time by more than five minutes.
 */
export async function confirmServerSession(
    data: unknown,
    options: { renew?: boolean } = {}
): Promise<SessionIdentity | null> {
    const plan = planSessionConfirmation(data, { renew: options.renew === true });

    if (plan.kind === "no-identity") return null;

    if (plan.kind === "temporary-password") {
        await removeOfflineAccess(plan.identity).catch(() => undefined);
        await forgetSessionIdentity();
        return null;
    }

    if (plan.renew) {
        try {
            await activateOfflineAccess({
                identity: plan.identity,
                permissions: plan.permissions,
                displayName: plan.displayName,
                serverTime: plan.serverTime,
            });
            lastRenewalOutcome = "renewed";
        } catch (error) {
            lastRenewalOutcome = error instanceof OfflineVerificationError ? error.reason : "failed";
        }
    }

    return plan.identity;
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

    // A timeout rejects like a network failure (thrown below): the session
    // is not judged and nothing is removed.
    const response = await fetch("/api/auth/me", {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });

    if (isSessionRejected(response.status)) {
        await endOfflineAccess();
        return null;
    }

    if (!response.ok) {
        throw new Error(`Session check failed (HTTP ${response.status})`);
    }

    // Verification only: a sync, a queue check or a queueing never renews
    // the offline authorization (no renew option).
    return confirmServerSession(await response.json());
}

export async function rememberSessionIdentity(identity: SessionIdentity): Promise<void> {
    await offlineDB.meta.put({ key: LAST_IDENTITY_KEY, value: identity });
}

/**
 * A new sign-in attempt: forget the remembered account (its offline session
 * record stays; it can only be used again after that account is verified
 * online on this device).
 */
export async function forgetSessionIdentity(): Promise<void> {
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
    // Runtime page/data caches only (named in cacheCleanup.ts). The offline
    // queue and the precached offline app shell are never touched.
    await clearRuntimeCaches(typeof caches !== "undefined" ? caches : undefined);
}

export async function getRememberedIdentity(): Promise<SessionIdentity | null> {
    return readRememberedIdentity();
}

/**
 * Identity to stamp on newly queued work.
 *  - Online: the live server session (unchanged behaviour).
 *  - Offline or server unreachable: the remembered account, ONLY with a
 *    valid, unexpired offline session of that same tenant, user and device
 *    that reported sales.create. It is a local gate; the server
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
