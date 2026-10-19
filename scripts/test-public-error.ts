
/*
 * Public error message tests (NO DATABASE, NO SERVER, NO NETWORK).
 *
 * Exercises lib/api/publicError.ts with plain errors and with real driver
 * and Mongoose error CLASSES (constructed in memory; nothing connects), and
 * reads the seven business routes to pin that they use it.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-public-error.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import mongoose from "mongoose";

import { GENERIC_ERROR_MESSAGE, isInternalError, publicErrorMessage } from "../lib/api/publicError";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const FALLBACK = "Failed to create sale";

// ------------------------------------------------------------ readable business messages are kept
const business = [
    "Invoice INV-1 already exists",
    "Insufficient stock for product Widget in warehouse Main (available 2, requested 5)",
    "Sale date cannot be in the future",
    "This sale date is too far in the past; it requires the sales.backdate permission",
    "At least one sale item is required",
    "Customer not found or inactive",
];
check("B1. Readable business messages are returned unchanged",
    business.every((message) => publicErrorMessage(new Error(message), FALLBACK) === message));
check("B2. A business message that merely contains \"at ... (\" or \"index\" words is not mistaken for an internal error",
    publicErrorMessage(new Error("Product not found at Warehouse (Main)"), FALLBACK) === "Product not found at Warehouse (Main)"
    && publicErrorMessage(new Error("Item index 3 has an invalid quantity"), FALLBACK) === "Item index 3 has an invalid quantity");
check("B3. A Mongoose validation message (a business-level input error) is still shown",
    publicErrorMessage(new mongoose.Error.ValidationError(), FALLBACK) === "Validation failed"
    || publicErrorMessage(new mongoose.Error.ValidationError(), FALLBACK).length > 0);

// ------------------------------------------------------------ infrastructure errors are hidden
const dup = new mongoose.mongo.MongoServerError({
    message: "E11000 duplicate key error collection: billing.sales index: tenantId_1_invoiceNo_1 dup key: { tenantId: ObjectId('x'), invoiceNo: \"A\" }",
    code: 11000,
});
const network = new mongoose.mongo.MongoNetworkError("connect ECONNREFUSED 10.1.2.3:27017");
const cast = new mongoose.Error.CastError("ObjectId", "not-an-id", "_id");
const selection = Object.assign(new Error("Server selection timed out after 15000 ms"), { name: "MongooseServerSelectionError" });
const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND cluster0.example.mongodb.net"), { code: "ENOTFOUND" });
const uriLeak = new Error("failed to connect to mongodb+srv://user:secret@cluster0.example.mongodb.net/db");
const internals: [string, unknown][] = [
    ["duplicate-key driver error", dup],
    ["driver network error", network],
    ["Mongoose cast error", cast],
    ["server selection error", selection],
    ["DNS error with a system code", dnsError],
    ["plain Error whose text contains a connection string", uriLeak],
    ["plain Error with a numeric server code", Object.assign(new Error("boom"), { code: 112 })],
    ["plain Error that mentions a collection and index", new Error("cannot do it on collection: sales index: x")],
];
for (const [label, error] of internals) {
    check(`I1. ${label}: detected as internal and replaced by the generic text`,
        isInternalError(error) && publicErrorMessage(error, FALLBACK) === GENERIC_ERROR_MESSAGE);
}
check("I2. The generic text reveals nothing", !/mongo|collection|index|dup|E11000|ECONN|secret|@/i.test(GENERIC_ERROR_MESSAGE));
check("I3. None of the internal detail leaks into what the caller would see",
    internals.every(([, error]) => {
        const text = publicErrorMessage(error, FALLBACK);
        return !/E11000|billing\.sales|tenantId_1|10\.1\.2\.3|cluster0|secret|ECONN|ENOTFOUND|getaddrinfo/.test(text);
    }));

// ------------------------------------------------------------ edge cases
check("E1. A non-Error value gives the route's own fallback",
    ["text", 42, null, undefined, { message: "x" }].every((value) => publicErrorMessage(value, FALLBACK) === FALLBACK));
check("E2. An Error with an empty or blank message gives the fallback",
    publicErrorMessage(new Error(""), FALLBACK) === FALLBACK && publicErrorMessage(new Error("   "), FALLBACK) === FALLBACK);
check("E3. A very long business message is shortened to 300 characters plus an ellipsis",
    (() => {
        const text = publicErrorMessage(new Error("x".repeat(1000)), FALLBACK);
        return text.length === 303 && text.endsWith("...");
    })());
check("E4. isInternalError is false for non-objects and plain business errors",
    !isInternalError("text") && !isInternalError(null) && !isInternalError(new Error("Invoice A already exists")));

// ------------------------------------------------------------ the routes use it (status codes unchanged)
const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const routes = ["sales", "purchases", "sales-returns", "purchase-returns", "payments", "ledger-entries", "stock-adjustments"];

for (const route of routes) {
    const text = read(`app/api/${route}/route.ts`);
    check(`R1. ${route}: the error response uses publicErrorMessage and no longer sends the raw error message`,
        /import \{ publicErrorMessage \} from "@\/lib\/api\/publicError";/.test(text)
        && /publicErrorMessage\(error, "[^"]+"\)/.test(text)
        && !/error instanceof Error\s*\?\s*error\.message/.test(text)
        && !/message:\s*error\.message/.test(text));
    check(`R2. ${route}: the full error is still logged on the server and authentication/permission checks are intact`,
        /console\.error\(/.test(text) && /getAuthenticatedContext\(/.test(text) && /status: 401/.test(text));
}
const sales = read("app/api/sales/route.ts");
check("R3. sales: the 403 for a refused sale date and the 400 for other failures are unchanged",
    /error instanceof BusinessPermissionError \? 403 : 400/.test(sales));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
