/*
 * Offline Supplier Cache
 *
 * Implements Phase 3, Stage 1: supplier offline cache and local storage foundation.
 *
 * Responsibilities:
 * 1. Safe mapping from authenticated /api/suppliers responses to local cache records.
 *    Only authorized profile fields are stored; sensitive banking details are strictly excluded.
 * 2. Strict tenant isolation: cached records are partitioned by tenantId.
 *    Cross-tenant queries fail closed and return empty results.
 * 3. Offline supplier creation with temporary local IDs ("sup_...") and temporary codes ("SUP-TEMP-..."),
 *    along with profile-detail edits and stable operation IDs for idempotent sync.
 * 4. Preserving pending and NEEDS_ATTENTION local modifications across cache refreshes.
 * 5. Enforcing policy: lifecycle actions (deactivate, block, reactivate, unblock, delete) remain online-only.
 */

import {
    offlineDB,
    LAST_IDENTITY_KEY,
    type CachedSupplierRecord,
    type OfflineDatabase,
    type SyncQueueItem,
} from "./db";
import type { SessionIdentity } from "./syncPolicy";

export type { CachedSupplierRecord };

export interface SupplierCacheMetadata {
    count: number;
    activeCount: number;
    lastCachedAt: string | null;
}

export interface GetCachedSuppliersOptions {
    includeInactive?: boolean;
    includeBlocked?: boolean;
}

/**
 * Generate a unique compound ID for the Dexie supplier table.
 * Combining tenantId with the supplier ID prevents cross-tenant collisions.
 */
export function makeCachedSupplierId(tenantId: string, rawSupplierId: string): string {
    return `${tenantId}:${rawSupplierId}`;
}

/**
 * Generate a temporary client-side supplier ID (prefixed with "sup_").
 */
export function generateTemporarySupplierId(): string {
    return `sup_${crypto.randomUUID()}`;
}

/**
 * Generate a temporary supplier code formatted as SUP-TEMP-<short-id>.
 * The server will later assign the official sequential supplier code (e.g. SUP-0042) during sync.
 */
export function generateTemporarySupplierCode(): string {
    const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    return `SUP-TEMP-${shortId}`;
}

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

/**
 * Validate whether a string is a valid MongoDB ObjectId (24 hex characters).
 */
export function isValidServerSupplierId(id: string): boolean {
    return typeof id === "string" && OBJECT_ID_REGEX.test(id.trim());
}

/**
 * Validate whether a string is an offline temporary supplier ID (starting with "sup_").
 */
export function isTemporarySupplierId(id: string): boolean {
    return typeof id === "string" && id.trim().startsWith("sup_");
}

/**
 * Validate whether a string is a temporary supplier code (starting with "SUP-TEMP-").
 */
export function isTemporarySupplierCode(code?: string): boolean {
    return typeof code === "string" && code.trim().toUpperCase().startsWith("SUP-TEMP-");
}

/**
 * Normalize phone numbers: trim whitespace and return undefined if empty.
 */
