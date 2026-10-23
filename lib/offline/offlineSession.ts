
/*
 * Offline session core (no browser storage; testable in Node).
 *
 * WHAT THIS IS: a local permission to record work while the device has no
 * connection, for the account (tenant + user + device) whose session was
 * last verified by the server on this device. It needs no PIN. It is NEVER
 * authentication for the server: every upload still needs a valid server
 * session, and the server re-checks the user, role, permissions, ownership
 * and dates.
 *
 * Validity: 72 hours after the last SUCCESSFUL online server verification,
 * measured from the SERVER's clock (serverTime returned by /api/auth/me).
 * Only activateOfflineSession moves the expiry, and callers use it only
 * after login, dashboard verification or account-page verification. Sync,
 * queueing, queue inspection, the users page, opening the app or working
 * offline never renew it.
 *
 * Clock checks (best effort):
 *  - At verification the device clock must be within 5 minutes of the
 *    server's; otherwise the session is NOT created or renewed.
 *  - A high-water mark of the device clock is kept in the record. It is
 *    reset at a verified online check and raised whenever offline work is
 *    checked or recorded (recordOfflineActivity). A clock found earlier than
 *    the mark (beyond a small tolerance) blocks offline work until the next
 *    online verification.
 *
 * Record layout (one per tenant + user + device, version 2): tenant, user
 * and device IDs, the permissions reported by the server (checked for
 * sales.create), the last successful online check (server time), the expiry
 * (72 h after it), the clock high-water mark and the creation time.
 *
 * Records written by the earlier PIN-based version (version 1) are never
 * treated as valid; the next successful online verification replaces them.
 * Queued work is stored elsewhere and is never touched here.
 *
 * LIMITS (not tamper-proof): everything here runs in the user's browser.
 * Someone with control of the device can set the clock back, edit
 * IndexedDB or JavaScript, extend the expiry or forge a record. Without a
 * PIN, anyone using the unlocked browser profile within the 72 hours can
 * record offline work as that account. The server-side checks at upload
 * time (session, owner, permissions, sale-date rules, idempotency) are the
 * real protection.
 */

export const OFFLINE_SESSION_TTL_MS = 72 * 60 * 60 * 1000;
// Allowed clock difference before a backwards clock is suspected.
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Largest difference between the device clock and the server clock at which
// the offline session may be created or renewed.
export const MAX_VERIFICATION_SKEW_MS = 5 * 60 * 1000;
// The permission required for offline work (approved decision).
export const OFFLINE_WORK_PERMISSION = "sales.create";
export const OFFLINE_PRODUCT_CREATE_PERMISSION = "products.create";

const RECORD_VERSION = 2;

export interface OfflineIdentity {
    tenantId: string;
    userId: string;
    deviceId: string;
}

export interface OfflineSessionRecord {
    key: string;
    version: number;
    tenantId: string;
    userId: string;
    deviceId: string;
    // Permissions reported by the server at the last online check.
    permissions: string[];
    // Server time of the last successful online verification.
    lastOnlineCheckAt: string;
    expiresAt: string;
    // Highest device-clock time seen (see the header comment).
    clockHighWater: number;
    createdAt: string;
    displayName?: string;
    // Device clock minus server clock at the last verification (information).
    serverSkewMs?: number;
}

export interface OfflineSessionStore {
    get(key: string): Promise<OfflineSessionRecord | undefined>;
    put(record: OfflineSessionRecord): Promise<void>;
    delete(key: string): Promise<void>;
}

export type OfflineSessionState =
    | { status: "none" }
    | { status: "invalid" }
    | { status: "clock-rollback"; expiresAt: string }
    | { status: "expired"; expiresAt: string; displayName?: string }
    | {
        status: "available";
        expiresAt: string;
        lastOnlineCheckAt: string;
        permissions: string[];
        displayName?: string;
    };

export type VerificationClock =
    | { ok: true; serverTime: number; skewMs: number }
    | { ok: false; reason: "no-server-time" | "clock-skew"; skewMs?: number };

/** Why an online verification could not create or renew the session. */
export class OfflineVerificationError extends Error {
    reason: "no-server-time" | "clock-skew";
    skewMs?: number;

    constructor(reason: "no-server-time" | "clock-skew", skewMs?: number) {
        super(
            reason === "no-server-time"
                ? "The server did not report its time"
                : "The device clock differs from the server clock by more than 5 minutes"
        );
        this.name = "OfflineVerificationError";
        this.reason = reason;
        this.skewMs = skewMs;
    }
}

