
import mongoose from "mongoose";

import { GENERIC_ERROR_MESSAGE, isInternalError, publicErrorMessage } from "@/lib/api/publicError";

/*
 * Failure handling for offline-sync processing.
 *
 * RETRYABLE  - temporary infrastructure problems (network, database
 *              unavailable, write conflicts). Safe to retry because every
 *              synced business operation is idempotent per operationId.
 * PERMANENT  - business or data errors (insufficient stock, invalid data,
 *              duplicate invoice number, unsupported entity). Retrying can
 *              never succeed, so the operation needs a person to act.
 */

/** Server-side attempt limit; beyond it the operation needs attention. */
export const MAX_SYNC_ATTEMPTS = 8;

/** How long a claim on an operation is valid before it can be reclaimed. */
export const SYNC_LEASE_MS = 2 * 60 * 1000;

export type SyncFailureKind = "RETRYABLE" | "PERMANENT";

export type SyncErrorCode =
    | "INVALID_REQUEST"
    | "OWNER_MISMATCH"
    | "PERMISSION_DENIED"
    | "NOT_FOUND"
    | "OPERATION_ID_CONFLICT"
    | "IN_PROGRESS"
    | "NEEDS_ATTENTION"
    | "PERMANENT_FAILURE"
    | "RETRYABLE_FAILURE";

/** A sync failure with the HTTP status and guidance the client needs. */
export class SyncProcessError extends Error {
    constructor(
        public readonly httpStatus: number,
        public readonly code: SyncErrorCode,
        message: string,
        public readonly retryable: boolean,
        public readonly retryAfterSeconds?: number
    ) {
        super(message);
        this.name = "SyncProcessError";
    }

    toJSON() {
        return {
            success: false,
            code: this.code,
            retryable: this.retryable,
            message: this.message,
            ...(this.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: this.retryAfterSeconds }
                : {}),
        };
    }
}

// MongoDB server error codes that indicate a temporary condition.
const RETRYABLE_SERVER_CODES = new Set([
    6, // HostUnreachable
    7, // HostNotFound
    50, // MaxTimeMSExpired
    89, // NetworkTimeout
    91, // ShutdownInProgress
    112, // WriteConflict
    189, // PrimarySteppedDown
    251, // NoSuchTransaction
    262, // ExceededTimeLimit
    9001, // SocketException
    10107, // NotWritablePrimary
    11600, // InterruptedAtShutdown
    11602, // InterruptedDueToReplStateChange
    13435, // NotPrimaryNoSecondaryOk
    13436, // NotPrimaryOrSecondary
]);

const RETRYABLE_LABELS = [
    "TransientTransactionError",
    "RetryableWriteError",
    "UnknownTransactionCommitResult",
];

// Driver/Mongoose errors caused by the operation's own data: retrying the
// same payload can never succeed, so they stay PERMANENT.
const PERMANENT_DATA_ERROR_NAMES = new Set([
    "CastError",
    "StrictModeError",
    "ObjectParameterError",
    "DivergentArrayError",
]);

const PERMANENT_SERVER_CODES = new Set([
    2, // BadValue
    9, // FailedToParse
    14, // TypeMismatch
    121, // DocumentValidationFailure
    11000, // DuplicateKey
]);

// Built-in JavaScript errors point at a programming bug; their text means
// nothing to a shop and is never stored or shown.
const PROGRAMMING_ERROR_NAMES = new Set([
    "TypeError",
    "ReferenceError",
    "RangeError",
    "SyntaxError",
    "EvalError",
    "URIError",
]);

/** Shown instead of any database, driver or programming error text. */
export const SYNC_INTERNAL_ERROR_MESSAGE =
    "An internal problem occurred while processing this operation";

/** Decide whether an error from processing is temporary or permanent. */
export function classifySyncError(error: unknown): SyncFailureKind {
    const mongo = mongoose.mongo;

    if (
        error instanceof mongo.MongoNetworkError ||
        error instanceof mongo.MongoServerSelectionError ||
        error instanceof mongo.MongoNotConnectedError ||
        error instanceof mongo.MongoTopologyClosedError ||
        error instanceof mongoose.Error.MongooseServerSelectionError
    ) {
        return "RETRYABLE";
    }

    if (
        error instanceof mongo.MongoError &&
        RETRYABLE_LABELS.some((label) => error.hasErrorLabel(label))
    ) {
        return "RETRYABLE";
    }

    if (
        error instanceof mongo.MongoServerError &&
        typeof error.code === "number" &&
        RETRYABLE_SERVER_CODES.has(error.code)
    ) {
        return "RETRYABLE";
    }

    // Mongoose gives up on commands buffered while disconnected.
    if (error instanceof Error && /buffering timed out/i.test(error.message)) {
        return "RETRYABLE";
    }

    // Errors caused by the data itself (invalid IDs, schema rejections,
    // duplicate keys) never succeed on a retry.
    if (error instanceof Error && PERMANENT_DATA_ERROR_NAMES.has(error.name)) {
        return "PERMANENT";
    }

    const code = (error as { code?: unknown } | null)?.code;

    if (typeof code === "number" && PERMANENT_SERVER_CODES.has(code)) {
        return "PERMANENT";
    }

    // Any other database or driver failure (unknown server code, driver
    // error class, connection text) is treated as temporary. The attempt
    // limit (MAX_SYNC_ATTEMPTS) still stops it from being retried forever.
    if (isInternalError(error)) {
        return "RETRYABLE";
    }

    // Business validation errors (plain Error from the services), Mongoose
    // validation errors and anything unexpected need a person.
    return "PERMANENT";
}

/**
 * The text of a processing failure that may be stored on the operation and
 * returned to the client: readable business messages and our own
 * SyncProcessError messages are kept; database, driver and programming
 * error text is replaced by SYNC_INTERNAL_ERROR_MESSAGE.
 */
export function publicSyncErrorMessage(error: unknown): string {
    if (error instanceof SyncProcessError) {
        return error.message;
    }

    if (error instanceof Error && PROGRAMMING_ERROR_NAMES.has(error.name)) {
        return SYNC_INTERNAL_ERROR_MESSAGE;
    }

    const message = publicErrorMessage(error, SYNC_INTERNAL_ERROR_MESSAGE);

    return message === GENERIC_ERROR_MESSAGE ? SYNC_INTERNAL_ERROR_MESSAGE : message;
}

/**
 * A message already stored on an operation (records saved before messages
 * were sanitized may hold raw database text), made safe to return.
 */
export function publicStoredSyncMessage(message: string | undefined): string | undefined {
    if (!message) {
        return undefined;
    }

    return publicSyncErrorMessage(new Error(message));
}

/** Status after a failed attempt (attempts already includes this attempt). */
export function statusAfterFailure(
    kind: SyncFailureKind,
    attempts: number
): { status: "FAILED" | "NEEDS_ATTENTION"; failureKind: "RETRYABLE" | "PERMANENT" | "RETRIES_EXHAUSTED" } {
    if (kind === "PERMANENT") {
        return { status: "NEEDS_ATTENTION", failureKind: "PERMANENT" };
    }

    if (attempts >= MAX_SYNC_ATTEMPTS) {
        return { status: "NEEDS_ATTENTION", failureKind: "RETRIES_EXHAUSTED" };
    }

    return { status: "FAILED", failureKind: "RETRYABLE" };
}
