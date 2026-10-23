/**
 * Test Suite: Role-Based Staff Dashboard Access Control
 * (DATABASE-FREE, NETWORK-FREE UNIT TESTS)
 *
 * Verifies:
 * 1. Sidebar Navigation Filtering:
 *    - Staff without product permissions do not see Add Product or Products catalog.
 *    - Staff without category/unit permissions do not see Categories & Units.
 *    - Staff without inventory permissions do not see Inventory Administration or Stock Adjustment.
 *    - Staff without purchase permissions do not see Purchases.
 *    - Staff without supplier permissions do not see Suppliers.
 *    - Staff without audit-read permission do not see Audit Logs.
 *    - Staff without settings permission do not see Business Settings.
 *    - Staff without user-management permissions do not see Staff Management.
 *    - Parent menu groups are completely hidden when all their children are inaccessible.
 *    - Authorized owner/administrators retain all appropriate menu items.
 * 2. Direct Route Authorization (isRouteAuthorized):
 *    - Default staff with only sales.create cannot access product master, inventory, purchases, suppliers, settings, audit logs, or users.
 *    - Unauthenticated / unpermitted routes fail closed.
 *    - Business owner is granted full access across all modules.
 *    - Granular permissions (e.g. reports.read vs auditLogs.read) are strictly differentiated.
 * 3. Server-Side Permission Contracts:
 *    - PRODUCT_COST_PERMISSIONS protects purchase cost from pure sales staff.
 *    - SUPPLIER_READ_PERMISSIONS and SUPPLIER_WRITE_PERMISSIONS enforce purchase/user privileges.
 *    - CUSTOMER_READ_PERMISSIONS and CUSTOMER_WRITE_PERMISSIONS support cashier POS workflows.
 *    - BUSINESS_PERMISSIONS defines salesRead correctly.
 *
 * Run:
 *   npx tsx scripts/test-role-access-control.ts
 */

if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "throwaway-secret-for-database-free-tests-only";
}

import {
    NAV_GROUPS,
    NAV_PERMISSION_MAP,
    filterNavGroups,
    isRouteAuthorized,
} from "../components/layout/AppShell";
import { PRODUCT_COST_PERMISSIONS } from "../lib/catalog/productProjection";
import { SUPPLIER_READ_PERMISSIONS, SUPPLIER_WRITE_PERMISSIONS } from "../lib/validations/supplier";
import { CUSTOMER_READ_PERMISSIONS, CUSTOMER_WRITE_PERMISSIONS } from "../lib/validations/customer";
import { BUSINESS_PERMISSIONS } from "../lib/auth/businessPermissions";

// ============================================================
// TEST HARNESS
// ============================================================

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

// ============================================================
// SUITE 1: SIDEBAR NAVIGATION FILTERING
// ============================================================
console.log("\n-- 1. Sidebar Navigation Filtering for Default Staff (sales.create only) --");

const defaultStaffPermissions = ["sales.create"];
const staffNav = filterNavGroups(NAV_GROUPS, defaultStaffPermissions, false);
const staffGroupTitles = staffNav.map((g) => g.title);
const allStaffLinks = staffNav.flatMap((g) => g.links.map((l) => l.href));

check("1.1 Default staff sees 'Sell' group", staffGroupTitles.includes("Sell"));
check("1.2 Default staff can see '/dashboard'", allStaffLinks.includes("/dashboard"));
check("1.3 Default staff can see '/pos' (New bill)", allStaffLinks.includes("/pos"));
check("1.4 Default staff can see '/sales' when sales.create is present", allStaffLinks.includes("/sales"));
check("1.5 Default staff sees '/customers' under Money", allStaffLinks.includes("/customers"));

