
/*
 * Offline session core (no browser storage; testable in Node).
 *
 * WHAT THIS IS: a local, PIN-protected permission to record work while the
 * device has no connection, for the account that last signed in online on
 * this device. It is NEVER authentication for the server: every upload
 * still needs a valid server session, and the server re-checks the user,
 * role, permissions, ownership and dates. A PIN is never proof of payment.
 *
 * Record layout (one per tenant + user + device):
 *   - Encrypted core (AES-GCM, key = PBKDF2-SHA-256(PIN, random salt)):
 *     tenant, user and device IDs and a random nonce. The record key and
 *     nonce are bound as additional authenticated data, so a record cannot
 *     be moved to another account and any change makes decryption fail.
 *     Only a correct PIN can decrypt it; the PIN itself is never stored.
 *   - Renewable status (readable without the PIN, because it must be
 *     renewed after an online password login, when the PIN is not known):
 *     permissions reported by the server (display/convenience only), last
 *     successful online check, expiry (24 h after it), failed attempts and
 *     a clock high-water mark.
 *
 * LIMITS (best effort, by design): someone with technical access to the
 * unlocked browser profile can edit IndexedDB/JavaScript (reset the attempt
 * counter, extend the status, or try PINs offline against a copied record).
 * The server-side checks are the real protection.
 */

export const OFFLINE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;
export const PBKDF2_ITERATIONS = 600_000;
// Records claiming other iteration counts are rejected (no downgrade / DoS).
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 2_000_000;
// Allowed clock difference before a backwards clock is suspected.
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
// The permission required for offline work (approved decision).
export const OFFLINE_WORK_PERMISSION = "sales.create";

const RECORD_VERSION = 1;

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
    // Encrypted core.
    salt: string;
    iterations: number;
    iv: string;
    ciphertext: string;
    nonce: string;
    // Renewable status (best effort, see above).
    permissions: string[];
    lastOnlineCheckAt: string;
    expiresAt: string;
    failedAttempts: number;
    clockHighWater: number;
    createdAt: string;
    displayName?: string;
}

/** Proof of an unlock in this browser tab (holds no secret). */
export interface UnlockMarker {
    key: string;
    nonce: string;
    unlockedAt: number;
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
        failedAttempts: number;
        displayName?: string;
    };

export type UnlockResult =
    | { ok: true; marker: UnlockMarker; expiresAt: string }
    | { ok: false; reason: "none" | "invalid" | "expired" | "clock-rollback" | "locked-out" }
    | { ok: false; reason: "wrong-pin"; remainingAttempts: number };

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

// --------------------------------------------------------------- PIN rules

function isTrivialPin(pin: string): boolean {
    // All digits the same (000000, 777777).
    if (/^(\d)\1+$/.test(pin)) return true;

    // Straight ascending or descending runs (123456, 987654, 012345).
    const digits = [...pin].map(Number);
    const steps = digits.slice(1).map((d, i) => d - digits[i]);
    if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true;

    // A short block repeated (121212, 123123, 1212121212).
    for (let size = 1; size <= 4; size++) {
        if (pin.length % size === 0 && pin.length > size && pin === pin.slice(0, size).repeat(pin.length / size)) {
            return true;
        }
    }

    // Other very common PINs.
    const common = new Set([
        "112233", "111222", "121314", "123321", "654321", "159753", "147258",
        "258369", "789456", "456789", "102030", "100200", "696969", "131313",
        "520520", "123654", "147852", "142536", "246810", "135790", "000111",
    ]);
    return common.has(pin);
}

/** null when acceptable, otherwise the reason in plain language. */
export function validatePin(pin: unknown): string | null {
    if (typeof pin !== "string" || !/^\d+$/.test(pin)) {
        return "The PIN must contain digits only.";
    }
    if (pin.length < PIN_MIN_LENGTH) {
        return `The PIN must have at least ${PIN_MIN_LENGTH} digits.`;
    }
    if (pin.length > PIN_MAX_LENGTH) {
        return `The PIN must have at most ${PIN_MAX_LENGTH} digits.`;
    }
    if (isTrivialPin(pin)) {
        return "This PIN is too easy to guess. Avoid repeated digits, sequences and common PINs.";
    }
    return null;
}

// ------------------------------------------------------------------ crypto