const ID_PATTERN = /^[a-f\d]{24}$/i;

export function offlineSessionKey(identity: OfflineIdentity): string {
    return `${identity.tenantId}:${identity.userId}:${identity.deviceId}`;
}

function isIdentity(value: OfflineIdentity | null | undefined): value is OfflineIdentity {
    return Boolean(
        value &&
        ID_PATTERN.test(value.tenantId) &&
        ID_PATTERN.test(value.userId) &&
        ID_PATTERN.test(value.deviceId)
    );
}

/**
 * Compare the device clock with the server time reported by a successful
 * online verification. Not ok when the server time is missing or the
 * difference is more than MAX_VERIFICATION_SKEW_MS.
 */
export function checkVerificationClock(serverTime: number | null | undefined, now: number): VerificationClock {
    if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) {
        return { ok: false, reason: "no-server-time" };
    }
    const skewMs = now - serverTime;
    if (Math.abs(skewMs) > MAX_VERIFICATION_SKEW_MS) {
        return { ok: false, reason: "clock-skew", skewMs };
    }
    return { ok: true, serverTime, skewMs };
}

// ------------------------------------------------------------ validation

/** Structural and consistency checks of a stored record (tamper detection). */
function isWellFormed(record: OfflineSessionRecord, identity: OfflineIdentity): boolean {
    const r = record as Partial<OfflineSessionRecord>;
    if (
        r.version !== RECORD_VERSION ||
        r.key !== offlineSessionKey(identity) ||
        r.tenantId !== identity.tenantId ||
        r.userId !== identity.userId ||
        r.deviceId !== identity.deviceId ||
        !Array.isArray(r.permissions) || !r.permissions.every((p) => typeof p === "string") ||
        typeof r.clockHighWater !== "number" || !Number.isFinite(r.clockHighWater)
    ) {
        return false;
    }

    const lastCheck = Date.parse(String(r.lastOnlineCheckAt));
    const expires = Date.parse(String(r.expiresAt));
    // The expiry must be exactly 72 h after the last online check.
    return Number.isFinite(lastCheck) && Number.isFinite(expires) && expires - lastCheck === OFFLINE_SESSION_TTL_MS;
}

function clockMovedBack(record: OfflineSessionRecord, now: number): boolean {
    return (
        now < record.clockHighWater - CLOCK_SKEW_MS ||
        now < Date.parse(record.lastOnlineCheckAt) - CLOCK_SKEW_MS
    );
}

function cleanPermissions(permissions: string[]): string[] {
    return [...new Set(permissions.filter((p) => typeof p === "string"))];
}

// ------------------------------------------------------------------ API

/**
 * Create the offline session of an identity, or renew it (72 h from the
 * SERVER time) and refresh its permissions. The caller MUST have just
 * received a successful server verification of this identity's session with
 * no temporary password pending, and MUST only call this after login,
 * dashboard verification or account-page verification.
 *
 * Throws OfflineVerificationError (and changes nothing) when the server time
 * is missing or the device clock differs from it by more than five minutes.
 * A record left by the earlier PIN-based version, or a damaged one, is
 * replaced. Returns the stored record.
 */
export async function activateOfflineSession(
    store: OfflineSessionStore,
    input: { identity: OfflineIdentity; permissions: string[]; displayName?: string; now: number; serverTime: number | null | undefined }
): Promise<OfflineSessionRecord> {
    if (!isIdentity(input.identity)) throw new Error("A valid account and device are required");

    const clock = checkVerificationClock(input.serverTime, input.now);
    if (!clock.ok) throw new OfflineVerificationError(clock.reason, clock.skewMs);

    const key = offlineSessionKey(input.identity);
    const existing = await store.get(key);
    const reusable = existing && isWellFormed(existing, input.identity) ? existing : undefined;
    const serverIso = new Date(clock.serverTime).toISOString();

    const record: OfflineSessionRecord = {
        key,
        version: RECORD_VERSION,
        ...input.identity,
        permissions: cleanPermissions(input.permissions),
        lastOnlineCheckAt: serverIso,
        expiresAt: new Date(clock.serverTime + OFFLINE_SESSION_TTL_MS).toISOString(),
        // The device clock was just checked against the server, so the mark
        // restarts here (this also lets a corrected clock recover).
        clockHighWater: Math.max(input.now, clock.serverTime),
        createdAt: reusable?.createdAt ?? serverIso,
        displayName: input.displayName ?? reusable?.displayName,
        serverSkewMs: clock.skewMs,
    };

    await store.put(record);
    return record;
}