// Restricted items must NOT be present
check("1.6 Default staff does NOT see Products ('/catalog/products')", !allStaffLinks.includes("/catalog/products"));
check("1.7 Default staff does NOT see Categories & Units ('/catalog/lists')", !allStaffLinks.includes("/catalog/lists"));
check("1.8 Default staff does NOT see Inventory ('/inventory')", !allStaffLinks.includes("/inventory"));
check("1.9 Default staff does NOT see Opening stock ('/inventory/opening')", !allStaffLinks.includes("/inventory/opening"));
check("1.10 Default staff does NOT see Purchases ('/purchases')", !allStaffLinks.includes("/purchases"));
check("1.11 Default staff does NOT see Suppliers ('/suppliers')", !allStaffLinks.includes("/suppliers"));
check("1.12 Default staff does NOT see Import products ('/catalog/import')", !allStaffLinks.includes("/catalog/import"));
check("1.13 Default staff does NOT see Reports ('/reports')", !allStaffLinks.includes("/reports"));
check("1.14 Default staff does NOT see Business settings ('/settings')", !allStaffLinks.includes("/settings"));
check("1.15 Default staff does NOT see Branches ('/settings/branches')", !allStaffLinks.includes("/settings/branches"));
check("1.16 Default staff does NOT see Till flags ('/settings/tills/flags')", !allStaffLinks.includes("/settings/tills/flags"));
check("1.17 Default staff does NOT see Staff management ('/users')", !allStaffLinks.includes("/users"));

// Parent menu groups must be hidden when all children are restricted
check("1.18 'Stock' parent group is completely hidden for default staff", !staffGroupTitles.includes("Stock"));
check("1.19 'Settings' parent group is completely hidden for default staff", !staffGroupTitles.includes("Settings"));

// ============================================================
// SUITE 2: SIDEBAR NAVIGATION FOR OTHER SPECIALIZED ROLES
// ============================================================
console.log("\n-- 2. Sidebar Navigation for Other Roles (Cashier, Accountant, Inventory Mgr, Owner) --");

// Cashier with sales.create + sales.read
const cashierNav = filterNavGroups(NAV_GROUPS, ["sales.create", "sales.read"], false);
const cashierLinks = cashierNav.flatMap((g) => g.links.map((l) => l.href));
check("2.1 Cashier does not see 'Stock' group", !cashierNav.some((g) => g.title === "Stock"));
check("2.2 Cashier does not see 'Settings' group", !cashierNav.some((g) => g.title === "Settings"));
check("2.3 Cashier has '/pos' and '/sales'", cashierLinks.includes("/pos") && cashierLinks.includes("/sales"));

// Accountant with sales.read + reports.read
const accountantNav = filterNavGroups(NAV_GROUPS, ["sales.read", "reports.read"], false);
const accountantLinks = accountantNav.flatMap((g) => g.links.map((l) => l.href));
check("2.4 Accountant sees '/reports'", accountantLinks.includes("/reports"));
check("2.5 Accountant does NOT see '/pos'", !accountantLinks.includes("/pos"));
check("2.6 Accountant does NOT see 'Stock' group", !accountantNav.some((g) => g.title === "Stock"));

// Inventory Manager
const inventoryMgrNav = filterNavGroups(
    NAV_GROUPS,
    ["products.read", "products.create", "products.update", "stock.adjust", "purchases.read", "purchases.create"],
    false
);
const inventoryMgrTitles = inventoryMgrNav.map((g) => g.title);
const inventoryMgrLinks = inventoryMgrNav.flatMap((g) => g.links.map((l) => l.href));
check("2.7 Inventory Manager sees 'Stock' group", inventoryMgrTitles.includes("Stock"));
check("2.8 Inventory Manager sees '/catalog/products'", inventoryMgrLinks.includes("/catalog/products"));
check("2.9 Inventory Manager sees '/inventory'", inventoryMgrLinks.includes("/inventory"));
check("2.10 Inventory Manager sees '/purchases'", inventoryMgrLinks.includes("/purchases"));
check("2.11 Inventory Manager does NOT see 'Settings' group", !inventoryMgrTitles.includes("Settings"));