export function normalizeSupplierPhone(phone?: unknown): string | undefined {
    if (typeof phone !== "string") return undefined;
    const trimmed = phone.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize email addresses: trim whitespace, lowercase, and return undefined if empty.
 */
export function normalizeSupplierEmail(email?: unknown): string | undefined {
    if (typeof email !== "string") return undefined;
    const trimmed = email.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize GSTIN: trim, uppercase, return undefined if empty.
 */
export function normalizeSupplierGstin(gstin?: unknown): string | undefined {
    if (typeof gstin !== "string") return undefined;
    const trimmed = gstin.trim().toUpperCase();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize PAN: trim, uppercase, return undefined if empty.
 */
export function normalizeSupplierPan(pan?: unknown): string | undefined {
    if (typeof pan !== "string") return undefined;
    const trimmed = pan.trim().toUpperCase();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize supplier code: trim, uppercase, return undefined if empty.
 */
export function normalizeSupplierCode(code?: unknown): string | undefined {
    if (typeof code !== "string") return undefined;
    const trimmed = code.trim().toUpperCase();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Safely map a supplier object (e.g. from /api/suppliers) to a CachedSupplierRecord.
 *
 * Enforces:
 * 1. Strict tenant boundary defense-in-depth: cross-tenant items are rejected.
 * 2. Exclusion of sensitive banking fields (bankDetails, accountNumber, bankName, ifsc, accountName, upiId).
 * 3. Exclusion of soft-deleted items (isDeleted: true).
 * 4. Normalization of strings, codes, tax identifiers, and credit terms.
 */
export function mapApiSupplierToCacheRecord(
    raw: unknown,
    authorizedTenantId: string,
    cachedAt?: string
): CachedSupplierRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;

    const tenantId = authorizedTenantId.trim();
    if (!tenantId) return null;

    // Defense-in-depth: if supplier object includes tenantId, ensure it matches authorized tenant
    if (s.tenantId !== undefined && s.tenantId !== null) {
        const supplierTenantId = String(s.tenantId).trim();
        if (supplierTenantId && supplierTenantId !== tenantId) {
            return null;
        }
    }

    // Do not cache soft-deleted suppliers
    if (s.isDeleted === true) {
        return null;
    }

    const rawId = String(s._id || s.id || s.supplierId || "").trim();
    if (!rawId) return null;

    const name = String(s.name ?? "").trim();
    if (!name) return null;

    // Contact fields (handle nested contact object or flat properties)
    const contact = (typeof s.contact === "object" && s.contact !== null)
        ? (s.contact as Record<string, unknown>)
        : undefined;

    const contactPerson = String(s.contactPerson ?? contact?.contactPerson ?? "").trim() || undefined;
    const phone = normalizeSupplierPhone(s.phone ?? contact?.phone);
    const altPhone = normalizeSupplierPhone(s.altPhone ?? contact?.altPhone);
    const email = normalizeSupplierEmail(s.email ?? contact?.email);
    const website = String(s.website ?? contact?.website ?? "").trim() || undefined;

    // Address fields (handle nested address object or flat properties)
    const addressObj = (typeof s.address === "object" && s.address !== null)
        ? (s.address as Record<string, unknown>)
        : undefined;
    const addressStr = typeof s.address === "string" && s.address.trim() ? s.address.trim() : undefined;

    const line1 = String(s.line1 ?? addressObj?.line1 ?? addressStr ?? "").trim() || undefined;
    const line2 = String(s.line2 ?? addressObj?.line2 ?? "").trim() || undefined;
    const city = String(s.city ?? addressObj?.city ?? "").trim() || undefined;
    const state = String(s.state ?? addressObj?.state ?? "").trim() || undefined;
    const pincode = String(s.pincode ?? addressObj?.pincode ?? "").trim() || undefined;
    const country = String(s.country ?? addressObj?.country ?? "").trim() || undefined;
    const address = addressStr || line1;

    // Tax fields (handle nested tax object or flat properties)
    const tax = (typeof s.tax === "object" && s.tax !== null)
        ? (s.tax as Record<string, unknown>)
        : undefined;
    const gstin = normalizeSupplierGstin(s.gstin ?? tax?.gstin);
    const pan = normalizeSupplierPan(s.pan ?? tax?.pan);

    // Payment terms (handle nested paymentTerms object or flat properties)
    const paymentTerms = (typeof s.paymentTerms === "object" && s.paymentTerms !== null)
        ? (s.paymentTerms as Record<string, unknown>)
        : undefined;

    const rawPaymentType = s.paymentType ?? paymentTerms?.type;
    const paymentType: "cash" | "credit" | undefined =
        rawPaymentType === "credit" ? "credit" : rawPaymentType === "cash" ? "cash" : undefined;

    const rawCreditDays = s.creditDays ?? paymentTerms?.creditDays;
    const creditDays =
        rawCreditDays !== undefined && rawCreditDays !== null && rawCreditDays !== ""
            ? Math.max(0, Math.floor(Number(rawCreditDays) || 0))
            : undefined;

    const rawCreditLimit = s.creditLimit;
    const creditLimit =
        rawCreditLimit !== undefined && rawCreditLimit !== null && rawCreditLimit !== ""
            ? Math.max(0, Number(rawCreditLimit) || 0)
            : undefined;

    const category = String(s.category ?? "").trim() || undefined;
    const notes = String(s.notes ?? "").trim() || undefined;

    // Status
    let status: "active" | "inactive" | "blocked" = "active";
    if (s.status === "inactive") status = "inactive";
    else if (s.status === "blocked") status = "blocked";
    else if (s.status === "active") status = "active";

    const supplierCode = normalizeSupplierCode(s.supplierCode);

    // Explicitly constructed record: sensitive banking fields (bankDetails, accountNumber, ifsc, etc.)
    // are NOT included.
    return {
        id: makeCachedSupplierId(tenantId, rawId),
        supplierId: rawId,
        tenantId,
        ...(supplierCode ? { supplierCode } : {}),
        name,
        ...(contactPerson ? { contactPerson } : {}),
        ...(phone ? { phone } : {}),
        ...(altPhone ? { altPhone } : {}),
        ...(email ? { email } : {}),
        ...(website ? { website } : {}),
        ...(address ? { address } : {}),
        ...(line1 ? { line1 } : {}),
        ...(line2 ? { line2 } : {}),
        ...(city ? { city } : {}),
        ...(state ? { state } : {}),
        ...(pincode ? { pincode } : {}),
        ...(country ? { country } : {}),
        ...(gstin ? { gstin } : {}),
        ...(pan ? { pan } : {}),
        ...(paymentType ? { paymentType } : {}),
        ...(creditDays !== undefined ? { creditDays } : {}),
        ...(creditLimit !== undefined ? { creditLimit } : {}),
        ...(category ? { category } : {}),
        ...(notes ? { notes } : {}),
        status,
        cachedAt: cachedAt || new Date().toISOString(),
        syncStatus: "SYNCED",
    };
}

/**
 * Persist an array of suppliers fetched from /api/suppliers into IndexedDB.
 * Preserves pending offline records so local creations and updates are never overwritten by server fetches.
 */
export async function saveCachedSuppliers(
    suppliers: unknown[],
    authorizedTenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = authorizedTenantId.trim();
    if (!cleanTenantId || !Array.isArray(suppliers)) return 0;

    const nowIso = new Date().toISOString();
    const mappedRecords: CachedSupplierRecord[] = [];

    for (const item of suppliers) {
        const record = mapApiSupplierToCacheRecord(item, cleanTenantId, nowIso);
        if (record) {
            mappedRecords.push(record);
        }
    }

    return await db.transaction("rw", db.cachedSuppliers, async () => {
        // Collect existing pending or needs_attention offline records to preserve them
        const existingRecords = await db.cachedSuppliers
            .where("tenantId")
            .equals(cleanTenantId)
            .toArray();

        const preservedKeys = new Set<string>();
        for (const existing of existingRecords) {
            if (existing.syncStatus === "PENDING" || existing.syncStatus === "NEEDS_ATTENTION") {
                preservedKeys.add(existing.id);
            }
        }

        // Put mapped records without overwriting local pending items
        let savedCount = 0;
        for (const record of mappedRecords) {
            if (!preservedKeys.has(record.id)) {
                await db.cachedSuppliers.put(record);
                savedCount++;
            }
        }

        return savedCount;
    });
}

/**
 * Retrieve cached suppliers for the active tenant, strictly isolated by tenantId.
 */
export async function getCachedSuppliersForTenant(
    tenantId: string,
    options: GetCachedSuppliersOptions = {},
    db: OfflineDatabase = offlineDB
): Promise<CachedSupplierRecord[]> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) return [];

    const records = await db.cachedSuppliers
        .where("tenantId")
        .equals(cleanTenantId)
        .toArray();

    const filtered = records.filter((r) => {
        if (r.status === "active") return true;
        if (r.status === "inactive" && options.includeInactive) return true;
        if (r.status === "blocked" && options.includeBlocked) return true;
        return false;
    });

    return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search cached suppliers by query string across name, code, phone, email, GSTIN, and contact person.
 */
export async function searchCachedSuppliers(
    query: string,
    tenantId: string,
    options: GetCachedSuppliersOptions = {},
    db: OfflineDatabase = offlineDB
): Promise<CachedSupplierRecord[]> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) return [];

    const cleanQuery = query.trim().toLowerCase();
    const records = await getCachedSuppliersForTenant(cleanTenantId, options, db);

    if (!cleanQuery) return records;

    return records.filter((sup) => {
        const matchesName = sup.name.toLowerCase().includes(cleanQuery);
        const matchesCode = sup.supplierCode ? sup.supplierCode.toLowerCase().includes(cleanQuery) : false;
        const matchesPhone = sup.phone ? sup.phone.includes(cleanQuery) : false;
        const matchesEmail = sup.email ? sup.email.toLowerCase().includes(cleanQuery) : false;
        const matchesGstin = sup.gstin ? sup.gstin.toLowerCase().includes(cleanQuery) : false;
        const matchesContactPerson = sup.contactPerson ? sup.contactPerson.toLowerCase().includes(cleanQuery) : false;

        return matchesName || matchesCode || matchesPhone || matchesEmail || matchesGstin || matchesContactPerson;
    });
}

/**
 * Retrieve a cached supplier by ID for the active tenant.
 */
export async function getCachedSupplierById(
    supplierId: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<CachedSupplierRecord | null> {
    const cleanTenantId = tenantId.trim();
    const cleanSupplierId = supplierId.trim();
    if (!cleanTenantId || !cleanSupplierId) return null;

    const key = makeCachedSupplierId(cleanTenantId, cleanSupplierId);
    const record = await db.cachedSuppliers.get(key);
    if (!record) return null;

    if (record.tenantId !== cleanTenantId) return null;

    return record;
}

/**
 * Retrieve a cached supplier by supplierCode for the active tenant.
 */
export async function getCachedSupplierByCode(
    supplierCode: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<CachedSupplierRecord | null> {
    const cleanTenantId = tenantId.trim();
    const cleanCode = supplierCode.trim().toUpperCase();
    if (!cleanTenantId || !cleanCode) return null;

    const records = await db.cachedSuppliers
        .where("tenantId")
        .equals(cleanTenantId)
        .toArray();

    const record = records.find(
        (r) => r.supplierCode && r.supplierCode.toUpperCase() === cleanCode
    );

    return record || null;
}

/**
 * Retrieve metadata about the tenant's cached suppliers.
 */
export async function getCachedSupplierMetadata(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<SupplierCacheMetadata> {
    const records = await getCachedSuppliersForTenant(tenantId, { includeInactive: true, includeBlocked: true }, db);
    if (records.length === 0) {
        return { count: 0, activeCount: 0, lastCachedAt: null };
    }

    const activeCount = records.filter((r) => r.status === "active").length;
    const lastCachedAt = records[0]?.cachedAt ?? null;

    return {
        count: records.length,
        activeCount,
        lastCachedAt,
    };
}

/**
 * Save a locally created supplier into cachedSuppliers with PENDING status.
 * Assigns a temporary local ID ("sup_...") and temporary supplier code ("SUP-TEMP-...").
 * Enqueues a durable "CREATE" operation in syncQueue with session ownership.
 */
export async function savePendingOfflineSupplier(
    supplierData: {
        name: string;
        supplierCode?: string;
        contactPerson?: string;
        phone?: string;
        altPhone?: string;
        email?: string;
        website?: string;
        address?: string;
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        pincode?: string;
        country?: string;
        gstin?: string;
        pan?: string;
        paymentType?: "cash" | "credit";
        creditDays?: number;
        creditLimit?: number;
        category?: string;
        notes?: string;
    },
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    operationId?: string,
    localId?: string
): Promise<{ supplier: CachedSupplierRecord; operationId: string }> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) {
        throw new Error("Tenant ID is required to save an offline supplier");
    }

    const cleanName = supplierData.name.trim();
    if (!cleanName) {
        throw new Error("Supplier name is required");
    }

    const assignedLocalId = localId || generateTemporarySupplierId();
    const assignedOpId = operationId || crypto.randomUUID();
    const tempCode = supplierData.supplierCode && isTemporarySupplierCode(supplierData.supplierCode)
        ? supplierData.supplierCode.toUpperCase()
        : generateTemporarySupplierCode();

    const nowIso = new Date().toISOString();

    const record: CachedSupplierRecord = {
        id: makeCachedSupplierId(cleanTenantId, assignedLocalId),
        supplierId: assignedLocalId,
        tenantId: cleanTenantId,
        supplierCode: tempCode,
        name: cleanName,
        contactPerson: supplierData.contactPerson?.trim() || undefined,
        phone: normalizeSupplierPhone(supplierData.phone),
        altPhone: normalizeSupplierPhone(supplierData.altPhone),
        email: normalizeSupplierEmail(supplierData.email),
        website: supplierData.website?.trim() || undefined,
        address: supplierData.address?.trim() || supplierData.line1?.trim() || undefined,
        line1: supplierData.line1?.trim() || supplierData.address?.trim() || undefined,
        line2: supplierData.line2?.trim() || undefined,
        city: supplierData.city?.trim() || undefined,
        state: supplierData.state?.trim() || undefined,
        pincode: supplierData.pincode?.trim() || undefined,
        country: supplierData.country?.trim() || undefined,
        gstin: normalizeSupplierGstin(supplierData.gstin),
        pan: normalizeSupplierPan(supplierData.pan),
        paymentType: supplierData.paymentType === "credit" ? "credit" : supplierData.paymentType === "cash" ? "cash" : undefined,
        creditDays: supplierData.creditDays !== undefined ? Math.max(0, Math.floor(supplierData.creditDays)) : undefined,
        creditLimit: supplierData.creditLimit !== undefined ? Math.max(0, supplierData.creditLimit) : undefined,
        category: supplierData.category?.trim() || undefined,
        notes: supplierData.notes?.trim() || undefined,
        status: "active",
        cachedAt: nowIso,
        syncStatus: "PENDING",
        operationId: assignedOpId,
    };

    await db.cachedSuppliers.put(record);

    try {
        if (db.syncQueue) {
            const queueWhere = db.syncQueue.where("operationId").equals(assignedOpId);
            const existingQueueItem = typeof (queueWhere as any).first === "function"
                ? await (queueWhere as any).first()
                : (await queueWhere.toArray())[0];

            if (!existingQueueItem) {
                let owner: SessionIdentity | undefined;
                if (db.meta?.get) {
                    const remembered = await db.meta.get(LAST_IDENTITY_KEY);
                    if (remembered?.value && typeof remembered.value === "object") {
                        owner = remembered.value as SessionIdentity;
                    }
                }
                if (!owner && cleanTenantId) {
                    owner = { tenantId: cleanTenantId, userId: "", deviceId: "" };
                }

                await db.syncQueue.add({
                    operationId: assignedOpId,
                    operationType: "CREATE",
                    entityType: "Supplier",
                    payload: {
                        localId: assignedLocalId,
                        supplierCode: tempCode,
                        name: cleanName,
                        ...(record.contactPerson ? { contactPerson: record.contactPerson } : {}),
                        ...(record.phone ? { phone: record.phone } : {}),
                        ...(record.altPhone ? { altPhone: record.altPhone } : {}),
                        ...(record.email ? { email: record.email } : {}),
                        ...(record.website ? { website: record.website } : {}),
                        ...(record.address ? { address: record.address } : {}),
                        ...(record.line1 ? { line1: record.line1 } : {}),
                        ...(record.line2 ? { line2: record.line2 } : {}),
                        ...(record.city ? { city: record.city } : {}),
                        ...(record.state ? { state: record.state } : {}),
                        ...(record.pincode ? { pincode: record.pincode } : {}),
                        ...(record.country ? { country: record.country } : {}),
                        ...(record.gstin ? { gstin: record.gstin } : {}),
                        ...(record.pan ? { pan: record.pan } : {}),
                        ...(record.paymentType ? { paymentType: record.paymentType } : {}),
                        ...(record.creditDays !== undefined ? { creditDays: record.creditDays } : {}),
                        ...(record.creditLimit !== undefined ? { creditLimit: record.creditLimit } : {}),
                        ...(record.category ? { category: record.category } : {}),
                        ...(record.notes ? { notes: record.notes } : {}),
                        status: "active",
                    },
                    localSeq: Date.now(),
                    status: "PENDING",
                    attempts: 0,
                    createdAt: nowIso,
                    nextAttemptAt: nowIso,
                    owner,
                    ownerUserId: owner?.userId,
                });
            }
        }
    } catch (queueErr) {
        console.warn("Could not enqueue supplier creation to syncQueue:", queueErr);
    }

    return {
        supplier: record,
        operationId: assignedOpId,
    };
}

/**
 * Save an offline update to an existing cached supplier with PENDING status.
 *
 * Approved policy:
 * - Offline profile-detail edits are allowed.
 * - Deactivate, block, reactivate, unblock, and delete remain online-only.
 * If status modification is attempted, this function rejects with an explicit error.
 */
export async function savePendingOfflineSupplierUpdate(
    supplierData: {
        supplierId: string;
        name: string;
        contactPerson?: string;
        phone?: string;
        altPhone?: string;
        email?: string;
        website?: string;
        address?: string;
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        pincode?: string;
        country?: string;
        gstin?: string;
        pan?: string;
        paymentType?: "cash" | "credit";
        creditDays?: number;
        creditLimit?: number;
        category?: string;
        notes?: string;
        status?: "active" | "inactive" | "blocked";
    },
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    operationId?: string,
    fallbackOwner?: SessionIdentity
): Promise<CachedSupplierRecord> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) {
        throw new Error("Tenant ID is required to update an offline supplier");
    }

    const cleanSupplierId = supplierData.supplierId?.trim();
    if (!cleanSupplierId) {
        throw new Error("Supplier ID is required");
    }

    const cleanName = supplierData.name.trim();
    if (!cleanName) {
        throw new Error("Supplier name is required");
    }

    const isTempId = isTemporarySupplierId(cleanSupplierId);
    const isValidServerId = isValidServerSupplierId(cleanSupplierId);

    if (!isTempId && !isValidServerId) {
        throw new Error(`Ambiguous supplier ID format: "${cleanSupplierId}". Cannot determine if supplier is local temporary or server record.`);
    }

    const key = makeCachedSupplierId(cleanTenantId, cleanSupplierId);
    const existing = await db.cachedSuppliers.get(key);

    // Enforce online-only policy for lifecycle actions
    if (supplierData.status !== undefined && existing && supplierData.status !== existing.status) {
        throw new Error("Supplier lifecycle actions (deactivate, block, reactivate, unblock) are online-only.");
    }

    const nowIso = new Date().toISOString();

    let allQueueItems: SyncQueueItem[] = [];
    if (db.syncQueue) {
        try {
            allQueueItems = await db.syncQueue.toArray();
        } catch {}
    }

    // Look for existing queue items for this supplier
    let existingQueueItem: SyncQueueItem | undefined;
    if (isTempId) {
        existingQueueItem = allQueueItems.find((q) => {
            if (q.entityType !== "Supplier") return false;
            if (q.status !== "PENDING" && q.status !== "FAILED" && q.status !== "NEEDS_ATTENTION") return false;
            return q.payload?.localId === cleanSupplierId || (existing?.operationId ? q.operationId === existing.operationId : false);
        });
    } else if (isValidServerId) {
        existingQueueItem = allQueueItems.find((q) => {
            if (q.entityType !== "Supplier") return false;
            if (q.operationType !== "UPDATE") return false;
            if (q.status !== "PENDING" && q.status !== "FAILED" && q.status !== "NEEDS_ATTENTION") return false;
            return q.payload?.supplierId === cleanSupplierId || (existing?.operationId ? q.operationId === existing.operationId : false);
        });
    }

    const isCachedOpIdFromCreate = Boolean(
        existing?.operationId &&
        allQueueItems.some(
            (q) =>
                q.entityType === "Supplier" &&
                q.operationType === "CREATE" &&
                (q.operationId === existing.operationId ||
                    q.payload?.supplierId === cleanSupplierId ||
                    q.payload?.localId === cleanSupplierId)
        )
    );

    let assignedOpId: string;
    if (operationId) {
        assignedOpId = operationId;
    } else if (existingQueueItem) {
        assignedOpId = existingQueueItem.operationId;
    } else if (isValidServerId && isCachedOpIdFromCreate) {
        assignedOpId = crypto.randomUUID();
    } else {
        assignedOpId = existing?.operationId || crypto.randomUUID();
    }

    const record: CachedSupplierRecord = {
        id: key,
        supplierId: cleanSupplierId,
        tenantId: cleanTenantId,
        supplierCode: existing?.supplierCode,
        name: cleanName,
        contactPerson: supplierData.contactPerson !== undefined
            ? (supplierData.contactPerson.trim() || undefined)
            : existing?.contactPerson,
        phone: supplierData.phone !== undefined
            ? normalizeSupplierPhone(supplierData.phone)
            : existing?.phone,
        altPhone: supplierData.altPhone !== undefined
            ? normalizeSupplierPhone(supplierData.altPhone)
            : existing?.altPhone,
        email: supplierData.email !== undefined
            ? normalizeSupplierEmail(supplierData.email)
            : existing?.email,
        website: supplierData.website !== undefined
            ? (supplierData.website.trim() || undefined)
            : existing?.website,
        address: supplierData.address !== undefined
            ? (supplierData.address.trim() || undefined)
            : existing?.address,
        line1: supplierData.line1 !== undefined
            ? (supplierData.line1.trim() || undefined)
            : existing?.line1,
        line2: supplierData.line2 !== undefined
            ? (supplierData.line2.trim() || undefined)
            : existing?.line2,
        city: supplierData.city !== undefined
            ? (supplierData.city.trim() || undefined)
            : existing?.city,
        state: supplierData.state !== undefined
            ? (supplierData.state.trim() || undefined)
            : existing?.state,
        pincode: supplierData.pincode !== undefined
            ? (supplierData.pincode.trim() || undefined)
            : existing?.pincode,
        country: supplierData.country !== undefined
            ? (supplierData.country.trim() || undefined)
            : existing?.country,
        gstin: supplierData.gstin !== undefined
            ? normalizeSupplierGstin(supplierData.gstin)
            : existing?.gstin,
        pan: supplierData.pan !== undefined
            ? normalizeSupplierPan(supplierData.pan)
            : existing?.pan,
        paymentType: supplierData.paymentType !== undefined
            ? supplierData.paymentType
            : existing?.paymentType,
        creditDays: supplierData.creditDays !== undefined
            ? Math.max(0, Math.floor(supplierData.creditDays))
            : existing?.creditDays,
        creditLimit: supplierData.creditLimit !== undefined
            ? Math.max(0, supplierData.creditLimit)
            : existing?.creditLimit,
        category: supplierData.category !== undefined
            ? (supplierData.category.trim() || undefined)
            : existing?.category,
        notes: supplierData.notes !== undefined
            ? (supplierData.notes.trim() || undefined)
            : existing?.notes,
        status: existing?.status || "active",
        cachedAt: nowIso,
        syncStatus: "PENDING",
        operationId: assignedOpId,
        errorMessage: undefined,
    };

    await db.cachedSuppliers.put(record);

    if (db.syncQueue) {
        try {
            if (existingQueueItem && existingQueueItem.id !== undefined) {
                const isCreateOp = existingQueueItem.operationType === "CREATE" || isTempId;
                const basePayload = { ...existingQueueItem.payload };
                if (!isCreateOp) {
                    delete (basePayload as any).status;
                }
                await db.syncQueue.update(existingQueueItem.id, {
                    payload: {
                        ...basePayload,
                        ...(isTempId ? { localId: cleanSupplierId } : { supplierId: cleanSupplierId }),
                        name: cleanName,
                        contactPerson: record.contactPerson,
                        phone: record.phone,
                        altPhone: record.altPhone,
                        email: record.email,
                        website: record.website,
                        address: record.address,
                        line1: record.line1,
                        line2: record.line2,
                        city: record.city,
                        state: record.state,
                        pincode: record.pincode,
                        country: record.country,
                        gstin: record.gstin,
                        pan: record.pan,
                        paymentType: record.paymentType,
                        creditDays: record.creditDays,
                        creditLimit: record.creditLimit,
                        category: record.category,
                        notes: record.notes,
                        ...(isCreateOp ? { status: record.status } : {}),
                    },
                    operationId: assignedOpId,
                    status: "PENDING",
                    errorMessage: undefined,
                });
            } else if (isValidServerId) {
                let owner: SessionIdentity | undefined = fallbackOwner;
                if (!owner && db.meta?.get) {
                    const remembered = await db.meta.get(LAST_IDENTITY_KEY);
                    if (remembered?.value && typeof remembered.value === "object") {
                        owner = remembered.value as SessionIdentity;
                    }
                }
                if (!owner && cleanTenantId) {
                    owner = { tenantId: cleanTenantId, userId: "", deviceId: "" };
                }

                await db.syncQueue.add({
                    operationId: assignedOpId,
                    operationType: "UPDATE",
                    entityType: "Supplier",
                    payload: {
                        supplierId: cleanSupplierId,
                        name: cleanName,
                        ...(record.contactPerson ? { contactPerson: record.contactPerson } : {}),
                        ...(record.phone ? { phone: record.phone } : {}),
                        ...(record.altPhone ? { altPhone: record.altPhone } : {}),
                        ...(record.email ? { email: record.email } : {}),
                        ...(record.website ? { website: record.website } : {}),
                        ...(record.address ? { address: record.address } : {}),
                        ...(record.line1 ? { line1: record.line1 } : {}),
                        ...(record.line2 ? { line2: record.line2 } : {}),
                        ...(record.city ? { city: record.city } : {}),
                        ...(record.state ? { state: record.state } : {}),
                        ...(record.pincode ? { pincode: record.pincode } : {}),
                        ...(record.country ? { country: record.country } : {}),
                        ...(record.gstin ? { gstin: record.gstin } : {}),
                        ...(record.pan ? { pan: record.pan } : {}),
                        ...(record.paymentType ? { paymentType: record.paymentType } : {}),
                        ...(record.creditDays !== undefined ? { creditDays: record.creditDays } : {}),
                        ...(record.creditLimit !== undefined ? { creditLimit: record.creditLimit } : {}),
                        ...(record.category ? { category: record.category } : {}),
                        ...(record.notes ? { notes: record.notes } : {}),
                    },
                    localSeq: Date.now(),
                    status: "PENDING",
                    attempts: 0,
                    createdAt: nowIso,
                    nextAttemptAt: nowIso,
                    owner,
                    ownerUserId: owner?.userId,
                });
            } else if (isTempId) {
                let owner: SessionIdentity | undefined = fallbackOwner;
                if (!owner && db.meta?.get) {
                    const remembered = await db.meta.get(LAST_IDENTITY_KEY);
                    if (remembered?.value && typeof remembered.value === "object") {
                        owner = remembered.value as SessionIdentity;
                    }
                }
                if (!owner && cleanTenantId) {
                    owner = { tenantId: cleanTenantId, userId: "", deviceId: "" };
                }

                await db.syncQueue.add({
                    operationId: assignedOpId,
                    operationType: "CREATE",
                    entityType: "Supplier",
                    payload: {
                        localId: cleanSupplierId,
                        supplierCode: record.supplierCode,
                        name: cleanName,
                        ...(record.contactPerson ? { contactPerson: record.contactPerson } : {}),
                        ...(record.phone ? { phone: record.phone } : {}),
                        ...(record.altPhone ? { altPhone: record.altPhone } : {}),
                        ...(record.email ? { email: record.email } : {}),
                        ...(record.website ? { website: record.website } : {}),
                        ...(record.address ? { address: record.address } : {}),
                        ...(record.line1 ? { line1: record.line1 } : {}),
                        ...(record.line2 ? { line2: record.line2 } : {}),
                        ...(record.city ? { city: record.city } : {}),
                        ...(record.state ? { state: record.state } : {}),
                        ...(record.pincode ? { pincode: record.pincode } : {}),
                        ...(record.country ? { country: record.country } : {}),
                        ...(record.gstin ? { gstin: record.gstin } : {}),
                        ...(record.pan ? { pan: record.pan } : {}),
                        ...(record.paymentType ? { paymentType: record.paymentType } : {}),
                        ...(record.creditDays !== undefined ? { creditDays: record.creditDays } : {}),
                        ...(record.creditLimit !== undefined ? { creditLimit: record.creditLimit } : {}),
                        ...(record.category ? { category: record.category } : {}),
                        ...(record.notes ? { notes: record.notes } : {}),
                        status: record.status,
                    },
                    localSeq: Date.now(),
                    status: "PENDING",
                    attempts: 0,
                    createdAt: nowIso,
                    nextAttemptAt: nowIso,
                    owner,
                    ownerUserId: owner?.userId,
                });
            }
        } catch (queueErr) {
            console.warn("Could not enqueue or update supplier in syncQueue:", queueErr);
        }
    }

    return record;
}

