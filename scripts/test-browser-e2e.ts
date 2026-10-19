
/*
 * Browser end-to-end test for login, User Management and My account.
 *
 * Drives a real headless Chrome/Edge through the Chrome DevTools Protocol
 * (no extra dependencies) against a locally running app, using a brand-new
 * temporary business that is deleted afterwards. Passwords and tokens are
 * never printed.
 *
 * 1. npm run build && npx next start -p 3130
 * 2. ALLOW_BROWSER_TESTS=YES BASE_URL=http://localhost:3130 npx tsx scripts/test-browser-e2e.ts
 *    (optional BROWSER_PATH=<path to chrome.exe or msedge.exe>)
 */

import { loadEnvConfig } from "@next/env";
import { assertTestDatabaseUri } from "./lib/testDatabaseGuard";
import { runTestSafely } from "./lib/testRunSafety";
import { Page, findBrowser, sleep } from "./lib/cdpBrowser";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}


// JS expressions locating elements on the pages under test.
const formWithHeading = (heading: string) =>
    `[...document.querySelectorAll("form")].find((f) => f.querySelector("h2")?.innerText.trim().startsWith(${JSON.stringify(heading)}))`;
const rowFor = (email: string) =>
    `[...document.querySelectorAll("tbody tr")].find((r) => r.innerText.includes(${JSON.stringify(email)}))`;

function summarize(): boolean {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
    return failed.length === 0;
}

