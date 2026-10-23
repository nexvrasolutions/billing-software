import { NextResponse } from "next/server";
import {
    MaintenancePausedError,
    isMaintenancePausedError,
} from "@/lib/services/SyncErrors";

export { MaintenancePausedError, isMaintenancePausedError };

/**
 * Server-Side Write-Pause Configuration for Database Maintenance.
 * Provides a controlled, narrow switch to pause purchase creation and
 * purchase offline-sync ingestion/processing during sensitive database
 * maintenance (such as Atlas index replacements).
 *
 * Invariants:
 * 1. Disabled by default: When env variable is unset or false, all routes behave normally.
 * 2. Stable response contract: Returns HTTP 503 with code "MAINTENANCE_PAUSED" and Retry-After: 30.
 * 3. Scope isolation: Narrowly affects Purchase mutations without blocking unrelated entities (Sales, Customers, etc.).
 * 4. Client safety: Offline clients interpret 503 as retryable and safely retain operations in IndexedDB without data loss.
 * 5. Secret protection: Never logs connection strings, credentials, or customer payloads.
 */

export const MAINTENANCE_PAUSED_CODE = "MAINTENANCE_PAUSED";
export const DEFAULT_RETRY_AFTER_SECONDS = 30;

export const DEFAULT_PURCHASE_PAUSED_MESSAGE =
    "Purchase creation is temporarily paused for database maintenance. Please retry shortly.";

export const DEFAULT_PURCHASE_SYNC_UPLOAD_PAUSED_MESSAGE =
    "Purchase sync upload is temporarily paused for database maintenance. Please retry shortly.";

export const DEFAULT_PURCHASE_SYNC_PROCESS_PAUSED_MESSAGE =
    "Purchase sync processing is temporarily paused for database maintenance. Please retry shortly.";

/**
 * Checks whether purchase writes are currently paused.
 * Disabled by default. Only enabled when PURCHASE_WRITES_PAUSED="true" or MAINTENANCE_PAUSED="true".
 *
 * Can accept an explicit env dictionary for isolated unit testing.
 */
export function isPurchaseWritePaused(env: Record<string, string | undefined> = process.env): boolean {
    const rawVal = env.PURCHASE_WRITES_PAUSED ?? env.MAINTENANCE_PAUSED;
    if (!rawVal || typeof rawVal !== "string") {
        return false;
    }

    const trimmed = rawVal.trim().toLowerCase();
    return trimmed === "true" || trimmed === "1" || trimmed === "yes";
}

/**
 * Builds a standardized HTTP 503 response for direct API routes.
 */
export function createMaintenancePausedResponse(
    message: string = DEFAULT_PURCHASE_PAUSED_MESSAGE,
    retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS
): NextResponse {
    return NextResponse.json(
        {
            success: false,
            code: MAINTENANCE_PAUSED_CODE,
            retryable: true,
            message,
            retryAfterSeconds,
        },
        {
            status: 503,
            headers: {
                "Retry-After": String(retryAfterSeconds),
                "Cache-Control": "no-store",
            },
        }
    );
}

/**
 * Builds a standardized MaintenancePausedError for offline sync processing.
 */
export function createMaintenancePausedError(
    message: string = DEFAULT_PURCHASE_SYNC_PROCESS_PAUSED_MESSAGE,
    retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS
): MaintenancePausedError {
    return new MaintenancePausedError(message, retryAfterSeconds);
}
