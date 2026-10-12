
import mongoose from "mongoose";

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

    // Business validation errors (plain Error from the services), Mongoose
    // validation/cast errors and anything unexpected need a person.
    return "PERMANENT";
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
