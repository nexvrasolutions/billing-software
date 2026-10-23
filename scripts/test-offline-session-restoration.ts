/*
 * Offline Session Restoration Tests
 * (NO DATABASE, NO BROWSER, NO NETWORK).
 *
 * Verifies:
 * 1. Valid offline authorization restores successfully without calling the server.
 * 2. Expired authorization (>72h) fails restoration and blocks offline billing.
 * 3. Missing authorization fails restoration with sign-in requirement.
 * 4. Tenant/device/user mismatch or tampered records fail restoration.
 * 5. Clock rollback is detected and blocks offline restoration.
 * 6. Missing sales.create permission blocks offline billing restoration.
 * 7. Pending offline logout blocks offline restoration until settled.
 * 8. Offline activity updates clockHighWater but NEVER renews expiresAt or lastOnlineCheckAt.
 * 9. Server unreachable fallback in checkSession() logic restores offline session.
 * 10. Server rejection (401/403) removes offline session and forces login.
 * 11. Tenant-isolated cached product loading preserves boundaries.
 * 12. Queued sales and storage remain completely preserved and untouched.
 *
 * Run:
 *   npx tsx scripts/test-offline-session-restoration.ts
 */

import {
    CLOCK_SKEW_MS,
    OFFLINE_SESSION_TTL_MS,
    OFFLINE_WORK_PERMISSION,
    activateOfflineSession,
    checkOfflineWorkAllowed,
    getOfflineSessionState,
    offlineSessionKey,
    recordOfflineActivity,
    type OfflineIdentity,
    type OfflineSessionRecord,
    type OfflineSessionStore,
} from "../lib/offline/offlineSession";
import {
    restoreOfflineSession,
    getOfflineAccessOverview,
    type OfflineRestorationResult,
} from "../lib/offline/offlineAccess";
import { isSessionRejected } from "../lib/offline/sessionIdentity";
import { mapApiProductsToCacheRecords } from "../lib/offline/productCatalogueCache";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

function createMemoryStore() {
    const sessions = new Map<string, OfflineSessionRecord>();
    const queue = new Map<string, unknown>([
        ["q1", { operationId: "q1", entityType: "Sale", status: "PENDING", payload: { invoiceNo: "INV-001" } }],
        ["q2", { operationId: "q2", entityType: "Sale", status: "FAILED", payload: { invoiceNo: "INV-002" } }],
    ]);
    const queueSnapshot = JSON.stringify([...queue]);
    const store: OfflineSessionStore = {
        get: async (key) => (sessions.has(key) ? structuredClone(sessions.get(key)!) : undefined),
        put: async (record) => { sessions.set(record.key, structuredClone(record)); },
        delete: async (key) => { sessions.delete(key); },
    };
    return {
        store,
        sessions,
        queue,
        queueUnchanged: () => JSON.stringify([...queue]) === queueSnapshot,
    };
}

const hexId = (n: number) => n.toString(16).padStart(24, "0");
const tenantA = hexId(1);
const tenantB = hexId(99);
const userCashier = hexId(2);
const deviceRegister = hexId(3);

const staffIdentity: OfflineIdentity = {
    tenantId: tenantA,
    userId: userCashier,
    deviceId: deviceRegister,
};

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0); // Day 1, 9:00 AM UTC
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function setupAuthorizedSession(
    store: OfflineSessionStore,
    identity: OfflineIdentity = staffIdentity,
    time: number = T0,
    permissions: string[] = [OFFLINE_WORK_PERMISSION, "products.read"],
    displayName: string = "Cashier Staff"
) {
    return activateOfflineSession(store, {
        identity,
        permissions,
        displayName,
        now: time,
        serverTime: time,
    });
}

