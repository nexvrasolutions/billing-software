
/*
 * Which error text may be shown to the caller of an API route.
 *
 * The business routes (sales, purchases, returns, payments, ledger entries,
 * stock adjustments) answer failures with the error's own message. The
 * services throw plain Errors with readable business messages for rule
 * violations ("Invoice X already exists", "Insufficient stock ..."), and
 * those are meant to be shown. But a database or driver failure carries
 * internal detail: collection and index names, duplicate-key dumps, server
 * addresses, driver error text. That must stay in the server log (the routes
 * still console.error the full error) and never reach the browser.
 *
 * publicErrorMessage keeps readable business messages and replaces
 * infrastructure errors with a fixed generic text. It never changes an HTTP
 * status code; only the message text.
 */

export const GENERIC_ERROR_MESSAGE = "The request could not be completed. Please try again.";

// Error classes of the MongoDB driver, Mongoose and BSON (matched by name so
// this module needs neither package).
const INTERNAL_ERROR_NAME =
    /^(Mongo\w*|Mongoose\w*|BSON\w*|CastError|DocumentNotFoundError|VersionError|ParallelSaveError|StrictModeError|DivergentArrayError|OverwriteModelError|MissingSchemaError|ObjectParameterError|DisconnectedError)$/;

// Text that only infrastructure errors contain.
const INTERNAL_ERROR_TEXT =
    /E11000|\bcollection: |\bindex: |dup key|ECONN\w*|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|mongodb(\+srv)?:\/\/|node_modules|TransientTransactionError|WriteConflict|ReplicaSetNoPrimary|topology|Server selection timed out|Transaction numbers|MongoServerError|MongoNetworkError|Mongoose/i;

const MAX_PUBLIC_LENGTH = 300;

/** True for database/driver/runtime failures whose text must not be shown. */
export function isInternalError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;

    const { name, message, code } = error as { name?: unknown; message?: unknown; code?: unknown };

    if (typeof name === "string" && INTERNAL_ERROR_NAME.test(name)) return true;
    // Driver errors carry a numeric server code (e.g. 11000) or a system code (e.g. ECONNREFUSED).
    if (typeof code === "number" && code > 0) return true;
    if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return true;
    if (typeof message === "string" && INTERNAL_ERROR_TEXT.test(message)) return true;

    return false;
}

/**
 * The message to send to the caller: the error's own text if it is a
 * readable business message, otherwise `fallback` (for non-Error values and
 * empty messages) or the generic text (for infrastructure errors).
 */
export function publicErrorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    if (isInternalError(error)) return GENERIC_ERROR_MESSAGE;

    const message = error.message.trim();
    if (!message) return fallback;

    return message.length > MAX_PUBLIC_LENGTH ? `${message.slice(0, MAX_PUBLIC_LENGTH)}...` : message;
}