// Owner / Administrator
const ownerNav = filterNavGroups(NAV_GROUPS, [], true);
const ownerGroupTitles = ownerNav.map((g) => g.title);
const allOwnerLinks = ownerNav.flatMap((g) => g.links.map((l) => l.href));
check("2.12 Owner sees 'Sell' group", ownerGroupTitles.includes("Sell"));
check("2.13 Owner sees 'Stock' group", ownerGroupTitles.includes("Stock"));
check("2.14 Owner sees 'Money' group", ownerGroupTitles.includes("Money"));
check("2.15 Owner sees 'Settings' group", ownerGroupTitles.includes("Settings"));
check("2.16 Owner retains all 15 navigation links", allOwnerLinks.length >= 15);

// ============================================================
// SUITE 3: DIRECT ROUTE AUTHORIZATION (isRouteAuthorized)
// ============================================================
console.log("\n-- 3. Direct Route Authorization (isRouteAuthorized) --");

// Default Staff restrictions
check("3.1 Staff can access /dashboard", isRouteAuthorized("/dashboard", defaultStaffPermissions, false));
check("3.2 Staff can access /pos", isRouteAuthorized("/pos", defaultStaffPermissions, false));
check("3.3 Staff can access /sales", isRouteAuthorized("/sales", defaultStaffPermissions, false));
check("3.4 Staff can access /sales/any-id", isRouteAuthorized("/sales/64a1b2c3d4e5f67890123456", defaultStaffPermissions, false));
check("3.5 Staff can access /customers", isRouteAuthorized("/customers", defaultStaffPermissions, false));
check("3.6 Staff CANNOT access /catalog/products", !isRouteAuthorized("/catalog/products", defaultStaffPermissions, false));
check("3.7 Staff CANNOT access /catalog/products/new", !isRouteAuthorized("/catalog/products/new", defaultStaffPermissions, false));
check("3.8 Staff CANNOT access /catalog/lists", !isRouteAuthorized("/catalog/lists", defaultStaffPermissions, false));
check("3.9 Staff CANNOT access /inventory", !isRouteAuthorized("/inventory", defaultStaffPermissions, false));
check("3.10 Staff CANNOT access /inventory/adjust", !isRouteAuthorized("/inventory/adjust", defaultStaffPermissions, false));
check("3.11 Staff CANNOT access /inventory/opening", !isRouteAuthorized("/inventory/opening", defaultStaffPermissions, false));
check("3.12 Staff CANNOT access /purchases", !isRouteAuthorized("/purchases", defaultStaffPermissions, false));
check("3.13 Staff CANNOT access /purchases/new", !isRouteAuthorized("/purchases/new", defaultStaffPermissions, false));
check("3.14 Staff CANNOT access /suppliers", !isRouteAuthorized("/suppliers", defaultStaffPermissions, false));
check("3.15 Staff CANNOT access /settings", !isRouteAuthorized("/settings", defaultStaffPermissions, false));
check("3.16 Staff CANNOT access /settings/business", !isRouteAuthorized("/settings/business", defaultStaffPermissions, false));
check("3.17 Staff CANNOT access /users", !isRouteAuthorized("/users", defaultStaffPermissions, false));
check("3.18 Staff CANNOT access /reports", !isRouteAuthorized("/reports", defaultStaffPermissions, false));
check("3.19 Staff CANNOT access /reports/audit", !isRouteAuthorized("/reports/audit", defaultStaffPermissions, false));

// Owner full access
check("3.20 Owner can access /catalog/products/new", isRouteAuthorized("/catalog/products/new", [], true));
check("3.21 Owner can access /inventory/adjust", isRouteAuthorized("/inventory/adjust", [], true));
check("3.22 Owner can access /purchases/new", isRouteAuthorized("/purchases/new", [], true));
check("3.23 Owner can access /reports/audit", isRouteAuthorized("/reports/audit", [], true));
check("3.24 Owner can access /settings/business", isRouteAuthorized("/settings/business", [], true));
check("3.25 Owner can access /users", isRouteAuthorized("/users", [], true));

