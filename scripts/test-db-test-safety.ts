
/*
 * Safety of the database-backed test scripts (M-7, M-8)
 * (NO DATABASE, NO SERVER, NO NETWORK, NO BROWSER: source checks only).
 *
 * The two database-backed scripts must refuse to run before ANY database
 * module is loaded or any connection is made, unless the database name is
 * exactly "billing_test". The browser test must start its own app server
 * with the environment that guard checked, so the server and the test cannot
 * use different databases; the server must listen on 127.0.0.1 only; and the
 * test must refuse when another server already listens on its port over
 * IPv4 or IPv6.
 *
 * These are source checks: they do NOT run either script and do not prove
 * the runtime behavior (that needs an approved run against billing_test).
 *
 * Run (from the project root):
 *   npx tsx scripts/test-db-test-safety.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

// Imports nothing itself and connects to nothing (checked in H2 below).
import { assertTestDatabaseUri } from "./lib/testDatabaseGuard";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const at = (text: string, needle: string) => text.indexOf(needle);

// ------------------------------------------------------------ shared guard rule
const GUARD_BODY = /function assertDedicatedTestDatabase\(uri: string \| undefined\): void \{[\s\S]*?if \(!uri\) return refuse\(\);[\s\S]*?\/\^mongodb\(\?:\\\+srv\)\?:\\\/\\\/\(\[\^\/\?#\]\+\)\\\/\(\[\^\/\?#\]\*\)\/i[\s\S]*?decodeURIComponent\(match\[2\]\)[\s\S]*?if \(name !== TEST_DATABASE_NAME\) return refuse\(\);\s*\}/;
const REFUSAL = "`Refusing to run: MONGODB_URI must name the dedicated test database ${TEST_DATABASE_NAME}. ` +\n            \"Nothing was connected to or written.\"";

for (const file of ["scripts/test-offline-sync.ts", "scripts/test-offline-sync-browser.ts"]) {
    const text = read(file);
    const guardCall = at(text, "assertDedicatedTestDatabase(process.env.MONGODB_URI);");
    const firstDbImport = Math.min(
        ...["await import(\"mongoose\")", "await import(\"../lib/db/mongodb\")", "connectDB()"]
            .map((needle) => at(text, needle))
            .filter((index) => index >= 0)
    );
    check(`G1. ${file}: has the fail-closed guard (missing, malformed or undecodable URIs and every name other than billing_test are refused)`,
        GUARD_BODY.test(text));
    check(`G1b. ${file}: the only accepted database name is exactly "billing_test", defined once`,
        (text.match(/const TEST_DATABASE_NAME = "billing_test";/g) ?? []).length === 1
        && (text.match(/const TEST_DATABASE_NAME\b/g) ?? []).length === 1);
    check(`G1c. ${file}: the old "any name ending in _test" rule is gone`,
        !/_test\$\/i/.test(text) && !/name\.length <= "_test"\.length/.test(text));
    check(`G2. ${file}: the refusal message names only the expected database, never the URI, user, password or the name found in it`,
        text.includes(REFUSAL) && !/refuse[^\n]*\$\{(uri|name|match)/.test(text)
        && !/Refusing to run: MONGODB_URI[^\n]*\$\{(?!TEST_DATABASE_NAME\})/.test(text));
    check(`G3. ${file}: the guard runs in main() before any database module is loaded or connected`,
        guardCall > 0 && guardCall < firstDbImport && at(text, "async function main()") < guardCall,
        `guard at ${guardCall}, first database use at ${firstDbImport}`);
    check(`G4. ${file}: the existing production refusal and allow flag are still checked first`,
        at(text, "Refusing to run in production.") > 0 && at(text, "Refusing to run in production.") < guardCall
        && /process\.env\.ALLOW_\w+_TESTS !== "YES"/.test(text));
}

// ------------------------------------------------------------ browser test: same database for server and test
const browser = read("scripts/test-offline-sync-browser.ts");
const guardCall = at(browser, "assertDedicatedTestDatabase(process.env.MONGODB_URI);");
const dbImport = at(browser, "await import(\"../lib/db/mongodb\")");

check("B1. The browser test starts its own server with the guard-checked environment",
    /spawn\(process\.execPath, \[nextBin, "start", "-p", String\(port\), "-H", "127\.0\.0\.1"\]/.test(browser)
    && /env: \{ \.\.\.process\.env \}/.test(browser)
    && /path\.join\(process\.cwd\(\), "node_modules", "next", "dist", "bin", "next"\)/.test(browser));
check("B1b. The test server listens on 127.0.0.1 only (\"-H 127.0.0.1\"; no other host or 0.0.0.0)",
    (browser.match(/"-H", "127\.0\.0\.1"/g) ?? []).length === 1 && !/"-H", "(?!127\.0\.0\.1")/.test(browser)
    && !/0\.0\.0\.0|"::"/.test(browser));
check("B1c. The browser's traffic is forwarded to 127.0.0.1, where the server listens",
    /\{ hostname: "127\.0\.0\.1", port: target\.port,/.test(browser) && !/hostname: target\.hostname/.test(browser));
check("B2. It refuses when anything already listens on the port (a foreign server could use another database)",
    /if \(await portInUse\(port\)\) \{\s*throw new Error\(/.test(browser));
check("B2b. The port check covers IPv4 127.0.0.1 AND IPv6 ::1 (\"localhost\" can mean either)",
    /acceptsConnections\("127\.0\.0\.1", port\)/.test(browser) && /acceptsConnections\("::1", port\)/.test(browser)
    && /return ipv4 \|\| ipv6;/.test(browser));
check("B3. It refuses a BASE_URL that is not http://localhost or 127.0.0.1",
    /url\.protocol !== "http:" \|\| !\["localhost", "127\.0\.0\.1"\]\.includes\(url\.hostname\)/.test(browser));
check("B4. It refuses without a production build and without SESSION_SECRET",
    /existsSync\(path\.join\(process\.cwd\(\), "\.next", "BUILD_ID"\)\)/.test(browser)
    && /if \(!process\.env\.SESSION_SECRET\) \{\s*throw new Error\(/.test(browser));
const portCheck = at(browser, "await assertTestServerCanStart(serverPort);");
check("B5. All these refusals happen after the _test guard and before any database module is loaded",
    guardCall > 0 && portCheck > guardCall && portCheck < dbImport && at(browser, "localTestServerPort(BASE_URL)") < dbImport);
const launch = at(browser, "const testServer = launchTestServer(serverPort);");
const cleanup = at(browser, "run.onCleanup(\"stop test server\", () => testServer.stop());");
const ready = at(browser, "await testServer.waitUntilReady();");
const connect = at(browser, "await connectDB();");
check("B6. The server's stop is registered for cleanup before waiting for it, and before the test connects",
    launch > 0 && cleanup > launch && ready > cleanup && connect > ready);
check("B7. Stopping ends only this server's own process tree",
    /spawn\("taskkill", \["\/pid", String\(server\.pid\), "\/T", "\/F"\]/.test(browser) && /server\.kill\("SIGTERM"\)/.test(browser));
check("B8. The instructions no longer ask for a separately started server, and warn against npm run dev",
    // The sentence may wrap onto the next comment line (" * ").
    !/npx next start -p 3130/.test(browser) && /Do NOT start a server\s*(\*\s*)?yourself/.test(browser) && /never "npm run dev"/.test(browser));
check("B9. Both scripts' run instructions use NODE_ENV=test (only .env.test.local is loaded, never .env.local)",
    /NODE_ENV=test ALLOW_BROWSER_TESTS=YES npx tsx scripts\/test-offline-sync-browser\.ts/.test(browser)
    && /NODE_ENV=test ALLOW_OFFLINE_SYNC_TESTS=YES npx tsx scripts\/test-offline-sync\.ts/.test(read("scripts/test-offline-sync.ts")));

// ------------------------------------------------------------ the other database-backed test scripts
const shared = read("scripts/lib/testDatabaseGuard.ts");
check("H1. The shared guard accepts only billing_test and refuses missing, malformed or undecodable URIs",
    /export const TEST_DATABASE_NAME = "billing_test";/.test(shared)
    && /export function assertTestDatabaseUri\(uri: string \| undefined\): void \{[\s\S]*?if \(!uri\) return refuse\(\);[\s\S]*?decodeURIComponent\(match\[2\]\)[\s\S]*?if \(name !== TEST_DATABASE_NAME\) return refuse\(\);\s*\}/.test(shared)
    && !/_test\$\/i/.test(shared));
check("H2. The shared guard imports nothing (cannot connect) and its message names no URI or found name",
    !/^\s*import\b|require\(|await import/m.test(shared)
    && shared.includes("`Refusing to run: MONGODB_URI must name the dedicated test database ${TEST_DATABASE_NAME}. ` +")
    && !/refuse[^\n]*\$\{(uri|name|match)/.test(shared));

const GUARDED_SCRIPTS = [
    "scripts/test-auth-security.ts",
    "scripts/test-audit-log-security.ts",
    "scripts/test-browser-e2e.ts",
    "scripts/test-business-permissions.ts",
    "scripts/test-password-management.ts",
    "scripts/test-permission-security.ts",
    "scripts/test-temporary-password.ts",
    "scripts/test-user-management.ts",
];
for (const file of GUARDED_SCRIPTS) {
    const text = read(file);
    const mainStart = at(text, "async function main()");
    const guardInMain = text.indexOf("assertTestDatabaseUri(process.env.MONGODB_URI);", mainStart);
    const firstConnection = Math.min(
        ...["await connectDB()", "runTestSafely({"]
            .map((needle) => text.indexOf(needle, mainStart))
            .filter((index) => index >= 0)
    );
    check(`H3. ${file}: imports the shared guard and calls it in main() before its first connection`,
        /import \{ assertTestDatabaseUri \} from "\.\/lib\/testDatabaseGuard";/.test(text)
        && mainStart >= 0 && guardInMain > mainStart && Number.isFinite(firstConnection) && guardInMain < firstConnection,
        `main at ${mainStart}, guard at ${guardInMain}, first connection at ${firstConnection}`);
}
// The shared guard's real logic, with FAKE addresses (nothing connects).
const accepts = (uri: string | undefined) => {
    try {
        assertTestDatabaseUri(uri);
        return true;
    } catch {
        return false;
    }
};
check("H5. Accepted: exactly billing_test (with or without user, options, +srv)",
    ["mongodb://localhost/billing_test", "mongodb+srv://fake:fake@fake.invalid/billing_test?retryWrites=true", "mongodb://h1,h2/billing_test"]
        .every(accepts));
const refusedUris: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["main database", "mongodb+srv://fake:fake@fake.invalid/billing_inventory"],
    ["another *_test database", "mongodb://localhost/other_test"],
    ["billing_test as a prefix", "mongodb://localhost/billing_test_copy"],
    ["billing_test as a suffix", "mongodb://localhost/x_billing_test"],
    ["different letter case", "mongodb://localhost/BILLING_TEST"],
    ["no database name", "mongodb://localhost/"],
    ["no path at all", "mongodb://localhost"],
    ["not a MongoDB URI", "postgres://localhost/billing_test"],
    ["undecodable name", "mongodb://localhost/billing%ZZtest"],
];
for (const [label, uri] of refusedUris) {
    check(`H6. Refused: ${label}`, !accepts(uri));
}
let refusalText = "";
try {
    assertTestDatabaseUri("mongodb+srv://fakeuser:fakepass@fake.invalid/billing_inventory");
} catch (error) {
    refusalText = error instanceof Error ? error.message : "";
}
check("H7. The refusal text contains no part of the URI (user, password, host, database found)",
    refusalText.length > 0 && !/fakeuser|fakepass|fake\.invalid|billing_inventory|mongodb/.test(refusalText), refusalText);

const authSecurity = read("scripts/test-auth-security.ts");
const childStart = at(authSecurity, "async function childCheck()");
check("H4. test-auth-security's child mode (which skips main) checks the database first too",
    childStart >= 0
    && authSecurity.indexOf("assertTestDatabaseUri(process.env.MONGODB_URI);", childStart) < authSecurity.indexOf("await import(", childStart));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
