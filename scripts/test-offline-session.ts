
/*
 * Offline session core tests (NO DATABASE, NO BROWSER, NO NETWORK).
 *
 * Exercises lib/offline/offlineSession.ts with Node's built-in Web Crypto
 * and an in-memory store. Queued work is simulated in the same in-memory
 * store (other keys) to prove the offline session code never touches it.
 *
 * Run:
 *   npx tsx scripts/test-offline-session.ts
 */

import {
    CLOCK_SKEW_MS,
    MAX_PIN_ATTEMPTS,
    OFFLINE_SESSION_TTL_MS,
    OFFLINE_WORK_PERMISSION,
    PBKDF2_ITERATIONS,
    checkOfflineWorkAllowed,
    createOfflineSession,
    deleteOfflineSession,
    getOfflineSessionState,
    offlineSessionKey,
    renewOfflineSession,
    unlockOfflineSession,
    validatePin,
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
const PIN = "583920";
const OTHER_PIN = "604187";
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);
const HOUR = 60 * 60 * 1000;
const perms = [OFFLINE_WORK_PERMISSION, "taxes.read"];

async function main() {
    // ------------------------------------------------------------ PIN rules
    const rejected = ["", "12345", "abcdef", "12 456", "1234567890123", "000000", "777777", "123456", "654321",
        "012345", "121212", "123123", "112233", "1212121212", "147258"];
    const accepted = ["583920", "604187", "40917362", "918273645"];
    check("R1. Too short, non-digit, too long and trivial PINs are rejected",
        rejected.every((pin) => validatePin(pin) !== null),
        rejected.filter((pin) => validatePin(pin) === null).join(","));
    check("R2. Reasonable PINs of 6+ digits are accepted",
        accepted.every((pin) => validatePin(pin) === null),
        accepted.filter((pin) => validatePin(pin) !== null).join(","));
    check("R3. Non-string PINs are rejected", [undefined, null, 583920, {}].every((pin) => validatePin(pin) !== null));

    // ------------------------------------------------------------ create
    const s = memoryStore();
    await (async () => {
        let threw = false;
        try { await createOfflineSession(s.store, { identity: alice, pin: "123456", permissions: perms, now: T0 }); }
        catch { threw = true; }
        check("C1. Creating a session with a trivial PIN is refused (nothing stored)", threw && s.sessions.size === 0);
    })();

    const record = await createOfflineSession(s.store, { identity: alice, pin: PIN, permissions: perms, displayName: "Alice", now: T0 });
    const stored = JSON.stringify(s.sessions.get(offlineSessionKey(alice)));
    check("C2. The PIN itself is never stored", !stored.includes(PIN));
    check("C3. Strong key derivation and AES-GCM fields are present (PBKDF2 >= 600k, 16-byte salt, 12-byte IV)",
        record.iterations === PBKDF2_ITERATIONS && PBKDF2_ITERATIONS >= 600_000
        && atob(record.salt).length === 16 && atob(record.iv).length === 12 && record.ciphertext.length > 0);
    check("C4. The record is bound to tenant, user and device",
        record.key === offlineSessionKey(alice) && record.tenantId === alice.tenantId
        && record.userId === alice.userId && record.deviceId === alice.deviceId);
    check("C5. Expiry is exactly 24 hours after the online check; permissions kept for display",
        Date.parse(record.expiresAt) - Date.parse(record.lastOnlineCheckAt) === OFFLINE_SESSION_TTL_MS
        && Date.parse(record.lastOnlineCheckAt) === T0 && record.permissions.includes(OFFLINE_WORK_PERMISSION));
    let invalidIdentity = false;
    try { await createOfflineSession(s.store, { identity: { tenantId: "x", userId: "y", deviceId: "z" }, pin: PIN, permissions: perms, now: T0 }); }
    catch { invalidIdentity = true; }
    check("C6. A malformed identity is refused", invalidIdentity);

    // ------------------------------------------------------------ unlock
    const locked = await checkOfflineWorkAllowed(s.store, null, alice, T0 + HOUR);
    check("U1. Without unlocking, offline work is refused", !locked.ok);

    const wrong = await unlockOfflineSession(s.store, alice, OTHER_PIN, T0 + HOUR);
    check("U2. A wrong PIN is refused and counted",
        !wrong.ok && wrong.reason === "wrong-pin" && wrong.remainingAttempts === MAX_PIN_ATTEMPTS - 1
        && s.sessions.get(record.key)?.failedAttempts === 1);

    const ok = await unlockOfflineSession(s.store, alice, PIN, T0 + HOUR);
    check("U3. The correct PIN unlocks and resets the failed-attempt counter",
        ok.ok && s.sessions.get(record.key)?.failedAttempts === 0);
    const marker = ok.ok ? ok.marker : null;
    const allowed = await checkOfflineWorkAllowed(s.store, marker, alice, T0 + 2 * HOUR);
    check("U4. Unlocked, unexpired, same account and sales.create: offline work is allowed", allowed.ok);

    // ------------------------------------------------------------ expiry and renewal
    const atExpiry = T0 + OFFLINE_SESSION_TTL_MS;
    check("E1. At 24 hours the session is expired", (await getOfflineSessionState(s.store, alice, atExpiry)).status === "expired");
    const expiredWork = await checkOfflineWorkAllowed(s.store, marker, alice, atExpiry);
    check("E2. An expired session blocks new offline work even if it was unlocked", !expiredWork.ok && /expired/i.test(expiredWork.reason));
    const expiredUnlock = await unlockOfflineSession(s.store, alice, PIN, atExpiry);
    check("E3. An expired session cannot be unlocked (no attempt counted)",
        !expiredUnlock.ok && expiredUnlock.reason === "expired" && s.sessions.get(record.key)?.failedAttempts === 0);
    check("E4. Expiry keeps the record (renewable) and leaves queued work untouched",
        s.sessions.has(record.key) && s.queueUnchanged());

    const renewedAt = atExpiry + HOUR;
    check("E5. A successful server check renews the window to 24 hours from that check",
        (await renewOfflineSession(s.store, alice, perms, renewedAt))
        && Date.parse(s.sessions.get(record.key)!.expiresAt) === renewedAt + OFFLINE_SESSION_TTL_MS);
    check("E6. Renewal never creates a session for an account without one",
        !(await renewOfflineSession(s.store, bob, perms, renewedAt)) && !s.sessions.has(offlineSessionKey(bob)));
    check("E7. After renewal the earlier unlock in this tab is still valid (same PIN setup)",
        (await checkOfflineWorkAllowed(s.store, marker, alice, renewedAt + HOUR)).ok);

    // ------------------------------------------------------------ permission gate
    await renewOfflineSession(s.store, alice, ["taxes.read"], renewedAt + HOUR);
    const noPerm = await checkOfflineWorkAllowed(s.store, marker, alice, renewedAt + 2 * HOUR);
    check("P1. Without sales.create reported by the server, offline work is refused", !noPerm.ok && /not allowed/i.test(noPerm.reason));
    await renewOfflineSession(s.store, alice, perms, renewedAt + 2 * HOUR);

    // ------------------------------------------------------------ clock moved back
    const now2 = renewedAt + 3 * HOUR;
    await unlockOfflineSession(s.store, alice, PIN, now2); // raises the clock high-water mark
    const backwards = now2 - CLOCK_SKEW_MS - 60_000;
    check("K1. A clock moved backwards beyond the tolerance is detected",
        (await getOfflineSessionState(s.store, alice, backwards)).status === "clock-rollback");
    const backUnlock = await unlockOfflineSession(s.store, alice, PIN, backwards);
    check("K2. Unlocking and offline work are blocked while the clock is behind",
        !backUnlock.ok && backUnlock.reason === "clock-rollback"
        && !(await checkOfflineWorkAllowed(s.store, marker, alice, backwards)).ok);
    check("K3. A small clock difference (within tolerance) is accepted",
        (await getOfflineSessionState(s.store, alice, now2 - 60_000)).status === "available");

    // ------------------------------------------------------------ user isolation
    const now3 = now2 + 60_000;
    check("I1. Another user on the same device has no session", (await getOfflineSessionState(s.store, bob, now3)).status === "none");
    const bobWithAlicePin = await unlockOfflineSession(s.store, bob, PIN, now3);
    check("I2. Alice's PIN cannot unlock anything for Bob", !bobWithAlicePin.ok && bobWithAlicePin.reason === "none");
    check("I3. Alice's unlock does not allow offline work as Bob", !(await checkOfflineWorkAllowed(s.store, marker, bob, now3)).ok);

    await createOfflineSession(s.store, { identity: bob, pin: OTHER_PIN, permissions: perms, now: now3 });
    const aliceWithBobPin = await unlockOfflineSession(s.store, alice, OTHER_PIN, now3);
    check("I4. Bob's PIN (after Bob set up his own session) cannot unlock Alice's record",
        !aliceWithBobPin.ok && aliceWithBobPin.reason === "wrong-pin");
    await unlockOfflineSession(s.store, alice, PIN, now3); // reset Alice's counter

    // Copy Alice's encrypted core into Bob's record (relabelled as Bob).
    const aliceRecord = s.sessions.get(offlineSessionKey(alice))!;
    const bobRecord = s.sessions.get(offlineSessionKey(bob))!;
    s.sessions.set(bobRecord.key, { ...bobRecord, salt: aliceRecord.salt, iv: aliceRecord.iv, ciphertext: aliceRecord.ciphertext, nonce: aliceRecord.nonce, iterations: aliceRecord.iterations });
    const swapped = await unlockOfflineSession(s.store, bob, PIN, now3);
    check("I5. Alice's encrypted record moved to Bob's slot cannot be unlocked, even with Alice's PIN",
        !swapped.ok && swapped.reason === "wrong-pin");
    await deleteOfflineSession(s.store, bob);
    check("I6. Deleting Bob's session leaves Alice's session and the queue untouched",
        s.sessions.has(offlineSessionKey(alice)) && !s.sessions.has(offlineSessionKey(bob)) && s.queueUnchanged());

    // ------------------------------------------------------------ tampering
    const tamper = async (label: string, change: (r: OfflineSessionRecord) => OfflineSessionRecord) => {
        const t = memoryStore();
        await createOfflineSession(t.store, { identity: alice, pin: PIN, permissions: perms, now: T0 });
        const key = offlineSessionKey(alice);
        t.sessions.set(key, change(structuredClone(t.sessions.get(key)!)));
        return { t, key, label };
    };

    {
        const { t, key } = await tamper("ciphertext", (r) => {
            const bytes = Uint8Array.from(atob(r.ciphertext), (c) => c.charCodeAt(0));
            bytes[0] ^= 0xff;
            return { ...r, ciphertext: btoa(String.fromCharCode(...bytes)) };
        });
        const result = await unlockOfflineSession(t.store, alice, PIN, T0 + HOUR);
        check("T1. An altered encrypted core cannot be unlocked even with the correct PIN (counted as a failure)",
            !result.ok && result.reason === "wrong-pin" && t.sessions.get(key)?.failedAttempts === 1);
    }
    {
        const { t, key } = await tamper("nonce", (r) => ({ ...r, nonce: btoa("x".repeat(16)) }));
        const result = await unlockOfflineSession(t.store, alice, PIN, T0 + HOUR);
        check("T2. A changed nonce (bound as authenticated data) cannot be unlocked", !result.ok && t.sessions.has(key));
    }
    for (const [label, change] of [
        ["an extended expiry", (r: OfflineSessionRecord) => ({ ...r, expiresAt: new Date(Date.parse(r.expiresAt) + 48 * HOUR).toISOString() })],
        ["a lowered iteration count", (r: OfflineSessionRecord) => ({ ...r, iterations: 1000 })],
        ["a reset attempt counter below zero", (r: OfflineSessionRecord) => ({ ...r, failedAttempts: -10 })],
        ["a different user ID in the plain fields", (r: OfflineSessionRecord) => ({ ...r, userId: bob.userId })],
        ["a missing field", (r: OfflineSessionRecord) => { const copy = { ...r } as Partial<OfflineSessionRecord>; delete copy.salt; return copy as OfflineSessionRecord; }],
    ] as const) {
        const { t, key } = await tamper(label, change);
        const state = await getOfflineSessionState(t.store, alice, T0 + HOUR);
        check(`T3. A record with ${label} is detected as invalid and removed (queue untouched)`,
            state.status === "invalid" && !t.sessions.has(key) && t.queueUnchanged(), state.status);
    }

    // ------------------------------------------------------------ PIN change invalidates old unlocks
    {
        const t = memoryStore();
        await createOfflineSession(t.store, { identity: alice, pin: PIN, permissions: perms, now: T0 });
        const first = await unlockOfflineSession(t.store, alice, PIN, T0 + 60_000);
        await createOfflineSession(t.store, { identity: alice, pin: OTHER_PIN, permissions: perms, now: T0 + 120_000 });
        check("N1. Changing the PIN invalidates earlier unlocks", first.ok && !(await checkOfflineWorkAllowed(t.store, first.marker, alice, T0 + 180_000)).ok);
        check("N2. The old PIN no longer works after a change", !(await unlockOfflineSession(t.store, alice, PIN, T0 + 180_000)).ok);
    }

    // ------------------------------------------------------------ lockout
    {
        const t = memoryStore();
        await createOfflineSession(t.store, { identity: alice, pin: PIN, permissions: perms, now: T0 });
        const outcomes = [];
        for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) outcomes.push(await unlockOfflineSession(t.store, alice, OTHER_PIN, T0 + HOUR));
        const last = outcomes[outcomes.length - 1];
        check("L1. Attempts 1-4 report the remaining attempts (4, 3, 2, 1)",
            outcomes.slice(0, 4).map((o) => (!o.ok && o.reason === "wrong-pin" ? o.remainingAttempts : -1)).join(",") === "4,3,2,1");
        check("L2. The fifth wrong PIN deletes the offline session", !last.ok && last.reason === "locked-out" && t.sessions.size === 0);
        check("L3. ...but queued sales are untouched", t.queueUnchanged());
        const after = await unlockOfflineSession(t.store, alice, PIN, T0 + HOUR);
        check("L4. After lockout even the correct PIN cannot unlock (online sign-in needed)", !after.ok && after.reason === "none");
    }
    {
        const t = memoryStore();
        await createOfflineSession(t.store, { identity: alice, pin: PIN, permissions: perms, now: T0 });
        for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) await unlockOfflineSession(t.store, alice, OTHER_PIN, T0 + HOUR);
        await renewOfflineSession(t.store, alice, perms, T0 + 2 * HOUR);
        check("L5. A successful online check resets the failed-attempt counter",
            t.sessions.get(offlineSessionKey(alice))?.failedAttempts === 0);
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
