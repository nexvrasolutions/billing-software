
/*
 * Offline session core tests (NO DATABASE, NO BROWSER, NO NETWORK).
 *
 * Exercises lib/offline/offlineSession.ts with an in-memory store. Queued
 * work is simulated in the same in-memory store (other keys) to prove the
 * offline session code never touches it.
 *
 * Run:
 *   npx tsx scripts/test-offline-session.ts
 */

import {
    CLOCK_SKEW_MS,
    MAX_VERIFICATION_SKEW_MS,
    OFFLINE_SESSION_TTL_MS,
    OFFLINE_WORK_PERMISSION,
    OfflineVerificationError,
    activateOfflineSession,
    checkOfflineWorkAllowed,
    checkVerificationClock,
    deleteOfflineSession,
    getOfflineSessionState,
    offlineSessionKey,
    recordOfflineActivity,
    type OfflineIdentity,
    type OfflineSessionRecord,
    type OfflineSessionStore,
} from "../lib/offline/offlineSession";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

/** In-memory store. `queue` stands in for queued sales in the same database. */
function memoryStore() {
    const sessions = new Map<string, OfflineSessionRecord>();
    const queue = new Map<string, unknown>([
        ["q1", { operationId: "q1", entityType: "Sale", status: "PENDING", payload: { invoiceNo: "A-1" } }],
        ["q2", { operationId: "q2", entityType: "Sale", status: "FAILED", payload: { invoiceNo: "A-2" } }],
    ]);
    const queueSnapshot = JSON.stringify([...queue]);
    const store: OfflineSessionStore = {
        get: async (key) => (sessions.has(key) ? structuredClone(sessions.get(key)!) : undefined),
        put: async (record) => { sessions.set(record.key, structuredClone(record)); },
        delete: async (key) => { sessions.delete(key); },
    };
    return { store, sessions, queueUnchanged: () => JSON.stringify([...queue]) === queueSnapshot };
}

const id = (n: number) => n.toString(16).padStart(24, "0");
const alice: OfflineIdentity = { tenantId: id(1), userId: id(2), deviceId: id(3) };
const bob: OfflineIdentity = { tenantId: id(1), userId: id(4), deviceId: id(3) };
const aliceOtherDevice: OfflineIdentity = { ...alice, deviceId: id(5) };
const aliceOtherTenant: OfflineIdentity = { ...alice, tenantId: id(6) };
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const perms = [OFFLINE_WORK_PERMISSION, "taxes.read"];

/** Online verification: the server clock reads `serverTime` when the device clock reads `now`. */
function verify(
    store: OfflineSessionStore,
    identity: OfflineIdentity,
    now: number,
    options: { serverTime?: number | null; permissions?: string[]; displayName?: string } = {}
) {
    return activateOfflineSession(store, {
        identity,
        permissions: options.permissions ?? perms,
        displayName: options.displayName,
        now,
        serverTime: options.serverTime === undefined ? now : options.serverTime,
    });
}

async function refused(work: () => Promise<unknown>): Promise<OfflineVerificationError | null> {
    try {
        await work();
        return null;
    } catch (error) {
        return error instanceof OfflineVerificationError ? error : null;
    }
}

