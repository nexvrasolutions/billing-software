
/*
 * Session lifetime tests (NO DATABASE, NO BROWSER, NO NETWORK, NO SERVER).
 *
 * Pins the 24-hour absolute session lifetime and how it reaches the cookie,
 * the signed token and the database expiry, without creating any session.
 * The Session model is only introspected (schema paths and index
 * definitions); nothing connects to MongoDB.
 *
 * SESSION_SECRET is required by app/api/auth/session.ts when it is loaded.
 * If it is not set, a throwaway value is used for this process only (the
 * real .env.local is never read by this test).
 *
 * Run (from the project root):
 *   npx tsx scripts/test-session-policy.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { decodeJwt } from "jose";

import { OFFLINE_SESSION_TTL_MS } from "../lib/offline/offlineSession";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const env = process.env as Record<string, string | undefined>;
if (!env.SESSION_SECRET) env.SESSION_SECRET = "throwaway-secret-for-test-session-policy-only";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

async function main() {
    const { SESSION_TTL_SECONDS } = await import("../lib/auth/sessionStore");
    const { createSessionToken, verifySessionToken } = await import("../app/api/auth/session");
    const { Session } = await import("../lib/models/Session");

    // ------------------------------------------------------------ the lifetime
    check("T1. The session lifetime is exactly 24 hours (86400 seconds)", SESSION_TTL_SECONDS === 24 * 60 * 60 && SESSION_TTL_SECONDS === 86_400);
    check("T2. It is no longer the old 7 days", SESSION_TTL_SECONDS !== 7 * 24 * 60 * 60);

    // ------------------------------------------------------------ it reaches the signed token
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_TTL_SECONDS * 1000);
    const token = await createSessionToken(
        { sid: "test-sid", userId: "a".repeat(24), tenantId: "b".repeat(24), deviceId: "c".repeat(24) },
        expiresAt
    );
    const claims = decodeJwt(token);
    check("T3. A token created for a new session expires 24 hours after it was issued",
        typeof claims.exp === "number" && typeof claims.iat === "number" && claims.exp - claims.iat >= 86_399 && claims.exp - claims.iat <= 86_401,
        JSON.stringify({ iat: claims.iat, exp: claims.exp }));
    const verified = await verifySessionToken(token);
    check("T4. Token verification is unchanged: a fresh token verifies and returns the same identity",
        verified?.sid === "test-sid" && verified?.userId === "a".repeat(24) && verified?.tenantId === "b".repeat(24) && verified?.deviceId === "c".repeat(24));
    const expired = await createSessionToken(
        { sid: "test-sid", userId: "a".repeat(24), tenantId: "b".repeat(24), deviceId: "c".repeat(24) },
        new Date(now - 60_000)
    );
    check("T5. An expired token is rejected", (await verifySessionToken(expired)) === null);
    check("T6. A tampered token is rejected", (await verifySessionToken(`${token.slice(0, -4)}AAAA`)) === null);

    // ------------------------------------------------------------ it reaches cookie and database expiry (source shape)
    const store = read("lib/auth/sessionStore.ts");
    check("S1. createUserSession derives the database expiresAt from SESSION_TTL_SECONDS",
        /const expiresAt = new Date\(Date\.now\(\) \+ SESSION_TTL_SECONDS \* 1000\);/.test(store));
    check("S2. ...and passes that same expiresAt to both the Session record and the signed token",
        /Session\.create\(\{[\s\S]*?\bexpiresAt,[\s\S]*?\}\);/.test(store) && /createSessionToken\([\s\S]*?\bexpiresAt\s*\)/.test(store));
    check("S3. The constant is one fixed value: no idle timeout, no sliding expiry, no per-request session writes",
        /export const SESSION_TTL_SECONDS = 24 \* 60 \* 60;/.test(store) && !/updatedAt|lastActive|lastUsed|touch/i.test(
            store.replace(/\/\*\*[\s\S]*?\*\//g, "")));
    check("S4. isSessionActive still requires an unexpired, unrevoked session of the same user, tenant and device",
        /revokedAt: \{ \$exists: false \}/.test(store) && /expiresAt: \{ \$gt: new Date\(\) \}/.test(store)
        && /deviceId: new Types\.ObjectId\(payload\.deviceId\)/.test(store));

    const login = read("app/api/auth/login/route.ts");
    const change = read("app/api/auth/change-password/route.ts");
    check("C1. The login cookie Max-Age is SESSION_TTL_SECONDS", /maxAge: SESSION_TTL_SECONDS/.test(login));
    check("C2. The change-password cookie lifetime is SESSION_TTL_SECONDS", /sessionCookieOptions\(SESSION_TTL_SECONDS\)/.test(change));
    check("C3. No other file defines its own session or cookie lifetime in days",
        !/60 \* 60 \* 24 \* 7|7 \* 24 \* 60 \* 60/.test(login) && !/60 \* 60 \* 24 \* 7|7 \* 24 \* 60 \* 60/.test(change)
        && !/60 \* 60 \* 24 \* 7|7 \* 24 \* 60 \* 60/.test(store));

    // ------------------------------------------------------------ the DB-backed test expectation was updated (not run here)
    const authTest = read("scripts/test-auth-security.ts");
    check("E1. test-auth-security.ts S1 now expects the 24-hour Max-Age",
        authTest.includes("24-hour Max-Age") && authTest.includes("max-age=${24 * 60 * 60}") && !authTest.includes("7-day Max-Age"));

    // ------------------------------------------------------------ existing records, schema and indexes are unchanged
    const paths = Object.keys(Session.schema.paths).filter((p) => !p.startsWith("_")).sort();
    check("D1. The Session schema has exactly its existing fields (no schema change)",
        JSON.stringify(paths) === JSON.stringify(["createdAt", "deviceId", "expiresAt", "revokedAt", "revokedReason", "tenantId", "tokenHash", "updatedAt", "userId"]),
        paths.join(","));
    // Only the options that matter are compared (Mongoose may add defaults such as background).
    const indexes = Session.schema.indexes().map(([fields, options]) => {
        const o = (options ?? {}) as { unique?: boolean; expireAfterSeconds?: number };
        return JSON.stringify([fields, { ...(o.unique ? { unique: true } : {}), ...(o.expireAfterSeconds !== undefined ? { expireAfterSeconds: o.expireAfterSeconds } : {}) }]);
    });
    check("D2. The Session indexes are exactly the existing three, including the TTL index on expiresAt",
        indexes.length === 3
        && indexes.includes(JSON.stringify([{ tokenHash: 1 }, { unique: true }]))
        && indexes.includes(JSON.stringify([{ tenantId: 1, userId: 1, revokedAt: 1 }, {}]))
        && indexes.includes(JSON.stringify([{ expiresAt: 1 }, { expireAfterSeconds: 0 }])),
        indexes.join(" | "));
    check("D3. Existing 7-day session records are not read, migrated or shortened by this change",
        !/updateMany|bulkWrite|migrat/i.test(store.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/revokeAllUserSessions[\s\S]*$/, "")));

    // ------------------------------------------------------------ offline authorization is separate
    check("O1. The offline authorization is still 72 hours (unchanged)", OFFLINE_SESSION_TTL_MS === 72 * 60 * 60 * 1000);
    check("O2. The server login (24 h) is shorter than the offline window (72 h): after a long offline period the owner must sign in again before syncing",
        SESSION_TTL_SECONDS * 1000 < OFFLINE_SESSION_TTL_MS);
    const offlineFiles = ["lib/offline/offlineSession.ts", "lib/offline/sessionIdentity.ts", "lib/offline/SyncManager.ts"].map(read).join("\n");
    check("O3. Nothing in the offline code reads the server session lifetime", !/SESSION_TTL_SECONDS|sessionStore/.test(offlineFiles));

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    process.exitCode = failed.length ? 1 : 0;
}

main().catch((error: unknown) => {
    console.error("Session policy tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
