
/*
 * Renewal-decision tests (NO DATABASE, NO BROWSER, NO NETWORK).
 *
 * 1. lib/offline/sessionConfirmation.ts: what a successful /api/auth/me
 *    answer means for the offline session, and that only an explicit
 *    renew: true can renew it.
 * 2. A scan of the project's source files that pins WHERE renewal may be
 *    requested: only login, the dashboard and the account page. Sync,
 *    queueing, queue inspection and the users page never ask for it.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-session-confirmation.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
    identityFromMe,
    planSessionConfirmation,
    serverTimeFromMe,
} from "../lib/offline/sessionConfirmation";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const id = (n: number) => n.toString(16).padStart(24, "0");
const SERVER = "2026-10-12T09:00:00.000Z";

function me(overrides: { mustChangePassword?: boolean; serverTime?: unknown; permissions?: unknown; withIdentity?: boolean } = {}) {
    return {
        success: true,
        authenticated: true,
        serverTime: "serverTime" in overrides ? overrides.serverTime : SERVER,
        permissions: "permissions" in overrides ? overrides.permissions : ["sales.create", "taxes.read"],
        user: overrides.withIdentity === false
            ? { name: "Alice" }
            : { id: id(2), tenantId: id(1), name: "Alice", mustChangePassword: overrides.mustChangePassword === true },
        device: { id: id(3) },
    };
}

// ------------------------------------------------------------ decisions
const verified = planSessionConfirmation(me(), { renew: true });
check("A1. An explicit renew request on a valid session renews",
    verified.kind === "verified" && verified.renew === true
    && verified.identity.userId === id(2) && verified.identity.tenantId === id(1) && verified.identity.deviceId === id(3));
check("A2. The plan carries the server time, permissions and display name",
    verified.kind === "verified" && verified.serverTime === Date.parse(SERVER)
    && verified.permissions.includes("sales.create") && verified.displayName === "Alice");

const plain = planSessionConfirmation(me(), { renew: false });
check("A3. Without a renew request (sync, queueing, queue inspection, users page) nothing renews",
    plain.kind === "verified" && plain.renew === false);
check("A4. Only an explicit true renews: other values never do",
    [undefined, null, 1, "true", {}, 0].every((value) => {
        const plan = planSessionConfirmation(me(), { renew: value as unknown as boolean });
        return plan.kind === "verified" && plan.renew === false;
    }));

const temporary = planSessionConfirmation(me({ mustChangePassword: true }), { renew: true });
check("A5. A pending temporary password never renews (it removes the offline session instead)", temporary.kind === "temporary-password");
check("A6. ...even without a renew request", planSessionConfirmation(me({ mustChangePassword: true }), { renew: false }).kind === "temporary-password");

check("A7. An answer without an account does not identify anyone",
    planSessionConfirmation(me({ withIdentity: false }), { renew: true }).kind === "no-identity"
    && planSessionConfirmation(null, { renew: true }).kind === "no-identity"
    && planSessionConfirmation("text", { renew: true }).kind === "no-identity"
    && planSessionConfirmation({}, { renew: true }).kind === "no-identity");

check("A8. A non-array permissions field gives an empty list (the server re-checks anyway)",
    (() => {
        const plan = planSessionConfirmation(me({ permissions: "sales.create" }), { renew: true });
        return plan.kind === "verified" && plan.permissions.length === 0;
    })());

check("B1. Server time is read from an ISO string", serverTimeFromMe({ serverTime: SERVER }) === Date.parse(SERVER));
check("B2. Missing, numeric or invalid server time is null (renewal will be refused)",
    [undefined, null, 12345, "not a date", {}, ""].every((value) => serverTimeFromMe({ serverTime: value }) === null)
    && serverTimeFromMe(null) === null && serverTimeFromMe({}) === null);
check("B3. A missing server time still gives a verified plan with serverTime null",
    (() => {
        const plan = planSessionConfirmation(me({ serverTime: undefined }), { renew: true });
        return plan.kind === "verified" && plan.serverTime === null;
    })());

check("C1. identityFromMe needs tenant, user and device",
    identityFromMe(me())?.deviceId === id(3)
    && identityFromMe({ user: { id: id(2), tenantId: id(1) } }) === null
    && identityFromMe({ device: { id: id(3) } }) === null);

// ------------------------------------------------------------ where renewal may be requested
const root = process.cwd();

function walk(dir: string, found: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", "public", "scripts"].includes(name)) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, found);
        else if (/\.(ts|tsx)$/.test(name)) found.push(full);
    }
    return found;
}

const files = ["app", "lib", "components"].flatMap((dir) => {
    try { return walk(path.join(root, dir)); } catch { return []; }
});
const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
const withText = files.map((file) => ({ file: relative(file), text: readFileSync(file, "utf8") }));

check("D0. The source scan found the project files (run from the project root)",
    withText.some((f) => f.file === "lib/offline/sessionIdentity.ts"), `cwd=${root}, files=${files.length}`);

const renewCallers = withText.filter((f) => /\{\s*renew:\s*true\s*\}/.test(f.text)).map((f) => f.file).sort();
check("D1. Renewal is requested ONLY by login, the dashboard and the account page",
    JSON.stringify(renewCallers) === JSON.stringify(["app/account/page.tsx", "app/dashboard/page.tsx", "app/login/page.tsx"]),
    renewCallers.join(", "));

const activators = withText.filter((f) => /activateOfflineAccess\(/.test(f.text)).map((f) => f.file).sort();
check("D2. activateOfflineAccess is defined in offlineAccess.ts and called only by sessionIdentity.ts",
    JSON.stringify(activators) === JSON.stringify(["lib/offline/offlineAccess.ts", "lib/offline/sessionIdentity.ts"]), activators.join(", "));

const sessionActivators = withText.filter((f) => /activateOfflineSession\(/.test(f.text)).map((f) => f.file).sort();
check("D3. activateOfflineSession (the only code that moves the expiry) is used only by offlineSession.ts and offlineAccess.ts",
    JSON.stringify(sessionActivators) === JSON.stringify(["lib/offline/offlineAccess.ts", "lib/offline/offlineSession.ts"]), sessionActivators.join(", "));

for (const name of ["lib/offline/SyncManager.ts", "lib/offline/SyncQueueService.ts", "app/users/page.tsx", "app/offline-test/page.tsx", "components/offline/SyncNowButton.tsx"]) {
    const found = withText.find((f) => f.file === name);
    check(`D4. ${name} never asks for renewal and never activates the session`,
        Boolean(found) && !/renew:\s*true/.test(found!.text) && !/activateOffline(Access|Session)\(/.test(found!.text));
}

const identityFile = withText.find((f) => f.file === "lib/offline/sessionIdentity.ts")?.text ?? "";
check("D5. confirmServerSession renews only when options.renew === true",
    /planSessionConfirmation\(data, \{ renew: options\.renew === true \}\)/.test(identityFile));
check("D6. fetchSessionIdentity (used by sync and queueing) calls confirmServerSession without a renew option",
    /return confirmServerSession\(await response\.json\(\)\);/.test(identityFile));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