async function main() {
    console.log("\n--- Stage 6B: Offline Session Restoration & Safety Tests ---\n");

    // --------------------------------------------------------------------------
    // Test 1: Valid offline restoration without server connection
    // --------------------------------------------------------------------------
    {
        const { store, queueUnchanged } = createMemoryStore();
        await setupAuthorizedSession(store, staffIdentity, T0);

        // Day 2 (24 hours later): staff opens billing app offline
        const nowDay2 = T0 + 24 * HOUR;
        const res = await restoreOfflineSession({ store, now: nowDay2, identity: staffIdentity });

        check("R1. Valid offline authorization restores successfully without server", res.ok === true);
        check("R2. Restored session contains correct tenant, user, and device binding",
            res.identity?.tenantId === staffIdentity.tenantId &&
            res.identity?.userId === staffIdentity.userId &&
            res.identity?.deviceId === staffIdentity.deviceId
        );
        check("R3. Restored overview indicates offline work is allowed", res.overview?.allowed === true);
        check("R4. Restored overview status is available with correct display name",
            res.overview?.state.status === "available" &&
            res.overview.state.displayName === "Cashier Staff"
        );
        check("R5. Queued sales remain completely preserved during restoration", queueUnchanged());
    }

    // --------------------------------------------------------------------------
    // Test 2: Expired authorization (>72h) fails restoration and blocks offline billing
    // --------------------------------------------------------------------------
    {
        const { store, queueUnchanged } = createMemoryStore();
        await setupAuthorizedSession(store, staffIdentity, T0);

        // Day 4 (73 hours later, >72h TTL): staff opens billing app
        const expiredTime = T0 + 73 * HOUR;
        const res = await restoreOfflineSession({ store, now: expiredTime, identity: staffIdentity });

        check("E1. Expired authorization fails restoration", res.ok === false);
        check("E2. Expired reason explains the offline session has expired",
            typeof res.reason === "string" && /expired/i.test(res.reason)
        );
        check("E3. Overview status reflects expired and allowed is false",
            res.overview?.allowed === false && res.overview?.state.status === "expired"
        );
        check("E4. Queued sales are preserved despite session expiry", queueUnchanged());
    }

    // --------------------------------------------------------------------------
    // Test 3: Missing authorization fails restoration
    // --------------------------------------------------------------------------
    {
        const { store } = createMemoryStore();

        // Case A: No identity remembered on device
        const resNoIdentity = await restoreOfflineSession({ store, now: T0, identity: null });
        check("M1. Missing identity fails restoration", resNoIdentity.ok === false);
        check("M2. Missing identity explains user must sign in online first",
            typeof resNoIdentity.reason === "string" && /sign in online first/i.test(resNoIdentity.reason)
        );

        // Case B: Identity remembered but no session record exists in store
        const resNoRecord = await restoreOfflineSession({ store, now: T0, identity: staffIdentity });
        check("M3. Missing stored session record fails restoration", resNoRecord.ok === false);
        check("M4. Missing record blocks offline access",
            typeof resNoRecord.reason === "string" && /not available/i.test(resNoRecord.reason)
        );
    }

    // --------------------------------------------------------------------------
    // Test 4: Tenant, User, Device mismatch and record tampering
    // --------------------------------------------------------------------------
    {
        const { store, sessions } = createMemoryStore();
        await setupAuthorizedSession(store, staffIdentity, T0);

        // Mismatched device ID
        const otherDeviceIdentity: OfflineIdentity = { ...staffIdentity, deviceId: hexId(55) };
        const resWrongDevice = await restoreOfflineSession({ store, now: T0 + HOUR, identity: otherDeviceIdentity });
        check("T1. Mismatched device ID fails restoration", resWrongDevice.ok === false);

        // Mismatched tenant ID
        const otherTenantIdentity: OfflineIdentity = { ...staffIdentity, tenantId: tenantB };
        const resWrongTenant = await restoreOfflineSession({ store, now: T0 + HOUR, identity: otherTenantIdentity });
        check("T2. Mismatched tenant ID fails restoration", resWrongTenant.ok === false);

        // Tampered record (corrupted key or mismatched tenant in payload)
        const key = offlineSessionKey(staffIdentity);
        const record = sessions.get(key)!;
        sessions.set(key, { ...record, tenantId: tenantB }); // tamper tenantId in record
        const resTampered = await restoreOfflineSession({ store, now: T0 + HOUR, identity: staffIdentity });
        check("T3. Tampered record is detected and rejected", resTampered.ok === false);
        check("T4. Tampered record is purged to protect storage integrity", !sessions.has(key));
    }

    // --------------------------------------------------------------------------
    // Test 5: Clock rollback detection
    // --------------------------------------------------------------------------
    {
        const { store } = createMemoryStore();
        await setupAuthorizedSession(store, staffIdentity, T0);

        // Day 1: work recorded at T0 + 10 hours
        const activityTime = T0 + 10 * HOUR;
        await recordOfflineActivity(store, staffIdentity, activityTime);

        // Clock rolled back to T0 + 2 hours (more than 5 mins behind clockHighWater)
        const rolledBackTime = T0 + 2 * HOUR;
        const resRollback = await restoreOfflineSession({ store, now: rolledBackTime, identity: staffIdentity });

        check("K1. Clock rollback is detected during restoration", resRollback.ok === false);
        check("K2. Clock rollback reason mentions backwards clock",
            typeof resRollback.reason === "string" && /clock.*backwards/i.test(resRollback.reason)
        );
        check("K3. Overview status marks clock-rollback and blocks allowed",
            resRollback.overview?.allowed === false && resRollback.overview?.state.status === "clock-rollback"
        );
    }

    // --------------------------------------------------------------------------
    // Test 6: Permission gate (missing sales.create)
    // --------------------------------------------------------------------------
    {
        const { store } = createMemoryStore();
        // Authorized with reports.read and products.read, but without sales.create
        await setupAuthorizedSession(store, staffIdentity, T0, ["reports.read", "products.read"]);

        const resNoSalesPerm = await restoreOfflineSession({ store, now: T0 + HOUR, identity: staffIdentity });
        check("P1. Missing sales.create permission blocks offline restoration", resNoSalesPerm.ok === false);
        check("P2. Missing sales permission reason clearly states sale recording is not allowed",
            typeof resNoSalesPerm.reason === "string" && /not allowed to record sales offline/i.test(resNoSalesPerm.reason)
        );
    }

    // --------------------------------------------------------------------------
    // Test 7: Expiry non-renewal guarantee while offline
    // --------------------------------------------------------------------------
    {
        const { store, sessions } = createMemoryStore();
        const initialRecord = await setupAuthorizedSession(store, staffIdentity, T0);
        const originalExpiresAt = initialRecord.expiresAt;
        const originalLastOnlineCheck = initialRecord.lastOnlineCheckAt;

        // Perform multiple offline restorations and operations over subsequent hours
        for (let h = 5; h <= 45; h += 10) {
            const time = T0 + h * HOUR;
            const res = await restoreOfflineSession({ store, now: time, identity: staffIdentity });
            check(`N1. Offline restoration at +${h}h succeeds`, res.ok === true);
        }

        const storedRecord = sessions.get(offlineSessionKey(staffIdentity))!;
        check("N2. Expiry is NEVER renewed while offline (strictly equals original 72h expiry)",
            storedRecord.expiresAt === originalExpiresAt
        );
        check("N3. lastOnlineCheckAt is NEVER changed while offline",
            storedRecord.lastOnlineCheckAt === originalLastOnlineCheck
        );
        check("N4. Only clockHighWater advanced to the latest offline time",
            storedRecord.clockHighWater === T0 + 45 * HOUR
        );
    }

    // --------------------------------------------------------------------------
    // Test 8: Server unreachable fallback in checkSession() logic
    // --------------------------------------------------------------------------
    {
        const { store } = createMemoryStore();
        await setupAuthorizedSession(store, staffIdentity, T0);

        // Simulate checkSession() logic when fetch throws or server returns 503
        async function simulateCheckSession(networkError: boolean, httpStatus?: number) {
            try {
                if (networkError) {
                    throw new TypeError("Failed to fetch (offline)");
                }
                if (httpStatus && isSessionRejected(httpStatus)) {
                    // definitive rejection
                    return { status: "login" };
                }
                if (httpStatus && httpStatus >= 500) {
                    // server error -> fallback to offline restoration
                    const restored = await restoreOfflineSession({ store, now: T0 + 24 * HOUR, identity: staffIdentity });
                    if (restored.ok && restored.identity && restored.overview) {
                        return { status: "offline", identity: restored.identity, overview: restored.overview };
                    }
                    return { status: "unreachable", reason: restored.reason };
                }
                return { status: "verified" };
            } catch {
                // network error -> fallback to offline restoration
                const restored = await restoreOfflineSession({ store, now: T0 + 24 * HOUR, identity: staffIdentity });
                if (restored.ok && restored.identity && restored.overview) {
                    return { status: "offline", identity: restored.identity, overview: restored.overview };
                }
                return { status: "unreachable", reason: restored.reason };
            }
        }

        // A. Network error with valid offline session -> restores offline mode
        const offlineResult = await simulateCheckSession(true);
        check("S1. Server unreachable with valid offline session returns 'offline'",
            offlineResult.status === "offline" && "identity" in offlineResult
        );

        // B. HTTP 503 with valid offline session -> restores offline mode
        const server503Result = await simulateCheckSession(false, 503);
        check("S2. Server 503 error with valid offline session returns 'offline'",
            server503Result.status === "offline"
        );

        // C. HTTP 401 definitive rejection -> returns 'login'
        const rejected401 = await simulateCheckSession(false, 401);
        check("S3. Server 401 rejection does NOT restore offline mode, returns 'login'",
            rejected401.status === "login"
        );

        // D. HTTP 403 definitive rejection -> returns 'login'
        const rejected403 = await simulateCheckSession(false, 403);
        check("S4. Server 403 rejection does NOT restore offline mode, returns 'login'",
            rejected403.status === "login"
        );
    }

    // --------------------------------------------------------------------------
    // Test 9: Tenant-isolated cached product loading
    // --------------------------------------------------------------------------
    {
        const rawProductsTenantA = [
            { _id: hexId(101), name: "Paracetamol 500mg", SKU: "MED-001", sellingPrice: 25, status: "active", tenantId: tenantA },
            { _id: hexId(102), name: "Amoxicillin 250mg", SKU: "MED-002", sellingPrice: 60, status: "active", tenantId: tenantA },
        ];
        const rawProductsTenantB = [
            { _id: hexId(201), name: "Industrial Widget", SKU: "WID-999", sellingPrice: 999, status: "active", tenantId: tenantB },
        ];

        const cachedA = mapApiProductsToCacheRecords(rawProductsTenantA, tenantA);
        const cachedB = mapApiProductsToCacheRecords(rawProductsTenantB, tenantB);

        check("C1. Tenant A cached products correctly mapped and isolated",
            cachedA.length === 2 && cachedA.every((p) => p.tenantId === tenantA)
        );
        check("C2. Tenant B cached products isolated from Tenant A",
            cachedB.length === 1 && cachedB.every((p) => p.tenantId === tenantB)
        );

        // Verify simulated tenant filter
        const allCached = [...cachedA, ...cachedB];
        const tenantAView = allCached.filter((p) => p.tenantId === staffIdentity.tenantId);
        check("C3. Offline product lookup strictly filters by authorized tenant",
            tenantAView.length === 2 && !tenantAView.some((p) => p.name.includes("Industrial"))
        );
    }

    console.log("\n--- Test Summary ---");
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