/**
 * Scan cached suppliers for any pending records that have not yet been queued in syncQueue,
 * and enqueue them so that reconnecting or SyncManager will process them.
 * This heals any orphaned pending suppliers created or updated offline.
 */
export async function ensurePendingSuppliersQueued(
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    fallbackOwner?: SessionIdentity
): Promise<number> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId || !db.cachedSuppliers || !db.syncQueue) return 0;

    const pendingSuppliers = await db.cachedSuppliers
        .where("tenantId")
        .equals(cleanTenantId)
        .toArray();

    const pendingOnly = pendingSuppliers.filter((s) => s.syncStatus === "PENDING");
    if (pendingOnly.length === 0) return 0;

    let queuedCount = 0;
    let owner: SessionIdentity | undefined = fallbackOwner;
    if (!owner && db.meta?.get) {
        const remembered = await db.meta.get(LAST_IDENTITY_KEY);
        if (remembered?.value && typeof remembered.value === "object") {
            owner = remembered.value as SessionIdentity;
        }
    }
    if (!owner && cleanTenantId) {
        owner = { tenantId: cleanTenantId, userId: "", deviceId: "" };
    }

    const allQueueItems = await db.syncQueue.toArray();
    const existingQueueByOpId = new Map(allQueueItems.map((q) => [q.operationId, q]));

    for (const sup of pendingOnly) {
        const isTempId = isTemporarySupplierId(sup.supplierId);
        const isValidServerId = isValidServerSupplierId(sup.supplierId);

        if (!isTempId && !isValidServerId) {
            console.warn(`[ensurePendingSuppliersQueued] Skipping ambiguous supplier ID: "${sup.supplierId}". Data preserved in cache.`);
            continue;
        }

        const isOpIdFromCreate = Boolean(
            sup.operationId &&
            allQueueItems.some(
                (q) =>
                    q.entityType === "Supplier" &&
                    q.operationType === "CREATE" &&
                    q.operationId === sup.operationId
            )
        );

        const opId = (sup.operationId && (!isValidServerId || !isOpIdFromCreate))
            ? sup.operationId
            : crypto.randomUUID();

        let existingItem = existingQueueByOpId.get(opId);
        if (existingItem && isValidServerId && existingItem.operationType === "CREATE") {
            existingItem = undefined;
        }

        if (!existingItem) {
            existingItem = allQueueItems.find((q) => {
                if (q.entityType !== "Supplier") return false;
                if (q.status !== "PENDING" && q.status !== "FAILED") return false;
                if (isTempId) return q.payload?.localId === sup.supplierId;
                return q.operationType === "UPDATE" && q.payload?.supplierId === sup.supplierId;
            });
            if (existingItem && sup.operationId !== existingItem.operationId) {
                await db.cachedSuppliers.update(sup.id, { operationId: existingItem.operationId });
            }
        }

        if (existingItem && existingItem.id !== undefined && existingItem.operationType === "UPDATE" && existingItem.payload) {
            if ("status" in existingItem.payload) {
                const { status: _omittedStatus, ...cleanPayload } = existingItem.payload as Record<string, unknown>;
                await db.syncQueue.update(existingItem.id, { payload: cleanPayload });
                existingItem.payload = cleanPayload;
            }
        }

        if (!existingItem) {
            const nowIso = new Date().toISOString();
            const operationType = isTempId ? "CREATE" : "UPDATE";
            const payload = isTempId
                ? {
                    localId: sup.supplierId,
                    supplierCode: sup.supplierCode,
                    name: sup.name,
                    ...(sup.contactPerson ? { contactPerson: sup.contactPerson } : {}),
                    ...(sup.phone ? { phone: sup.phone } : {}),
                    ...(sup.altPhone ? { altPhone: sup.altPhone } : {}),
                    ...(sup.email ? { email: sup.email } : {}),
                    ...(sup.website ? { website: sup.website } : {}),
                    ...(sup.address ? { address: sup.address } : {}),
                    ...(sup.line1 ? { line1: sup.line1 } : {}),
                    ...(sup.line2 ? { line2: sup.line2 } : {}),
                    ...(sup.city ? { city: sup.city } : {}),
                    ...(sup.state ? { state: sup.state } : {}),
                    ...(sup.pincode ? { pincode: sup.pincode } : {}),
                    ...(sup.country ? { country: sup.country } : {}),
                    ...(sup.gstin ? { gstin: sup.gstin } : {}),
                    ...(sup.pan ? { pan: sup.pan } : {}),
                    ...(sup.paymentType ? { paymentType: sup.paymentType } : {}),
                    ...(sup.creditDays !== undefined ? { creditDays: sup.creditDays } : {}),
                    ...(sup.creditLimit !== undefined ? { creditLimit: sup.creditLimit } : {}),
                    ...(sup.category ? { category: sup.category } : {}),
                    ...(sup.notes ? { notes: sup.notes } : {}),
                    status: sup.status,
                }
                : {
                    supplierId: sup.supplierId,
                    name: sup.name,
                    ...(sup.contactPerson ? { contactPerson: sup.contactPerson } : {}),
                    ...(sup.phone ? { phone: sup.phone } : {}),
                    ...(sup.altPhone ? { altPhone: sup.altPhone } : {}),
                    ...(sup.email ? { email: sup.email } : {}),
                    ...(sup.website ? { website: sup.website } : {}),
                    ...(sup.address ? { address: sup.address } : {}),
                    ...(sup.line1 ? { line1: sup.line1 } : {}),
                    ...(sup.line2 ? { line2: sup.line2 } : {}),
                    ...(sup.city ? { city: sup.city } : {}),
                    ...(sup.state ? { state: sup.state } : {}),
                    ...(sup.pincode ? { pincode: sup.pincode } : {}),
                    ...(sup.country ? { country: sup.country } : {}),
                    ...(sup.gstin ? { gstin: sup.gstin } : {}),
                    ...(sup.pan ? { pan: sup.pan } : {}),
                    ...(sup.paymentType ? { paymentType: sup.paymentType } : {}),
                    ...(sup.creditDays !== undefined ? { creditDays: sup.creditDays } : {}),
                    ...(sup.creditLimit !== undefined ? { creditLimit: sup.creditLimit } : {}),
                    ...(sup.category ? { category: sup.category } : {}),
                    ...(sup.notes ? { notes: sup.notes } : {}),
                };

            await db.syncQueue.add({
                operationId: opId,
                operationType,
                entityType: "Supplier",
                payload,
                localSeq: Date.now(),
                status: "PENDING",
                attempts: 0,
                createdAt: sup.cachedAt || nowIso,
                nextAttemptAt: nowIso,
                owner,
                ownerUserId: owner?.userId,
            });
            queuedCount++;

            if (sup.operationId !== opId) {
                await db.cachedSuppliers.update(sup.id, { operationId: opId });
            }
        } else if (owner && (!existingItem.ownerUserId || !existingItem.owner)) {
            if (existingItem.id !== undefined && typeof db.syncQueue.update === "function") {
                await db.syncQueue.update(existingItem.id, {
                    owner,
                    ownerUserId: owner.userId,
                });
                queuedCount++;
            }
        }
    }

    return queuedCount;
}