async function main() {
    // ------------------------------------------------------------ validity period
    check("V1. The offline validity period is exactly 72 hours (3 days)",
        OFFLINE_SESSION_TTL_MS === 72 * HOUR && OFFLINE_SESSION_TTL_MS === 3 * 24 * HOUR);
    check("V2. The verification clock tolerance is exactly five minutes", MAX_VERIFICATION_SKEW_MS === 5 * MIN);

    // ------------------------------------------------------------ create
    const s = memoryStore();
    const record = await verify(s.store, alice, T0 + 2 * MIN, { serverTime: T0, displayName: "Alice" });
    check("C1. A session is created from an online verification without any PIN",
        s.sessions.has(offlineSessionKey(alice)) && !JSON.stringify(record).toLowerCase().includes("pin"));
    check("C2. The record holds no secret/crypto material (no salt, iv, ciphertext, nonce, attempts)",
        !["salt", "iv", "ciphertext", "nonce", "iterations", "failedAttempts"].some((k) => k in record));
    check("C3. The record is bound to tenant, user and device",
        record.key === offlineSessionKey(alice) && record.tenantId === alice.tenantId
        && record.userId === alice.userId && record.deviceId === alice.deviceId);
    check("C4. Expiry is exactly 72 hours after the SERVER time of the check (not the device clock); permissions kept",
        Date.parse(record.expiresAt) - Date.parse(record.lastOnlineCheckAt) === 72 * HOUR
        && Date.parse(record.lastOnlineCheckAt) === T0 && Date.parse(record.expiresAt) === T0 + 72 * HOUR
        && record.permissions.includes(OFFLINE_WORK_PERMISSION));
    check("C5. The device-minus-server difference is recorded for information", record.serverSkewMs === 2 * MIN);
    let invalidIdentity = false;
    try { await verify(s.store, { tenantId: "x", userId: "y", deviceId: "z" }, T0); }
    catch { invalidIdentity = true; }
    check("C6. A malformed identity is refused", invalidIdentity);

    // ------------------------------------------------------------ clock skew at verification
    check("S1. A difference of exactly five minutes (either direction) is accepted",
        checkVerificationClock(T0, T0 + 5 * MIN).ok && checkVerificationClock(T0, T0 - 5 * MIN).ok);
    check("S2. A difference of five minutes and one millisecond is rejected (either direction)",
        !checkVerificationClock(T0, T0 + 5 * MIN + 1).ok && !checkVerificationClock(T0, T0 - 5 * MIN - 1).ok);
    check("S3. Missing, non-numeric or non-finite server time is rejected",
        [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "2026-10-12" as unknown as number].every((v) => {
            const result = checkVerificationClock(v, T0);
            return !result.ok && result.reason === "no-server-time";
        }));

    {
        const t = memoryStore();
        await verify(t.store, alice, T0);
        const before = JSON.stringify(t.sessions.get(offlineSessionKey(alice)));

        const ahead = await refused(() => verify(t.store, alice, T0 + 2 * HOUR, { serverTime: T0 + 2 * HOUR - 5 * MIN - 1 }));
        check("S4. A device clock ahead of the server by more than five minutes cannot renew (error clock-skew)",
            ahead?.reason === "clock-skew");
        const behind = await refused(() => verify(t.store, alice, T0 + 2 * HOUR, { serverTime: T0 + 2 * HOUR + 5 * MIN + 1 }));
        check("S5. A device clock behind the server by more than five minutes cannot renew (error clock-skew)",
            behind?.reason === "clock-skew");
        const noTime = await refused(() => verify(t.store, alice, T0 + 2 * HOUR, { serverTime: null }));
        check("S6. A verification without server time cannot renew (error no-server-time)", noTime?.reason === "no-server-time");
        check("S7. Every refused renewal left the existing record exactly as it was",
            JSON.stringify(t.sessions.get(offlineSessionKey(alice))) === before);

        const fresh = memoryStore();
        const refusedNew = await refused(() => verify(fresh.store, bob, T0, { serverTime: T0 + HOUR }));
        check("S8. A refused verification creates no session", refusedNew !== null && fresh.sessions.size === 0);
    }

    // ------------------------------------------------------------ PIN-free offline work
    const allowed = await checkOfflineWorkAllowed(s.store, alice, T0 + HOUR);
    check("U1. Offline work is allowed with no PIN or unlock step", allowed.ok);
    check("U2. ...and stays allowed at 71 h 59 min after the server check",
        (await checkOfflineWorkAllowed(s.store, alice, T0 + 72 * HOUR - 60_000)).ok);

    // ------------------------------------------------------------ expiry and renewal
    const atExpiry = T0 + OFFLINE_SESSION_TTL_MS;
    check("E1. At 24 hours the session is NOT expired any more (old limit)",
        (await getOfflineSessionState(s.store, alice, T0 + 24 * HOUR)).status === "available");
    check("E2. At 72 hours the session is expired", (await getOfflineSessionState(s.store, alice, atExpiry)).status === "expired");
    const expiredWork = await checkOfflineWorkAllowed(s.store, alice, atExpiry);
    check("E3. An expired session blocks new offline work", !expiredWork.ok && /expired/i.test(expiredWork.reason));
    check("E4. Expiry keeps the record (renewable) and leaves queued work untouched",
        s.sessions.has(record.key) && s.queueUnchanged());

    // Checking state / working offline never extends the expiry.
    const expiryBefore = s.sessions.get(record.key)!.expiresAt;
    const checkedBefore = s.sessions.get(record.key)!.lastOnlineCheckAt;
    for (let i = 1; i <= 5; i++) {
        await getOfflineSessionState(s.store, alice, T0 + i * 10 * HOUR);
        await checkOfflineWorkAllowed(s.store, alice, T0 + i * 10 * HOUR);
        await recordOfflineActivity(s.store, alice, T0 + i * 10 * HOUR);
    }
    check("E5. Opening the app / offline work / recording activity does not extend the expiry or the last online check",
        s.sessions.get(record.key)!.expiresAt === expiryBefore
        && s.sessions.get(record.key)!.lastOnlineCheckAt === checkedBefore);

    const renewedAt = atExpiry + HOUR;
    const renewed = await verify(s.store, alice, renewedAt);
    check("E6. A successful online verification renews the window to 72 hours from the server time",
        Date.parse(renewed.expiresAt) === renewedAt + OFFLINE_SESSION_TTL_MS
        && Date.parse(s.sessions.get(record.key)!.expiresAt) === renewedAt + OFFLINE_SESSION_TTL_MS);
    check("E7. After renewal, offline work is allowed again", (await checkOfflineWorkAllowed(s.store, alice, renewedAt + HOUR)).ok);

    const reactivatedAt = renewedAt + 10 * HOUR;
    const again = await verify(s.store, alice, reactivatedAt);
    check("E8. Verifying again renews to 72 h and keeps the creation time and display name",
        Date.parse(again.expiresAt) === reactivatedAt + OFFLINE_SESSION_TTL_MS && again.createdAt === record.createdAt
        && again.displayName === "Alice");

    // ------------------------------------------------------------ permission gate
    await verify(s.store, alice, reactivatedAt + HOUR, { permissions: ["taxes.read"] });
    const noPerm = await checkOfflineWorkAllowed(s.store, alice, reactivatedAt + 2 * HOUR);
    check("P1. Without sales.create reported by the server, offline work is refused", !noPerm.ok && /not allowed/i.test(noPerm.reason));
    await verify(s.store, alice, reactivatedAt + 2 * HOUR);

    // ------------------------------------------------------------ clock moved back
    const now2 = reactivatedAt + 3 * HOUR;
    await verify(s.store, alice, now2); // a verified check restarts the high-water mark here
    const backwards = now2 - CLOCK_SKEW_MS - 60_000;
    check("K1. A clock moved backwards beyond the tolerance is detected",
        (await getOfflineSessionState(s.store, alice, backwards)).status === "clock-rollback");
    check("K2. Offline work is blocked while the clock is behind", !(await checkOfflineWorkAllowed(s.store, alice, backwards)).ok);
    check("K3. A small clock difference (within tolerance) is accepted",
        (await getOfflineSessionState(s.store, alice, now2 - 60_000)).status === "available");

    // ------------------------------------------------------------ high-water mark during offline use
    {
        const t = memoryStore();
        await verify(t.store, alice, T0);
        const expiry = t.sessions.get(offlineSessionKey(alice))!.expiresAt;

        check("H1. Offline use raises the persisted high-water mark",
            (await recordOfflineActivity(t.store, alice, T0 + 60 * HOUR))
            && t.sessions.get(offlineSessionKey(alice))!.clockHighWater === T0 + 60 * HOUR);
        check("H2. ...but never the expiry or the last online check",
            t.sessions.get(offlineSessionKey(alice))!.expiresAt === expiry
            && t.sessions.get(offlineSessionKey(alice))!.lastOnlineCheckAt === new Date(T0).toISOString());
        check("H3. A clock set back after offline use (to just after the last online check) is now detected",
            (await getOfflineSessionState(t.store, alice, T0 + HOUR)).status === "clock-rollback"
            && !(await checkOfflineWorkAllowed(t.store, alice, T0 + HOUR)).ok);
        check("H4. A clock set back is not accepted as activity and does not lower the mark",
            !(await recordOfflineActivity(t.store, alice, T0 + HOUR))
            && t.sessions.get(offlineSessionKey(alice))!.clockHighWater === T0 + 60 * HOUR);
        check("H5. An earlier time within the tolerance never lowers the mark",
            (await recordOfflineActivity(t.store, alice, T0 + 60 * HOUR - MIN))
            && t.sessions.get(offlineSessionKey(alice))!.clockHighWater === T0 + 60 * HOUR);
        check("H6. Activity is not recorded for an expired session or for an account without one",
            !(await recordOfflineActivity(t.store, alice, T0 + 80 * HOUR)) && !(await recordOfflineActivity(t.store, bob, T0 + HOUR)));

        // Recovery: the corrected clock is checked against the server at the next online verification.
        const recoveredAt = T0 + 61 * HOUR;
        await verify(t.store, alice, recoveredAt);
        check("H7. A verified online check with a correct clock restarts the mark and offline work works again",
            t.sessions.get(offlineSessionKey(alice))!.clockHighWater === recoveredAt
            && (await checkOfflineWorkAllowed(t.store, alice, recoveredAt + HOUR)).ok);
    }

    // ------------------------------------------------------------ tenant / user / device isolation
    const now3 = now2 + 60_000;
    check("I1. Another user on the same device has no session", (await getOfflineSessionState(s.store, bob, now3)).status === "none");
    check("I2. Alice's session does not allow offline work as Bob", !(await checkOfflineWorkAllowed(s.store, bob, now3)).ok);
    check("I3. The same user on another device has no session",
        !(await checkOfflineWorkAllowed(s.store, aliceOtherDevice, now3)).ok);
    check("I4. The same user ID under another tenant has no session",
        !(await checkOfflineWorkAllowed(s.store, aliceOtherTenant, now3)).ok);

    await verify(s.store, bob, now3);
    check("I5. Bob and Alice have independent records",
        s.sessions.size === 2 && s.sessions.get(offlineSessionKey(bob))!.userId === bob.userId);

    // Alice's record copied into Bob's slot (relabelled) must not be accepted for Bob.
    const aliceRecord = s.sessions.get(offlineSessionKey(alice))!;
    s.sessions.set(offlineSessionKey(bob), { ...aliceRecord, key: offlineSessionKey(bob) });
    const swapped = await getOfflineSessionState(s.store, bob, now3);
    check("I6. Alice's record moved into Bob's slot is rejected as invalid and removed",
        swapped.status === "invalid" && !s.sessions.has(offlineSessionKey(bob)));

    await verify(s.store, bob, now3);
    await deleteOfflineSession(s.store, bob);
    check("I7. Deleting Bob's session leaves Alice's session and the queue untouched",
        s.sessions.has(offlineSessionKey(alice)) && !s.sessions.has(offlineSessionKey(bob)) && s.queueUnchanged());

    // ------------------------------------------------------------ tampering
    const tamper = async (change: (r: OfflineSessionRecord) => OfflineSessionRecord) => {
        const t = memoryStore();
        await verify(t.store, alice, T0);
        const key = offlineSessionKey(alice);
        t.sessions.set(key, change(structuredClone(t.sessions.get(key)!)));
        return { t, key };
    };

    for (const [label, change] of [
        ["an extended expiry", (r: OfflineSessionRecord) => ({ ...r, expiresAt: new Date(Date.parse(r.expiresAt) + 48 * HOUR).toISOString() })],
        ["an old 24-hour expiry", (r: OfflineSessionRecord) => ({ ...r, expiresAt: new Date(Date.parse(r.lastOnlineCheckAt) + 24 * HOUR).toISOString() })],
        ["a different user ID in the plain fields", (r: OfflineSessionRecord) => ({ ...r, userId: bob.userId })],
        ["a different tenant ID in the plain fields", (r: OfflineSessionRecord) => ({ ...r, tenantId: aliceOtherTenant.tenantId })],
        ["a different device ID in the plain fields", (r: OfflineSessionRecord) => ({ ...r, deviceId: aliceOtherDevice.deviceId })],
        ["invalid permissions", (r: OfflineSessionRecord) => ({ ...r, permissions: "sales.create" as unknown as string[] })],
        ["a missing timestamp", (r: OfflineSessionRecord) => { const copy = { ...r } as Partial<OfflineSessionRecord>; delete copy.lastOnlineCheckAt; return copy as OfflineSessionRecord; }],
        ["a non-numeric high-water mark", (r: OfflineSessionRecord) => ({ ...r, clockHighWater: "x" as unknown as number })],
    ] as const) {
        const { t, key } = await tamper(change);
        const state = await getOfflineSessionState(t.store, alice, T0 + HOUR);
        check(`T1. A record with ${label} is detected as invalid and removed (queue untouched)`,
            state.status === "invalid" && !t.sessions.has(key) && t.queueUnchanged(), state.status);
    }
    {
        const { t, key } = await tamper((r) => ({ ...r, userId: bob.userId }));
        const result = await checkOfflineWorkAllowed(t.store, alice, T0 + HOUR);
        check("T2. A tampered record does not allow offline work", !result.ok && !t.sessions.has(key));
    }

    // ------------------------------------------------------------ records of the earlier PIN-based version
    {
        const t = memoryStore();
        const key = offlineSessionKey(alice);
        const legacy = {
            key, version: 1, ...alice, salt: "AAAA", iterations: 600_000, iv: "AAAA", ciphertext: "AAAA", nonce: "AAAA",
            permissions: perms, lastOnlineCheckAt: new Date(T0).toISOString(),
            expiresAt: new Date(T0 + 24 * HOUR).toISOString(), failedAttempts: 0, clockHighWater: T0, createdAt: new Date(T0).toISOString(),
        };
        t.sessions.set(key, legacy as unknown as OfflineSessionRecord);
        check("M1. A leftover PIN-era record gives no offline access", !(await checkOfflineWorkAllowed(t.store, alice, T0 + HOUR)).ok);
        check("M2. ...but it is kept (not deleted) by a state check",
            (await getOfflineSessionState(t.store, alice, T0 + HOUR)).status === "none" && t.sessions.has(key));
        check("M3. Offline activity does not revive a PIN-era record", !(await recordOfflineActivity(t.store, alice, T0 + 2 * HOUR)));
        const migrated = await verify(t.store, alice, T0 + 3 * HOUR);
        check("M4. The next online verification replaces it with a 72-hour PIN-free record",
            migrated.version === 2 && Date.parse(migrated.expiresAt) === T0 + 3 * HOUR + 72 * HOUR
            && (await checkOfflineWorkAllowed(t.store, alice, T0 + 4 * HOUR)).ok && t.queueUnchanged());
    }

    // ------------------------------------------------------------ logout / revocation
    {
        const t = memoryStore();
        await verify(t.store, alice, T0);
        await deleteOfflineSession(t.store, alice);
        check("D1. After logout/revocation (session deleted) offline work is refused, queue untouched",
            !(await checkOfflineWorkAllowed(t.store, alice, T0 + HOUR)).ok && t.queueUnchanged());
    }

    check("Q1. Across all scenarios the simulated queued sales were never modified", s.queueUnchanged());

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((error: unknown) => {
    console.error("Offline session tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
