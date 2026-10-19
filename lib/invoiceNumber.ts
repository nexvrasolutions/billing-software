/**
 * Pure, client-safe invoice number and provisional reference utilities.
 * Completely free of database, Mongoose, or Node.js core module dependencies.
 * Safe for use in browser bundles and offline components.
 */

export interface GenerateInvoiceNoOptions {
    prefix?: string;
    date?: Date;
    maxRetries?: number;
    financialYearFormat?: "calendar" | "fy";
}

/**
 * Returns true if an invoice number appears to be a client-generated provisional offline reference
 * rather than a formal, server-assigned sequential legal invoice number.
 */
export function isProvisionalInvoiceNo(invoiceNo?: string | null): boolean {
    if (!invoiceNo || typeof invoiceNo !== "string") return false;
    const upper = invoiceNo.trim().toUpperCase();
    return (
        upper.startsWith("POS-") ||
        upper.startsWith("OFFLINE-") ||
        upper.startsWith("TEMP-") ||
        upper.startsWith("PROV-")
    );
}

/**
 * Generates a collision-resistant, client-side provisional offline invoice reference.
 * Distinct from legal server-allocated sequential GST invoice numbers.
 * Example: generateProvisionalReference("DEV1") -> "OFFLINE-DEV1-L9XYZ1-A7B2"
 */
export function generateProvisionalReference(deviceShortCode?: string): string {
    const code = (deviceShortCode || "DEV1")
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(-4)
        .toUpperCase() || "DEV1";
    const timeSegment = Date.now().toString(36).toUpperCase();
    const randomSegment = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `OFFLINE-${code}-${timeSegment}-${randomSegment}`;
}

/**
 * Pure formatter for standard legal invoice numbers.
 * Example: formatInvoiceNumber("INV", 2026, 42) -> "INV-2026-0042"
 */
export function formatInvoiceNumber(
    prefix = "INV",
    year: number | string = new Date().getFullYear(),
    seq = 1
): string {
    const cleanPrefix = (prefix || "INV").trim().toUpperCase();
    const cleanSeq = Math.max(1, Math.floor(seq)).toString().padStart(4, "0");
    return `${cleanPrefix}-${year}-${cleanSeq}`;
}