function subtle(): SubtleCrypto {
    const api = globalThis.crypto?.subtle;
    if (!api) throw new Error("Secure cryptography is not available in this browser");
    return api;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
    return globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

const encoder = new TextEncoder();

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
    const material = await subtle().importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function additionalData(key: string, nonce: string) {
    return encoder.encode(`billing-offline-session:v${RECORD_VERSION}:${key}:${nonce}`);
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
        typeof r.salt !== "string" || typeof r.iv !== "string" ||
        typeof r.ciphertext !== "string" || typeof r.nonce !== "string" ||
        typeof r.iterations !== "number" || r.iterations < MIN_ITERATIONS || r.iterations > MAX_ITERATIONS ||
        !Array.isArray(r.permissions) || !r.permissions.every((p) => typeof p === "string") ||
        typeof r.failedAttempts !== "number" || r.failedAttempts < 0 || r.failedAttempts >= MAX_PIN_ATTEMPTS ||
        typeof r.clockHighWater !== "number" || !Number.isFinite(r.clockHighWater)
    ) {
        return false;
    }

    const lastCheck = Date.parse(String(r.lastOnlineCheckAt));
    const expires = Date.parse(String(r.expiresAt));
    // The expiry must be exactly 24 h after the last online check.
    return Number.isFinite(lastCheck) && Number.isFinite(expires) && expires - lastCheck === OFFLINE_SESSION_TTL_MS;
}

function clockMovedBack(record: OfflineSessionRecord, now: number): boolean {
    return (
        now < record.clockHighWater - CLOCK_SKEW_MS ||
        now < Date.parse(record.lastOnlineCheckAt) - CLOCK_SKEW_MS
    );
}

// ------------------------------------------------------------------ API

/**
 * Create (or replace) the offline session of an identity. The caller MUST
 * have just confirmed with the server that this identity's session is
 * valid, that no temporary password is pending and that the user holds
 * OFFLINE_WORK_PERMISSION.
 */
export async function createOfflineSession(
    store: OfflineSessionStore,
    input: { identity: OfflineIdentity; pin: string; permissions: string[]; displayName?: string; now: number }
): Promise<OfflineSessionRecord> {
    if (!isIdentity(input.identity)) throw new Error("A valid account and device are required");
    const pinProblem = validatePin(input.pin);
    if (pinProblem) throw new Error(pinProblem);

    const key = offlineSessionKey(input.identity);
    const nonce = toBase64(randomBytes(16));
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cryptoKey = await deriveKey(input.pin, salt, PBKDF2_ITERATIONS);

    const core = encoder.encode(JSON.stringify({ v: RECORD_VERSION, ...input.identity, nonce }));
    const ciphertext = new Uint8Array(
        await subtle().encrypt({ name: "AES-GCM", iv, additionalData: additionalData(key, nonce) }, cryptoKey, core)
    );

    const record: OfflineSessionRecord = {
        key,
        version: RECORD_VERSION,
        ...input.identity,
        salt: toBase64(salt),
        iterations: PBKDF2_ITERATIONS,
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        nonce,
        permissions: [...new Set(input.permissions.filter((p) => typeof p === "string"))],
        lastOnlineCheckAt: new Date(input.now).toISOString(),
        expiresAt: new Date(input.now + OFFLINE_SESSION_TTL_MS).toISOString(),
        failedAttempts: 0,
        clockHighWater: input.now,
        createdAt: new Date(input.now).toISOString(),
        displayName: input.displayName,
    };

    await store.put(record);
    return record;
}

/** Current state of an identity's offline session (no PIN needed). */
export async function getOfflineSessionState(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    now: number
): Promise<OfflineSessionState> {
    if (!isIdentity(identity)) return { status: "none" };
    const record = await store.get(offlineSessionKey(identity));
    if (!record) return { status: "none" };

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
        failedAttempts: record.failedAttempts,
        displayName: record.displayName,
    };
}