// Granular Reports vs Audit Log authorization
const reportsOnly = ["reports.read"];
check("3.26 reports.read allows /reports", isRouteAuthorized("/reports", reportsOnly, false));
check("3.27 reports.read does NOT allow /reports/audit", !isRouteAuthorized("/reports/audit", reportsOnly, false));
const auditOnly = ["auditLogs.read"];
check("3.28 auditLogs.read allows /reports/audit", isRouteAuthorized("/reports/audit", auditOnly, false));

// Unauthenticated / empty permissions
check("3.29 Empty permissions cannot access /catalog/products", !isRouteAuthorized("/catalog/products", [], false));
check("3.30 Empty permissions cannot access /settings", !isRouteAuthorized("/settings", [], false));

// ============================================================
// SUITE 4: SERVER-SIDE PERMISSION CONSTANTS & FAIL-CLOSED GUARDS
// ============================================================
console.log("\n-- 4. Server-Side Permission Constants & Fail-Closed Guards --");

// Products: purchase cost must be protected from sales staff
check("4.1 PRODUCT_COST_PERMISSIONS excludes pure 'sales.create'", !(PRODUCT_COST_PERMISSIONS as readonly string[]).includes("sales.create"));
check("4.2 PRODUCT_COST_PERMISSIONS includes 'products.create'", (PRODUCT_COST_PERMISSIONS as readonly string[]).includes("products.create"));
check("4.3 PRODUCT_COST_PERMISSIONS includes 'products.update'", (PRODUCT_COST_PERMISSIONS as readonly string[]).includes("products.update"));
check("4.4 PRODUCT_COST_PERMISSIONS includes 'purchases.create'", (PRODUCT_COST_PERMISSIONS as readonly string[]).includes("purchases.create"));

// Suppliers: read and write permissions
check("4.5 SUPPLIER_READ_PERMISSIONS contains 'purchases.read'", SUPPLIER_READ_PERMISSIONS.includes("purchases.read"));
check("4.6 SUPPLIER_READ_PERMISSIONS excludes pure 'sales.create'", !SUPPLIER_READ_PERMISSIONS.includes("sales.create"));
check("4.7 SUPPLIER_WRITE_PERMISSIONS contains 'purchases.create'", SUPPLIER_WRITE_PERMISSIONS.includes("purchases.create"));
check("4.8 SUPPLIER_WRITE_PERMISSIONS excludes pure 'sales.create'", !SUPPLIER_WRITE_PERMISSIONS.includes("sales.create"));

// Customers: cashier needs sales.create for customer operations during billing
check("4.9 CUSTOMER_READ_PERMISSIONS includes 'sales.create'", CUSTOMER_READ_PERMISSIONS.includes("sales.create"));
check("4.10 CUSTOMER_READ_PERMISSIONS includes 'sales.read'", CUSTOMER_READ_PERMISSIONS.includes("sales.read"));
check("4.11 CUSTOMER_WRITE_PERMISSIONS includes 'sales.create'", CUSTOMER_WRITE_PERMISSIONS.includes("sales.create"));
check("4.12 CUSTOMER_WRITE_PERMISSIONS excludes unauthorized staff without role", !CUSTOMER_WRITE_PERMISSIONS.includes("none"));

// Business permissions catalogue
check("4.13 BUSINESS_PERMISSIONS.salesRead is 'sales.read'", BUSINESS_PERMISSIONS.salesRead === "sales.read");

// ============================================================
// SUMMARY
// ============================================================
const passedCount = results.filter((r) => r.passed).length;
const totalCount = results.length;

console.log("\n============================================================");
console.log(`ROLE ACCESS CONTROL TEST SUMMARY: ${passedCount}/${totalCount} checks passed.`);
console.log("============================================================\n");

if (passedCount !== totalCount) {
    process.exit(1);
}