async function main() {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production.");
    if (process.env.ALLOW_BROWSER_TESTS !== "YES") {
        throw new Error("Set ALLOW_BROWSER_TESTS=YES after confirming MONGODB_URI is a development database.");
    }
    // Only the dedicated test database, checked before anything connects.
    assertTestDatabaseUri(process.env.MONGODB_URI);

    const mongoose = (await import("mongoose")).default;
    const { connectDB } = await import("../lib/db/mongodb");
    const { Tenant } = await import("../lib/models/Tenant");
    const { User } = await import("../lib/models/User");
    const { Role } = await import("../lib/models/Role");
    const { Permission } = await import("../lib/models/Permission");
    const { Device } = await import("../lib/models/Device");
    const { AuditLog } = await import("../lib/models/AuditLog");
    const { Session } = await import("../lib/models/Session");
    const { hashPassword } = await import("../app/api/auth/password");
    const { getLoginBuckets } = await import("../lib/auth/loginRateLimit");

    await runTestSafely({
        name: "Browser end-to-end tests",
        tenantNamePrefix: "BROWSER-TEST-",
        overallTimeoutMs: 300_000,
        summarize,
        run: async (run) => {
            await connectDB();

            const suffix = run.runId;
            const ownerPassword = `Browser-Owner-${suffix}-1!`;
            const ownerNewPassword = `Browser-Owner-${suffix}-2!`;
            const managerPassword = `Browser-Manager-${suffix}-1!`;
            const newUserPassword = `Browser-New-${suffix}-1!`;
            const resetPassword = `Browser-Reset-${suffix}-1!`;
            // The app server has no trusted IP header locally, so login counters are
            // keyed by email only. Register them before the browser can create them.
            const registerEmail = (email: string) =>
                run.addRateLimitKeys(getLoginBuckets({ ip: null, email }).map((bucket) => bucket.key));

            const userDataDir = mkdtempSync(path.join(os.tmpdir(), "browser-e2e-"));
            const port = 9300 + Math.floor(Math.random() * 500);
            const browser = spawn(findBrowser(), [
                "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
                "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
            ], { stdio: "ignore" });

            let page: Page | null = null;
            // Runs first during cleanup, so the browser stops sending requests that
            // could still write to the database (the app server does the writes).
            run.onCleanup("close browser", async () => {
                page?.close();
                browser.kill();
                await sleep(500);
                rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            });

            {
                // ------------------------------------------------------- test data
                const perms = await Permission.find({ name: { $in: ["users.read", "users.create", "users.update", "users.delete", "products.read"] } }).select("_id").lean();
                const tid = run.newTenantId(); // registered before insert
                await Tenant.create({ _id: tid, name: run.tenantName("A"), status: "active" });
                const adminRole = await Role.create({ tenantId: tid, name: "Admin", permissions: perms.map((p) => p._id) });
                const productsRead = await Permission.findOne({ name: "products.read" }).select("_id").lean();
                if (!productsRead) throw new Error("products.read permission missing");
                const cashierRole = await Role.create({ tenantId: tid, name: "Cashier", permissions: [productsRead._id] });

                async function makeUser(label: string, password: string, roleId = adminRole._id) {
                    const email = `${label}-${suffix}@example.invalid`;
                    registerEmail(email);
                    const user = await User.create({ tenantId: tid, name: `Browser ${label}`, email, passwordHash: await hashPassword(password), roleId, status: "active" });
                    const deviceId = `browser-${label}-${suffix}`;
                    await Device.create({ tenantId: tid, userId: user._id, deviceName: `${label} browser`, deviceType: "desktop", deviceId, status: "active" });
                    return { id: user._id.toString(), email, deviceId };
                }

                const owner = await makeUser("owner", ownerPassword);
                const manager = await makeUser("manager", managerPassword);
                // Cashier role: no users.* permission (products.read only).
                const viewerPassword = `Browser-Viewer-${suffix}-1!`;
                const viewer = await makeUser("viewer", viewerPassword, cashierRole._id);
                await Tenant.updateOne({ _id: tid }, { $set: { ownerUserId: new mongoose.Types.ObjectId(owner.id) } });
                const newUserEmail = `new-${suffix}@example.invalid`;
                registerEmail(newUserEmail);

                page = await Page.connect(port);

                async function login(email: string, password: string, deviceId: string) {
                    await page!.goto("/login");
                    await page!.fill(`document.querySelector('input[type=email]')`, email);
                    await page!.fill(`document.querySelector('input[type=password]')`, password);
                    await page!.fill(`document.querySelector('input[type=text]')`, deviceId);
                    await page!.clickButton("Sign in");
                }

                // The current login page redirects to /dashboard on success.
                const landedOnDashboard = async () =>
                    (await page!.waitFor(`location.pathname === "/dashboard"`)) && (await page!.waitForText("Dashboard"));

                // ----------------------------------------------------------- login
                await login(owner.email, "Definitely-Wrong-Pass-1", owner.deviceId);
                check(
                    "B1. Invalid login shows a clear error and stays on the login page",
                    (await page.waitForText("Invalid email or password")) && (await page.eval<string>("location.pathname")) === "/login"
                );

                await login(owner.email, ownerPassword, owner.deviceId);
                check("B2. Valid login succeeds and redirects to the dashboard", await landedOnDashboard());

                // Dashboard navigation (links only; pages enforce their own access).
                const clickLink = (text: string) => page!.eval<boolean>(`(() => {
                    const link = [...document.querySelectorAll("a")].find((a) => a.innerText.trim() === ${JSON.stringify(text)});
                    if (!link) return false;
                    link.click();
                    return true;
                })()`);
                check(
                    "B2. Dashboard links to User Management (/users) and My account (/account)",
                    await page.waitFor(`(() => {
                        const href = (t) => [...document.querySelectorAll("a")].find((a) => a.innerText.trim() === t)?.getAttribute("href");
                        return href("User Management") === "/users" && href("My account") === "/account";
                    })()`)
                );
                check(
                    "B2. The User Management link opens the user list",
                    (await clickLink("User Management")) && (await page.waitFor(`location.pathname === "/users"`)) && (await page.waitFor(rowFor(owner.email)))
                );

                // ------------------------------------------------------ users page
                await page.goto("/users");
                const listed = await page.waitFor(`${rowFor(owner.email)}`);
                const ownerRowText = listed ? await page.eval<string>(`${rowFor(owner.email)}.innerText`) : "";
                check("B3. Users list loads with the owner marked (Owner)(You)", listed && ownerRowText.includes("(Owner)") && ownerRowText.includes("(You)"), ownerRowText);
                check(
                    "B3. Owner and self rows have no Deactivate button",
                    listed && !(await page.eval<boolean>(`[...${rowFor(owner.email)}.querySelectorAll("button")].some((b) => b.innerText.includes("Deactivate"))`))
                );

                await page.clickButton("Add user");
                await page.waitFor(formWithHeading("Add user"));
                const addForm = formWithHeading("Add user");
                await page.fill(`${addForm}.querySelectorAll("input")[0]`, "Browser Cashier");
                await page.fill(`${addForm}.querySelectorAll("input")[1]`, newUserEmail);
                await page.fill(`${addForm}.querySelectorAll("input")[2]`, "short");
                const cashierOption = await page.eval<string>(`[...${addForm}.querySelectorAll("option")].find((o) => o.innerText.startsWith("Cashier"))?.value ?? ""`);
                await page.fill(`${addForm}.querySelector("select")`, cashierOption);
                await page.clickButton("Create user", addForm);
                check("B4. Invalid new user shows a field error (password length)", await page.waitForText("Password must be at least 12 characters"));
                await page.fill(`${addForm}.querySelectorAll("input")[2]`, newUserPassword);
                await page.clickButton("Create user", addForm);
                check("B4. Creating a valid user succeeds and it appears in the list", await page.waitForText("Browser Cashier was created.") && await page.waitFor(rowFor(newUserEmail)));

                await page.fill(`document.querySelector('input[type=search]')`, `new-${suffix}`);
                await page.clickButton("Search");
                const searched = await page.waitFor(`document.querySelectorAll("tbody tr").length === 1 && ${rowFor(newUserEmail)}`);
                check("B5. Search filters the list to the matching user", searched);

                await page.clickButton("Edit", rowFor(newUserEmail));
                await page.waitFor(formWithHeading("Edit Browser Cashier"));
                await page.fill(`${formWithHeading("Edit Browser Cashier")}.querySelectorAll("input")[0]`, "Browser Cashier Renamed");
                await page.clickButton("Save changes", formWithHeading("Edit Browser Cashier"));
                check("B6. Editing a user's name succeeds and the list updates", await page.waitForText("Browser Cashier Renamed was updated.") && await page.waitFor(`${rowFor(newUserEmail)}.innerText.includes("Browser Cashier Renamed")`));

                await page.clickButton("Edit", rowFor(newUserEmail));
                await page.waitFor(formWithHeading("Reset password for"));
                const resetForm = formWithHeading("Reset password for");
                await page.fill(`${resetForm}.querySelector("input")`, resetPassword);
                await page.clickButton("Reset password", resetForm);
                check("B7. Admin password reset from the edit form succeeds", await page.waitForText("Password reset. The user has been signed out everywhere"));
                await page.clickButton("Cancel", formWithHeading("Edit Browser Cashier Renamed"));

                await page.clickButton("Deactivate", rowFor(newUserEmail));
                check(
                    "B8. Deactivating a user succeeds and the status shows Inactive",
                    await page.waitForText("was deactivated.") && await page.waitFor(`${rowFor(newUserEmail)}.innerText.includes("Inactive")`)
                );
                check("B8. Database confirms the user is inactive", (await User.findOne({ tenantId: tid, email: newUserEmail }).lean())?.status === "inactive");

                // ----------------------------------------------------- my account
                await page.goto("/account");
                check("B9. My account shows the signed-in user", await page.waitForText("Signed in as") && (await page.text()).includes(owner.email));
                const pwForm = formWithHeading("Change password");
                await page.fill(`${pwForm}.querySelectorAll("input")[0]`, "Wrong-Current-Pass-1");
                await page.fill(`${pwForm}.querySelectorAll("input")[1]`, ownerNewPassword);
                await page.fill(`${pwForm}.querySelectorAll("input")[2]`, ownerNewPassword);
                await page.clickButton("Change password", pwForm);
                check("B10. Wrong current password shows an error", await page.waitForText("Current password is incorrect"));
                await page.fill(`${pwForm}.querySelectorAll("input")[0]`, ownerPassword);
                await page.fill(`${pwForm}.querySelectorAll("input")[2]`, "Something-Else-1234");
                await page.clickButton("Change password", pwForm);
                check("B10. Mismatched confirmation is caught", await page.waitForText("The new passwords do not match."));
                await page.fill(`${pwForm}.querySelectorAll("input")[2]`, ownerNewPassword);
                await page.clickButton("Change password", pwForm);
                check("B10. Changing the password succeeds", await page.waitForText("Password changed. You have been signed out on all other devices."));
                await page.goto("/account");
                check("B10. Still signed in on this device after the change (new session)", await page.waitForText("Signed in as"));

                await page.clickButton("Log out");
                check("B11. Log out signs the user out", await page.waitForText("You are signed out."));
                await page.goto("/users");
                check("B11. After logout, User Management asks to log in", await page.waitForText("not logged in"));
                await page.goto("/account");
                check("B11. After logout, My account shows the signed-out state", await page.waitForText("You are signed out."));
                await page.goto("/dashboard");
                check(
                    "B11. Signed out: /dashboard redirects to /login and never shows the dashboard",
                    (await page.waitFor(`location.pathname === "/login"`)) && !(await page.text()).includes("Welcome to your billing and inventory system.")
                );

                await login(owner.email, ownerPassword, owner.deviceId);
                check("B12. Old password no longer works after the change", await page.waitForText("Invalid email or password"));
                await login(owner.email, ownerNewPassword, owner.deviceId);
                check("B12. New password works", await landedOnDashboard());

                // ---------------------------------------- ordinary admin restrictions
                await login(manager.email, managerPassword, manager.deviceId);
                await landedOnDashboard();
                await page.goto("/users");
                await page.waitFor(rowFor(owner.email));
                check(
                    "B13. Non-owner admin cannot edit the owner (no Edit button)",
                    !(await page.eval<boolean>(`[...${rowFor(owner.email)}.querySelectorAll("button")].some((b) => b.innerText === "Edit")`))
                );
                await page.clickButton("Add user");
                await page.waitFor(formWithHeading("Add user"));
                const roleOptions = await page.eval<string[]>(`[...${formWithHeading("Add user")}.querySelectorAll("option")].map((o) => o.innerText)`);
                check(
                    "B13. Non-owner admin is not offered administrator roles",
                    !roleOptions.some((o) => o.startsWith("Admin")) && roleOptions.some((o) => o.startsWith("Cashier")) &&
                    (await page.text()).includes("Only the business owner can assign administrator roles."),
                    roleOptions.join(" | ")
                );

                await page.goto("/account");
                await page.waitForText("Signed in as");
                await page.clickButton("Log out of all devices");
                check("B14. Log out of all devices signs the user out", await page.waitForText("You are signed out."));
                check(
                    "B14. Database confirms all of that user's sessions are revoked",
                    (await Session.countDocuments({ tenantId: tid, userId: new mongoose.Types.ObjectId(manager.id), revokedAt: { $exists: false } })) === 0
                );

                // ----------------------------------- temporary-password restriction
                const managerTempPassword = `Browser-Temp-${suffix}-1!`;
                const managerChosenPassword = `Browser-Chosen-${suffix}-1!`;
                await login(owner.email, ownerNewPassword, owner.deviceId);
                await landedOnDashboard();
                await page.goto("/users");
                await page.waitFor(rowFor(manager.email));
                await page.clickButton("Edit", rowFor(manager.email));
                await page.waitFor(formWithHeading("Reset password for Browser manager"));
                const managerResetForm = formWithHeading("Reset password for Browser manager");
                await page.fill(`${managerResetForm}.querySelector("input")`, managerTempPassword);
                await page.clickButton("Reset password", managerResetForm);
                check("B16. Owner resets an administrator's password from the UI", await page.waitForText("Password reset. The user has been signed out everywhere"));

                await login(manager.email, managerTempPassword, manager.deviceId);
                check(
                    "B17. Login with a temporary password redirects to My account with a warning",
                    await page.waitFor(`location.pathname === "/account"`) && await page.waitForText("An administrator reset your password.")
                );
                await page.goto("/users");
                check("B18. User Management is blocked and explains why", await page.waitForText("You must change your temporary password before using this page."));
                await page.goto("/dashboard");
                check(
                    "B18. With a temporary password, /dashboard redirects to My account",
                    (await page.waitFor(`location.pathname === "/account"`)) && (await page.waitForText("An administrator reset your password."))
                );

                await page.goto("/account");
                await page.waitForText("Signed in as");
                const tempForm = formWithHeading("Change password");
                await page.fill(`${tempForm}.querySelectorAll("input")[0]`, managerTempPassword);
                await page.fill(`${tempForm}.querySelectorAll("input")[1]`, managerChosenPassword);
                await page.fill(`${tempForm}.querySelectorAll("input")[2]`, managerChosenPassword);
                await page.clickButton("Change password", tempForm);
                check(
                    "B19. Changing the temporary password succeeds and removes the warning",
                    await page.waitForText("Password changed.") && !(await page.text()).includes("An administrator reset your password.")
                );
                await page.goto("/users");
                check("B19. User Management works again after the change", await page.waitFor(rowFor(owner.email)));
                check("B19. Database confirms the restriction is lifted", (await User.findById(manager.id).lean())?.mustChangePassword === false);

                // ------------------- dashboard links never grant extra access
                await login(viewer.email, viewerPassword, viewer.deviceId);
                check("B20. A user without users.read can reach the dashboard", await landedOnDashboard());
                check(
                    "B20. Following User Management does not grant access (/users shows Permission denied, no user rows)",
                    (await clickLink("User Management")) && (await page.waitFor(`location.pathname === "/users"`))
                    && (await page.waitForText("Permission denied")) && !(await page.eval<boolean>(`Boolean(${rowFor(owner.email)})`))
                );
                await page.goto("/dashboard");
                await landedOnDashboard();
                check(
                    "B20. The My account link opens the user's own account page",
                    (await clickLink("My account")) && (await page.waitFor(`location.pathname === "/account"`))
                    && (await page.waitForText("Signed in as")) && (await page.text()).includes(viewer.email)
                );

                const auditActions = (await AuditLog.find({ tenantId: tid }).select("action").lean()).map((a) => a.action);
                check(
                    "B15. UI actions were audited (created, updated, password reset, deactivated, password changed)",
                    ["user.created", "user.updated", "user.password_reset", "user.deactivated", "user.password_changed"].every((a) => auditActions.includes(a)),
                    auditActions.join(",")
                );
            }
        },
    });
}

main().catch((error: unknown) => {
    console.error("Browser tests aborted:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