/** Current state of an identity's offline session. */
export async function getOfflineSessionState(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    now: number
): Promise<OfflineSessionState> {
    if (!isIdentity(identity)) return { status: "none" };
    const record = await store.get(offlineSessionKey(identity));
    if (!record) return { status: "none" };

    // Left by the earlier PIN-based version: not usable, replaced by the
    // next successful online verification.
    if ((record as Partial<OfflineSessionRecord>).version === 1) return { status: "none" };

    if (!isWellFormed(record, identity)) {
        // Tampered or corrupted: remove it (queued work is stored elsewhere
        // and is never touched here).
        await store.delete(offlineSessionKey(identity));
        return { status: "invalid" };
    }
    if (clockMovedBack(record, now)) return { status: "clock-rollback", expiresAt: record.expiresAt };
    if (now >= Date.parse(record.expiresAt)) {
        return { status: "expired", expiresAt: record.expiresAt, displayName: record.displayName };
    }

    return {
        status: "available",
        expiresAt: record.expiresAt,
        lastOnlineCheckAt: record.lastOnlineCheckAt,
        permissions: record.permissions,
        displayName: record.displayName,
    };
}

/**
 * Whether offline work is allowed for this identity: record present and
 * valid, not expired, clock not moved back, and OFFLINE_WORK_PERMISSION
 * reported by the server at the last online check. Read-only.
 */
export async function checkOfflineWorkAllowed(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    now: number
): Promise<{ ok: true; expiresAt: string } | { ok: false; reason: string }> {
    const state = await getOfflineSessionState(store, identity, now);
    if (state.status === "none" || state.status === "invalid") {
        return { ok: false, reason: "Offline access is not available for this account on this device; sign in online first" };
    }
    if (state.status === "expired") {
        return { ok: false, reason: "The offline session has expired; sign in online to continue" };
    }
    if (state.status === "clock-rollback") {
        return { ok: false, reason: "The device clock appears to have moved backwards; sign in online to continue" };
    }
    if (!state.permissions.includes(OFFLINE_WORK_PERMISSION)) {
        return { ok: false, reason: "This account is not allowed to record sales offline" };
    }
    return { ok: true, expiresAt: state.expiresAt };
}

/**
 * Whether offline product creation is allowed for this identity:
 * record present and valid, not expired, clock not moved back, and products.create
 * reported by the server at the last online check.
 * Also checks whether the user has cost permission (purchases.create, products.create, etc.).
 */
export async function checkOfflineProductCreationAllowed(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    now: number
): Promise<{ ok: true; expiresAt: string; canCost: boolean } | { ok: false; reason: string }> {
    const state = await getOfflineSessionState(store, identity, now);
    if (state.status === "none" || state.status === "invalid") {
        return { ok: false, reason: "Offline access is not available for this account on this device; sign in online first" };
    }
    if (state.status === "expired") {
        return { ok: false, reason: "The offline session has expired; sign in online to continue" };
    }
    if (state.status === "clock-rollback") {
        return { ok: false, reason: "The device clock appears to have moved backwards; sign in online to continue" };
    }
    if (!state.permissions.includes(OFFLINE_PRODUCT_CREATE_PERMISSION)) {
        return { ok: false, reason: "You do not have permission to create products" };
    }
    const canCost = state.permissions.some((p) =>
        ["products.create", "products.update", "purchases.create", "stock.adjust"].includes(p)
    );
    return { ok: true, expiresAt: state.expiresAt, canCost };
}

/**
 * Raise the clock high-water mark to `now` while the session is usable.
 * Called whenever offline work is checked or recorded. NEVER changes the
 * expiry or the last online check. Returns false (and writes nothing) when
 * there is no usable session, including a suspected clock rollback.
 */
export async function recordOfflineActivity(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    now: number
): Promise<boolean> {
    if (!isIdentity(identity)) return false;
    const state = await getOfflineSessionState(store, identity, now);
    if (state.status !== "available") return false;

    const record = await store.get(offlineSessionKey(identity));
    if (!record) return false;
    if (now > record.clockHighWater) {
        await store.put({ ...record, clockHighWater: now });
    }
    return true;
}

export async function deleteOfflineSession(store: OfflineSessionStore, identity: OfflineIdentity): Promise<void> {
    if (!isIdentity(identity)) return;
    await store.delete(offlineSessionKey(identity));
}
