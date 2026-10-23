
/*
 * Sync error classification and message sanitizing tests
 * (NO DATABASE, NO SERVER, NO NETWORK).
 *
 * Exercises lib/services/SyncErrors.ts with plain errors and with real
 * driver and Mongoose error CLASSES (constructed in memory; nothing
 * connects), and reads lib/services/SyncService.ts to pin that only
 * sanitized text is stored on an operation or returned to the client.
 *
 * Every error text below is FAKE test data; no real address, database name
 * or credential is used.
 *
 * Run (from the project root):
 *   npx tsx scripts/test-sync-error-classification.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import mongoose from "mongoose";

import {
    MAX_SYNC_ATTEMPTS,
    SYNC_INTERNAL_ERROR_MESSAGE,
    SyncProcessError,
    classifySyncError,
    publicStoredSyncMessage,
    publicSyncErrorMessage,
    statusAfterFailure,
} from "../lib/services/SyncErrors";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

const m = mongoose.mongo;

// Text that must never reach a stored operation or the client.
const LEAK = /E11000|collection:|index:|dup key|fakedb\.|tenantId_1|mongodb(\+srv)?:\/\/|fake-secret|fakecluster|10\.9\.8\.7|ECONN|ENOTFOUND|getaddrinfo|Cannot read properties|is not defined|at Object\.|\.ts:\d/i;

// ------------------------------------------------------------ fake errors
const businessError = new Error("Insufficient stock for product Widget");
const permissionError = Object.assign(
    new Error("You no longer have permission for this operation; it needs review"),
    { name: "BusinessPermissionError" }
);
const validationError = new mongoose.Error.ValidationError();
const castError = new mongoose.Error.CastError("ObjectId", "not-an-id", "productId");
const duplicateKey = new m.MongoServerError({
    message: "E11000 duplicate key error collection: fakedb.stockmovements index: tenantId_1_x_1 dup key: { tenantId: ObjectId('x') }",
    code: 11000,
});
const documentValidation = new m.MongoServerError({ message: "Document failed validation", code: 121 });
const unknownServerCode = new m.MongoServerError({ message: "fakecluster AtlasError: something unusual", code: 8000 });
const unauthorizedServer = new m.MongoServerError({ message: "not authorized on fakedb to execute command", code: 13 });
const writeConflict = new m.MongoServerError({ message: "WriteConflict", code: 112 });
const transientLabel = new m.MongoServerError({ message: "x", code: 999 });
transientLabel.addErrorLabel("TransientTransactionError");
const networkError = new m.MongoNetworkError("connect ECONNREFUSED 10.9.8.7:27017");
const selectionError = Object.assign(new Error("Server selection timed out after 15000 ms"), { name: "MongooseServerSelectionError" });
const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND fakecluster.example.invalid"), { code: "ENOTFOUND" });
const uriLeak = new Error("failed to connect to mongodb+srv://fakeuser:fake-secret@fakecluster.example.invalid/fakedb");
const bufferingError = new Error("Operation `sales.findOne()` buffering timed out after 10000ms");
const typeError = new TypeError("Cannot read properties of undefined (reading 'price')");
const referenceError = new ReferenceError("product is not defined");

// ------------------------------------------------------------ classification
check("C1. Business errors stay PERMANENT (insufficient stock, permission refused)",
    classifySyncError(businessError) === "PERMANENT" && classifySyncError(permissionError) === "PERMANENT");
check("C2. Data errors stay PERMANENT (Mongoose validation, cast, duplicate key, document validation)",
    classifySyncError(validationError) === "PERMANENT"
    && classifySyncError(castError) === "PERMANENT"
    && classifySyncError(duplicateKey) === "PERMANENT"
    && classifySyncError(documentValidation) === "PERMANENT",
    [validationError, castError, duplicateKey, documentValidation].map((e) => classifySyncError(e)).join(","));
check("C3. Programming errors stay PERMANENT (TypeError, ReferenceError)",
    classifySyncError(typeError) === "PERMANENT" && classifySyncError(referenceError) === "PERMANENT");
check("C4. Previously retryable errors are still RETRYABLE (network, write conflict, transaction label, buffering)",
    classifySyncError(networkError) === "RETRYABLE"
    && classifySyncError(writeConflict) === "RETRYABLE"
    && classifySyncError(transientLabel) === "RETRYABLE"
    && classifySyncError(bufferingError) === "RETRYABLE");
check("C5. NEW: a database error with an unknown server code is RETRYABLE (was PERMANENT)",
    classifySyncError(unknownServerCode) === "RETRYABLE" && classifySyncError(unauthorizedServer) === "RETRYABLE",
    `${classifySyncError(unknownServerCode)},${classifySyncError(unauthorizedServer)}`);
check("C6. NEW: driver/infrastructure errors detected by name, system code or text are RETRYABLE",
    classifySyncError(selectionError) === "RETRYABLE"
    && classifySyncError(dnsError) === "RETRYABLE"
    && classifySyncError(uriLeak) === "RETRYABLE");
check("C7. Non-Error values stay PERMANENT", [null, undefined, "text", 42].every((v) => classifySyncError(v) === "PERMANENT"));

// ------------------------------------------------------------ attempt limit (unchanged)
check("L1. The server attempt limit is still 8", MAX_SYNC_ATTEMPTS === 8, String(MAX_SYNC_ATTEMPTS));
check("L2. RETRYABLE below the limit -> FAILED; at the limit -> NEEDS_ATTENTION / RETRIES_EXHAUSTED",
    statusAfterFailure("RETRYABLE", MAX_SYNC_ATTEMPTS - 1).status === "FAILED"
    && statusAfterFailure("RETRYABLE", MAX_SYNC_ATTEMPTS).status === "NEEDS_ATTENTION"
    && statusAfterFailure("RETRYABLE", MAX_SYNC_ATTEMPTS).failureKind === "RETRIES_EXHAUSTED");
check("L3. PERMANENT -> NEEDS_ATTENTION immediately",
    statusAfterFailure("PERMANENT", 1).status === "NEEDS_ATTENTION" && statusAfterFailure("PERMANENT", 1).failureKind === "PERMANENT");

// ------------------------------------------------------------ message sanitizing
check("M1. Readable business messages are kept unchanged",
    publicSyncErrorMessage(businessError) === businessError.message
    && publicSyncErrorMessage(permissionError) === permissionError.message);
check("M2. Our own SyncProcessError messages are kept unchanged",
    publicSyncErrorMessage(new SyncProcessError(403, "PERMISSION_DENIED", "This type of operation cannot be synchronized", false))
    === "This type of operation cannot be synchronized");

const internals: [string, unknown][] = [
    ["duplicate-key error", duplicateKey],
    ["unknown server code", unknownServerCode],
    ["unauthorized server error", unauthorizedServer],
    ["network error with an address", networkError],
    ["server selection error", selectionError],
    ["DNS error", dnsError],
    ["plain Error containing a connection string", uriLeak],
    ["Mongoose cast error", castError],
    ["TypeError", typeError],
    ["ReferenceError", referenceError],
];
for (const [label, error] of internals) {
    check(`M3. ${label}: replaced by the fixed internal-problem text`,
        publicSyncErrorMessage(error) === SYNC_INTERNAL_ERROR_MESSAGE);
}
check("M4. Non-Error values get the fixed internal-problem text",
    [null, undefined, "raw text", 42, { message: "x" }].every((v) => publicSyncErrorMessage(v) === SYNC_INTERNAL_ERROR_MESSAGE));
check("M5. The fixed text itself reveals nothing", !LEAK.test(SYNC_INTERNAL_ERROR_MESSAGE) && !/mongo|database|secret|@/i.test(SYNC_INTERNAL_ERROR_MESSAGE));
check("M6. No sanitized message leaks infrastructure, data or code detail",
    internals.every(([, error]) => !LEAK.test(publicSyncErrorMessage(error))));
check("M7. 'Sync failed permanently: <message>' (as returned to the client) contains no leak for a duplicate key",
    !LEAK.test(`Sync failed permanently: ${publicSyncErrorMessage(duplicateKey)}`));

// Messages stored before sanitizing existed.
check("S1. A raw stored database message is replaced when returned",
    publicStoredSyncMessage(duplicateKey.message) === SYNC_INTERNAL_ERROR_MESSAGE
    && publicStoredSyncMessage(uriLeak.message) === SYNC_INTERNAL_ERROR_MESSAGE);
check("S2. A stored business message is returned unchanged",
    publicStoredSyncMessage("Insufficient stock for product Widget") === "Insufficient stock for product Widget");
check("S3. A missing stored message stays missing",
    publicStoredSyncMessage(undefined) === undefined && publicStoredSyncMessage("") === undefined);

// ------------------------------------------------------------ SyncService uses it (source pins)
const service = readFileSync(path.join(process.cwd(), "lib/services/SyncService.ts"), "utf8");
check("P1. SyncService stores and returns publicSyncErrorMessage(error), not the raw error text",
    /const errorMessage = publicSyncErrorMessage\(error\);/.test(service)
    && !/error instanceof Error \? error\.message/.test(service)
    && !/errorMessage:\s*error\.message/.test(service));
check("P2. SyncService never returns a stored message raw",
    /publicStoredSyncMessage\(existingOperation\.errorMessage\)/.test(service)
    && !/\$\{existingOperation\.errorMessage\}/.test(service));
check("P3. SyncService logs only the error name and code, never the message",
    /console\.error\(\s*"Sync processing error:"/.test(service) && !/console\.error\([^)]*error\.message/.test(service));

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`));
process.exitCode = failed.length ? 1 : 0;
