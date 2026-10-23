
import type { SessionIdentity } from "./syncPolicy";

/*
 * Pure decisions about what a successful /api/auth/me answer means for the
 * offline session (no browser APIs, unit-testable).
 *
 * The 72-hour offline authorization may be renewed ONLY after a successful
 * online server verification made by login, the dashboard or the account
 * page, which pass renew: true. Sync, queueing, queue inspection and the
 * users page verify the session too but never renew (renew is false).
 */

const ID_PATTERN = /^[a-f\d]{24}$/i;

function toIdentity(value: unknown): SessionIdentity | null {
    const v = value as Partial<SessionIdentity> | null;
    return v && typeof v.tenantId === "string" && typeof v.userId === "string" && typeof v.deviceId === "string"
        ? { tenantId: v.tenantId, userId: v.userId, deviceId: v.deviceId }
        : null;
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

/** Server time (ms) reported by /api/auth/me, or null when missing/invalid. */
export function serverTimeFromMe(data: unknown): number | null {
    const value = (data as { serverTime?: unknown } | null)?.serverTime;
    if (typeof value !== "string") return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

export type ConfirmationPlan =
    // The body did not identify an account.
    | { kind: "no-identity" }
    // A temporary password is pending: remove that account's offline session
    // and forget the remembered identity. Never renews.
    | { kind: "temporary-password"; identity: SessionIdentity }
    // The session is valid. `renew` says whether the offline session may be
    // created/renewed now.
    | {
        kind: "verified";
        identity: SessionIdentity;
        renew: boolean;
        permissions: string[];
        displayName?: string;
        serverTime: number | null;
    };

export function planSessionConfirmation(data: unknown, options: { renew: boolean }): ConfirmationPlan {
    const identity = identityFromMe(data);
    if (!identity) return { kind: "no-identity" };

    const body = data as { user?: { mustChangePassword?: unknown; name?: unknown }; permissions?: unknown } | null;

    if (body?.user?.mustChangePassword === true) {
        return { kind: "temporary-password", identity };
    }

    const permissions = Array.isArray(body?.permissions)
        ? body.permissions.filter((p): p is string => typeof p === "string")
        : [];

    return {
        kind: "verified",
        identity,
        // Strictly opt-in: anything but an explicit true never renews.
        renew: options.renew === true && ID_PATTERN.test(identity.userId),
        permissions,
        displayName: typeof body?.user?.name === "string" ? body.user.name : undefined,
        serverTime: serverTimeFromMe(data),
    };
}

/** Pricing mode reported by /api/auth/me, defaulting to 'tax_inclusive'. */
export function pricingModeFromMe(data: unknown): "tax_inclusive" | "tax_exclusive" {
    const mode = (data as { tenant?: { pricingMode?: unknown } } | null)?.tenant?.pricingMode;
    return mode === "tax_exclusive" ? "tax_exclusive" : "tax_inclusive";
}