export interface ResolvePendingSupplierResult {
    resolved: boolean;
    dependentPurchasesUpdated: number;
    newKey?: string;
}

/**
 * Resolve a temporary client supplier ID to the permanent server MongoDB ObjectId
 * and reconcile official sequential supplier code.
 *
 * Enforces:
 * 1. Re-keying cached record from tenant:localId to tenant:serverId.
 * 2. Assigning the official server-assigned sequential supplier code.
 * 3. Preserving pending local edits if a newer edit occurred while CREATE was in flight.
 * 4. Preserving tenant ownership and multi-tenant isolation.
 * 5. Rewriting dependent queued purchase operations (payload.supplierId) and cleaning dependsOn.
 * 6. Preserving historical purchase snapshots and already-synced records.
 */
export async function resolvePendingSupplierId(
    localId: string,
    serverId: string,
    serverSupplierCode: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    completedOperationId?: string
): Promise<ResolvePendingSupplierResult> {
    const cleanTenantId = tenantId.trim();
    const cleanLocalId = localId.trim();
    const cleanServerId = serverId.trim();
    const cleanCode = serverSupplierCode.trim();

    if (!cleanTenantId || !cleanLocalId || !cleanServerId) {
        return { resolved: false, dependentPurchasesUpdated: 0 };
    }

    const tables = db.cachedPurchases
        ? [db.cachedSuppliers, db.syncQueue, db.cachedPurchases]
        : [db.cachedSuppliers, db.syncQueue];

    return await db.transaction("rw", tables, async () => {
        // 1. Update cachedSuppliers table
        const oldKey = makeCachedSupplierId(cleanTenantId, cleanLocalId);
        const existingRecord = await db.cachedSuppliers.get(oldKey);

        const newKey = makeCachedSupplierId(cleanTenantId, cleanServerId);
        let resolved = false;

        if (existingRecord && existingRecord.tenantId === cleanTenantId) {
            await db.cachedSuppliers.delete(oldKey);

            // Stale response / pending local edit protection:
            // If the user made a newer edit to this supplier while CREATE was in-flight,
            // existingRecord.operationId will differ from completedOperationId.
            const isNewerLocalEdit =
                existingRecord.syncStatus === "PENDING" &&
                Boolean(completedOperationId && existingRecord.operationId && existingRecord.operationId !== completedOperationId);

            // Check if there's already a record at newKey (e.g. from an earlier server fetch or race)
            const targetExisting = await db.cachedSuppliers.get(newKey);

            const updatedRecord: CachedSupplierRecord = {
                ...(targetExisting || existingRecord),
                id: newKey,
                supplierId: cleanServerId,
                tenantId: cleanTenantId,
                supplierCode: cleanCode || existingRecord.supplierCode || targetExisting?.supplierCode || "",
                syncStatus: isNewerLocalEdit ? "PENDING" : "SYNCED",
                operationId: isNewerLocalEdit ? existingRecord.operationId : undefined,
                errorMessage: isNewerLocalEdit ? existingRecord.errorMessage : undefined,
                cachedAt: new Date().toISOString(),
            };

            await db.cachedSuppliers.put(updatedRecord);
            resolved = true;
        } else {
            // If the record was already at newKey, check if it needs code or status update
            const targetExisting = await db.cachedSuppliers.get(newKey);
            if (targetExisting && targetExisting.tenantId === cleanTenantId) {
                if (cleanCode && targetExisting.supplierCode !== cleanCode) {
                    await db.cachedSuppliers.update(newKey, {
                        supplierCode: cleanCode,
                        syncStatus: "SYNCED",
                        errorMessage: undefined,
                        cachedAt: new Date().toISOString(),
                    });
                }
                resolved = true;
            }
        }

        // 2. Scan syncQueue for dependent purchases (or payments/updates) referencing local supplier ID
        let dependentPurchasesUpdated = 0;
        const allQueueItems = await db.syncQueue.toArray();

        for (const item of allQueueItems) {
            if (item.id === undefined || item.status === "SYNCED") continue;

            // Strict tenant isolation check: do not touch records belonging to other tenants
            const itemTenant = item.owner?.tenantId || (item.payload as Record<string, unknown>)?.tenantId;
            if (itemTenant && String(itemTenant).trim() !== cleanTenantId) continue;

            let modified = false;
            const payload = item.payload ? { ...item.payload } : {};

            // Check if item depends on the completed supplier create operation
            let newDependsOn = item.dependsOn;
            const targetOpId = completedOperationId || existingRecord?.operationId;
            if (targetOpId && newDependsOn && newDependsOn.includes(targetOpId)) {
                newDependsOn = newDependsOn.filter((opId) => opId !== targetOpId);
                modified = true;
            }

            // Check Purchases referencing local supplier ID
            if (item.entityType === "Purchase") {
                if (payload.supplierId === cleanLocalId) {
                    payload.supplierId = cleanServerId;
                    if (cleanCode) {
                        if (
                            payload.supplierCode &&
                            (isTemporarySupplierCode(String(payload.supplierCode)) ||
                                payload.supplierCode === existingRecord?.supplierCode)
                        ) {
                            payload.supplierCode = cleanCode;
                        }
                        if (payload.supplierSnapshot && typeof payload.supplierSnapshot === "object") {
                            payload.supplierSnapshot = {
                                ...(payload.supplierSnapshot as Record<string, unknown>),
                                supplierCode: cleanCode,
                            };
                        }
                    }
                    modified = true;
                    dependentPurchasesUpdated++;
                }
            }

            // Check Payments referencing local supplier ID
            if (item.entityType === "Payment") {
                if (payload.supplierId === cleanLocalId) {
                    payload.supplierId = cleanServerId;
                    modified = true;
                }
            }

            // Check queued Supplier UPDATEs referencing local supplier ID
            if (item.entityType === "Supplier" && item.operationType === "UPDATE") {
                if (payload.supplierId === cleanLocalId || (payload as Record<string, unknown>).localId === cleanLocalId) {
                    payload.supplierId = cleanServerId;
                    delete (payload as Record<string, unknown>).localId;
                    modified = true;
                }
            }

            if (modified) {
                await db.syncQueue.update(item.id, {
                    payload,
                    dependsOn: newDependsOn && newDependsOn.length > 0 ? newDependsOn : undefined,
                });
            }
        }

        // 3. Scan cachedPurchases for records referencing local supplier ID (scoped strictly to active tenant)
        if (db.cachedPurchases) {
            const tenantPurchases = await db.cachedPurchases
                .where("tenantId")
                .equals(cleanTenantId)
                .toArray();

            for (const purchase of tenantPurchases) {
                if (purchase.supplierId === cleanLocalId) {
                    await db.cachedPurchases.update(purchase.id, {
                        supplierId: cleanServerId,
                        ...(cleanCode ? { supplierCode: cleanCode } : {}),
                    });
                }
            }
        }

        return { resolved: resolved || dependentPurchasesUpdated > 0, dependentPurchasesUpdated, newKey };
    });
}

/**
 * Mark a pending supplier as requiring attention after a permanent sync failure.
 */
export async function markPendingSupplierNeedsAttention(
    supplierId: string,
    tenantId: string,
    errorMessage: string,
    db: OfflineDatabase = offlineDB
): Promise<void> {
    const key = makeCachedSupplierId(tenantId.trim(), supplierId.trim());
    const existing = await db.cachedSuppliers.get(key);
    if (existing) {
        await db.cachedSuppliers.update(key, {
            syncStatus: "NEEDS_ATTENTION",
            errorMessage,
        });
    }
}

/**
 * Clear cached suppliers for a specific tenant (e.g. on account purge or logout).
 */
export async function clearCachedSuppliersForTenant(
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = tenantId?.trim();
    if (!cleanTenantId) return 0;

    try {
        return await db.cachedSuppliers.where("tenantId").equals(cleanTenantId).delete();
    } catch (error) {
        console.warn("Failed to clear cached suppliers for tenant:", error);
        return 0;
    }
}
