
import { offlineDB } from "./db";
import type { SessionIdentity } from "./syncPolicy";

/*
 * Which account the device is working for.
 *
 * The authoritative identity always comes from the server session
 * (/api/auth/me). The last confirmed identity is remembered only so work can
 * be queued while offline; it is replaced at login and cleared at logout.
 */

const LAST_IDENTITY_KEY = "lastSessionIdentity";

function toIdentity(value: unknown): SessionIdentity | null {
    const v = value as Partial<SessionIdentity> | null;
    return v && typeof v.tenantId === "string" && typeof v.userId === "string" && typeof v.deviceId === "string"
        ? { tenantId: v.tenantId, userId: v.userId, deviceId: v.deviceId }
        : null;
}

/** Current identity according to the server session, or null if signed out. */
export async function fetchSessionIdentity(): Promise<SessionIdentity | null> {
    const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });

    if (!response.ok) {
        return null;
    }

    const data = await response.json();
    return toIdentity({
        tenantId: data?.user?.tenantId,
        userId: data?.user?.id,
        deviceId: data?.device?.id,
    });
}

export async function rememberSessionIdentity(identity: SessionIdentity): Promise<void> {
    await offlineDB.meta.put({ key: LAST_IDENTITY_KEY, value: identity });
}

/** Called at logout: offline work can no longer be queued for that account. */
export async function forgetSessionIdentity(): Promise<void> {
    await offlineDB.meta.delete(LAST_IDENTITY_KEY);
}

export async function getRememberedIdentity(): Promise<SessionIdentity | null> {
    return toIdentity((await offlineDB.meta.get(LAST_IDENTITY_KEY))?.value ?? null);
}

/**
 * Identity to stamp on newly queued work: the live session when online,
 * otherwise the identity confirmed at the last login on this device.
 */
export async function getIdentityForQueueing(): Promise<SessionIdentity> {
    if (typeof navigator !== "undefined" && navigator.onLine) {
        try {
            const live = await fetchSessionIdentity();
            if (live) {
                await rememberSessionIdentity(live);
                return live;
            }
            // Online but signed out: never queue work for a stale account.
            await forgetSessionIdentity();
            throw new Error("Please sign in before recording offline work");
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Please sign in")) throw error;
            // Network failure despite navigator.onLine: fall back below.
        }
    }

    const remembered = await getRememberedIdentity();
    if (!remembered) {
        throw new Error("Please sign in online at least once before working offline");
    }
    return remembered;
}