/** Try a PIN. Five wrong PINs delete the record (never queued work). */
export async function unlockOfflineSession(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    pin: string,
    now: number
): Promise<UnlockResult> {
    const state = await getOfflineSessionState(store, identity, now);
    if (state.status !== "available") return { ok: false, reason: state.status };

    const key = offlineSessionKey(identity);
    const record = (await store.get(key))!;

    let decrypted: { v?: unknown; tenantId?: unknown; userId?: unknown; deviceId?: unknown; nonce?: unknown } | null = null;
    if (typeof pin === "string" && /^\d+$/.test(pin)) {
        try {
            const cryptoKey = await deriveKey(pin, fromBase64(record.salt), record.iterations);
            const plain = await subtle().decrypt(
                { name: "AES-GCM", iv: fromBase64(record.iv), additionalData: additionalData(key, record.nonce) },
                cryptoKey,
                fromBase64(record.ciphertext)
            );
            decrypted = JSON.parse(new TextDecoder().decode(plain));
        } catch {
            decrypted = null; // wrong PIN, or the encrypted core was altered
        }
    }

    const matches =
        decrypted !== null &&
        decrypted.v === RECORD_VERSION &&
        decrypted.tenantId === identity.tenantId &&
        decrypted.userId === identity.userId &&
        decrypted.deviceId === identity.deviceId &&
        decrypted.nonce === record.nonce;

    if (!matches) {
        const failedAttempts = record.failedAttempts + 1;
        if (failedAttempts >= MAX_PIN_ATTEMPTS) {
            await store.delete(key);
            return { ok: false, reason: "locked-out" };
        }
        await store.put({ ...record, failedAttempts, clockHighWater: Math.max(record.clockHighWater, now) });
        return { ok: false, reason: "wrong-pin", remainingAttempts: MAX_PIN_ATTEMPTS - failedAttempts };
    }

    await store.put({ ...record, failedAttempts: 0, clockHighWater: Math.max(record.clockHighWater, now) });
    return { ok: true, marker: { key, nonce: record.nonce, unlockedAt: now }, expiresAt: record.expiresAt };
}

/**
 * Whether an unlock marker still allows offline work for this identity:
 * same account and device, same PIN setup (nonce), record present and
 * valid, not expired, clock not moved back, and OFFLINE_WORK_PERMISSION
 * reported by the server at the last online check.
 */
export async function checkOfflineWorkAllowed(
    store: OfflineSessionStore,
    marker: UnlockMarker | null,
    identity: OfflineIdentity,
    now: number
): Promise<{ ok: true; expiresAt: string } | { ok: false; reason: string }> {
    const state = await getOfflineSessionState(store, identity, now);
    if (state.status === "none" || state.status === "invalid") {
        return { ok: false, reason: "Offline access is not set up for this account on this device" };
    }
    if (state.status === "expired") {
        return { ok: false, reason: "The offline session has expired; sign in online to continue" };
    }
    if (state.status === "clock-rollback") {
        return { ok: false, reason: "The device clock appears to have moved backwards; sign in online to continue" };
    }
    if (!marker || marker.key !== offlineSessionKey(identity) || marker.unlockedAt > now + CLOCK_SKEW_MS) {
        return { ok: false, reason: "Unlock the offline session with your PIN first" };
    }
    const record = await store.get(offlineSessionKey(identity));
    if (!record || record.nonce !== marker.nonce) {
        return { ok: false, reason: "Unlock the offline session with your PIN first" };
    }
    if (!state.permissions.includes(OFFLINE_WORK_PERMISSION)) {
        return { ok: false, reason: "This account is not allowed to record sales offline" };
    }
    return { ok: true, expiresAt: state.expiresAt };
}

/**
 * After a SUCCESSFUL server session check for this identity: renew the
 * expiry (24 h from now) and refresh the permissions. No PIN is needed and
 * nothing is created when there is no record.
 */
export async function renewOfflineSession(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    permissions: string[],
    now: number
): Promise<boolean> {
    if (!isIdentity(identity)) return false;
    const record = await store.get(offlineSessionKey(identity));
    if (!record || !isWellFormed(record, identity)) return false;

    await store.put({
        ...record,
        permissions: [...new Set(permissions.filter((p) => typeof p === "string"))],
        lastOnlineCheckAt: new Date(now).toISOString(),
        expiresAt: new Date(now + OFFLINE_SESSION_TTL_MS).toISOString(),
        failedAttempts: 0,
        clockHighWater: Math.max(record.clockHighWater, now),
    });
    return true;
}

export async function deleteOfflineSession(store: OfflineSessionStore, identity: OfflineIdentity): Promise<void> {
    if (!isIdentity(identity)) return;
    await store.delete(offlineSessionKey(identity));
}
