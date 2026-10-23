import { newOperationId } from "@/lib/offline/syncPolicy";

export interface ProductSubmissionRecord {
    operationId: string;
    fingerprint: string;
}

export interface ProductSubmissionFingerprintInput {
    name: string;
    SKU: string;
    barcode?: string;
    categoryId: string;
    unitId: string;
    sellingPrice: number;
    purchasePrice: number;
    taxRate?: number;
    hsnCode?: string;
    openingStock: number;
}

/**
 * Creates a deterministic, normalized fingerprint of the product creation payload.
 * Normalizes trimmed strings, uppercase SKU/barcode, and numeric values so that
 * harmless whitespace or non-semantic changes retain the same identity while genuine
 * edits produce a distinct fingerprint.
 */
export function getProductSubmissionFingerprint(
    input: ProductSubmissionFingerprintInput
): string {
    return JSON.stringify({
        name: input.name.trim(),
        SKU: input.SKU.trim().toUpperCase(),
        barcode: input.barcode && input.barcode.trim() ? input.barcode.trim().toUpperCase() : "",
        categoryId: input.categoryId.trim(),
        unitId: input.unitId.trim(),
        sellingPrice: Number.isFinite(input.sellingPrice) ? input.sellingPrice : 0,
        purchasePrice: Number.isFinite(input.purchasePrice) ? input.purchasePrice : 0,
        taxRate: typeof input.taxRate === "number" && Number.isFinite(input.taxRate) ? input.taxRate : null,
        hsnCode: input.hsnCode && input.hsnCode.trim() ? input.hsnCode.trim() : "",
        openingStock: Number.isFinite(input.openingStock) ? input.openingStock : 0,
    });
}

/**
 * Resolves the operation ID for a product creation attempt based on submission lifecycle:
 * - If lastSubmission exists and the payload fingerprint matches, it is a RETRY of the same
 *   logical submission (e.g. after a timeout or uncertain network error), preserving the operation ID.
 * - If lastSubmission is null or the payload fingerprint differs, it represents a GENUINELY NEW
 *   product submission, generating a fresh unique operation ID.
 */
export function resolveProductOperationId(
    lastSubmission: ProductSubmissionRecord | null,
    currentFingerprint: string,
    generateNewId: () => string = newOperationId
): { operationId: string; isRetry: boolean } {
    if (lastSubmission && lastSubmission.fingerprint === currentFingerprint) {
        return { operationId: lastSubmission.operationId, isRetry: true };
    }
    return { operationId: generateNewId(), isRetry: false };
}
