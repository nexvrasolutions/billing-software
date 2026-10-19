/*
 * Offline Customer Cache
 *
 * Implements offline customer caching, tenant partitioning, and POS integration.
 *
 * Responsibilities:
 * 1. Safe mapping from authenticated /api/customers responses to local cache records.
 *    Only authorized fields are stored; sensitive tokens or credentials are excluded.
 * 2. Strict tenant isolation: cached records are partitioned by tenantId.
 *    Cross-tenant queries fail closed and return empty results.
 * 3. Offline customer creation and editing: local temporary IDs ("cust_...") and
 *    stable operation IDs for idempotent sync.
 * 4. Resolving local customer IDs to server MongoDB ObjectIds upon sync completion,
 *    updating any dependent queued sales.
 * 5. Preserving pending local modifications across cache refreshes.
 */

import { offlineDB, LAST_IDENTITY_KEY, type CachedCustomerRecord, type OfflineDatabase, type SyncQueueItem } from "./db";
import type { SessionIdentity } from "./syncPolicy";

export type { CachedCustomerRecord };

export interface CustomerCacheMetadata {
    count: number;
    activeCount: number;
    lastCachedAt: string | null;
}

/**
 * Generate a unique compound ID for the Dexie customer table.
 * Combining tenantId with the customer ID prevents cross-tenant collisions.
 */
export function makeCachedCustomerId(tenantId: string, rawCustomerId: string): string {
    return `${tenantId}:${rawCustomerId}`;
}

/**
 * Normalize phone numbers consistently: trim whitespace, strip spaces/dashes if desired,
 * or return undefined if empty.
 */
export function normalizeCustomerPhone(phone?: unknown): string | undefined {
    if (typeof phone !== "string") return undefined;
    const trimmed = phone.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Safely map a customer object (e.g. from /api/customers) to a CachedCustomerRecord.
 * Enforces tenant boundary defense-in-depth and excludes any unexpected data.
 */
export function mapApiCustomerToCacheRecord(
    raw: unknown,
    authorizedTenantId: string,
    cachedAt?: string
): CachedCustomerRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;

    const tenantId = authorizedTenantId.trim();
    if (!tenantId) return null;

    // Defense-in-depth: if customer object includes tenantId, ensure it matches
    if (c.tenantId !== undefined && c.tenantId !== null) {
        const customerTenantId = String(c.tenantId).trim();
        if (customerTenantId && customerTenantId !== tenantId) {
            return null;
        }
    }

    const rawId = String(c._id || c.id || c.customerId || "").trim();
    if (!rawId) return null;

    const name = String(c.name ?? "").trim();
    if (!name) return null;

    const phone = normalizeCustomerPhone(c.phone);
    const email = typeof c.email === "string" && c.email.trim() ? c.email.trim().toLowerCase() : undefined;
    const address = typeof c.address === "string" && c.address.trim() ? c.address.trim() : undefined;

    const status: "active" | "inactive" = c.status === "inactive" ? "inactive" : "active";

    return {
        id: makeCachedCustomerId(tenantId, rawId),
        customerId: rawId,
        tenantId,
        name,
        phone,
        email,
        address,
        status,
        cachedAt: cachedAt || new Date().toISOString(),
        syncStatus: "SYNCED",
    };
}

/**
 * Persist an array of customers fetched from /api/customers into IndexedDB.
 * Preserves pending offline records so local creations are never overwritten by server fetches.
 */
export async function saveCachedCustomers(
    customers: unknown[],
    authorizedTenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<number> {
    const cleanTenantId = authorizedTenantId.trim();
    if (!cleanTenantId || !Array.isArray(customers)) return 0;

    const nowIso = new Date().toISOString();
    const mappedRecords: CachedCustomerRecord[] = [];

    for (const item of customers) {
        const record = mapApiCustomerToCacheRecord(item, cleanTenantId, nowIso);
        if (record) {
            mappedRecords.push(record);
        }
    }

    return await db.transaction("rw", db.cachedCustomers, async () => {
        // Collect existing pending offline records to preserve them
        const existingRecords = await db.cachedCustomers
            .where("tenantId")
            .equals(cleanTenantId)
            .toArray();

        const pendingOrAttentionKeys = new Set<string>();
        for (const existing of existingRecords) {
            if (existing.syncStatus === "PENDING" || existing.syncStatus === "NEEDS_ATTENTION") {
                pendingOrAttentionKeys.add(existing.id);
            }
        }

        // Put mapped records without overwriting local pending items
        let savedCount = 0;
        for (const record of mappedRecords) {
            if (!pendingOrAttentionKeys.has(record.id)) {
                await db.cachedCustomers.put(record);
                savedCount++;
            }
        }

        return savedCount;
    });
}

/**
 * Retrieve cached customers for the active tenant, strictly isolated by tenantId.
 */
export async function getCachedCustomersForTenant(
    tenantId: string,
    options: { includeInactive?: boolean } = {},
    db: OfflineDatabase = offlineDB
): Promise<CachedCustomerRecord[]> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) return [];

    const records = await db.cachedCustomers
        .where("tenantId")
        .equals(cleanTenantId)
        .toArray();

    const filtered = options.includeInactive
        ? records
        : records.filter((r) => r.status === "active");

    return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search cached customers by query string (matching name, phone, or email).
 */
export async function searchCachedCustomers(
    query: string,
    tenantId: string,
    options: { includeInactive?: boolean } = {},
    db: OfflineDatabase = offlineDB
): Promise<CachedCustomerRecord[]> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) return [];

    const cleanQuery = query.trim().toLowerCase();
    const records = await getCachedCustomersForTenant(cleanTenantId, options, db);

    if (!cleanQuery) return records;

    return records.filter((cust) => {
        const matchesName = cust.name.toLowerCase().includes(cleanQuery);
        const matchesPhone = cust.phone ? cust.phone.includes(cleanQuery) : false;
        const matchesEmail = cust.email ? cust.email.toLowerCase().includes(cleanQuery) : false;
        return matchesName || matchesPhone || matchesEmail;
    });
}

/**
 * Save a locally created customer into cachedCustomers with PENDING status.
 */
export async function savePendingOfflineCustomer(
    customerData: {
        name: string;
        phone?: string;
        email?: string;
        address?: string;
    },
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    operationId?: string,
    localId?: string
): Promise<{ customer: CachedCustomerRecord; operationId: string }> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) {
        throw new Error("Tenant ID is required to save an offline customer");
    }

    const cleanName = customerData.name.trim();
    if (!cleanName) {
        throw new Error("Customer name is required");
    }

    const assignedLocalId = localId || `cust_${crypto.randomUUID()}`;
    const assignedOpId = operationId || crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const record: CachedCustomerRecord = {
        id: makeCachedCustomerId(cleanTenantId, assignedLocalId),
        customerId: assignedLocalId,
        tenantId: cleanTenantId,
        name: cleanName,
        phone: normalizeCustomerPhone(customerData.phone),
        email: customerData.email ? customerData.email.trim().toLowerCase() : undefined,
        address: customerData.address ? customerData.address.trim() : undefined,
        status: "active",
        cachedAt: nowIso,
        syncStatus: "PENDING",
        operationId: assignedOpId,
    };

    await db.cachedCustomers.put(record);

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

                await db.syncQueue.add({
                    operationId: assignedOpId,
                    operationType: "CREATE",
                    entityType: "Customer",
                    payload: {
                        localId: assignedLocalId,
                        name: cleanName,
                        ...(record.phone ? { phone: record.phone } : {}),
                        ...(record.email ? { email: record.email } : {}),
                        ...(record.address ? { address: record.address } : {}),
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
        console.warn("Could not enqueue customer creation to syncQueue:", queueErr);
    }

    return {
        customer: record,
        operationId: assignedOpId,
    };
}

/**
 * Scan cached customers for any pending records that have not yet been queued in syncQueue,
 * and enqueue them so that reconnecting or SyncManager will process them.
 * This heals any orphaned pending customers created offline (e.g. Vishak).
 */
export async function ensurePendingCustomersQueued(
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    fallbackOwner?: SessionIdentity
): Promise<number> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId || !db.cachedCustomers || !db.syncQueue) return 0;

    const pendingCustomers = await db.cachedCustomers
        .where("tenantId")
        .equals(cleanTenantId)
        .toArray();

    const pendingOnly = pendingCustomers.filter((c) => c.syncStatus === "PENDING");
    if (pendingOnly.length === 0) return 0;

    let queuedCount = 0;
    let owner: SessionIdentity | undefined = fallbackOwner;
    if (!owner && db.meta?.get) {
        const remembered = await db.meta.get(LAST_IDENTITY_KEY);
        if (remembered?.value && typeof remembered.value === "object") {
            owner = remembered.value as SessionIdentity;
        }
    }

    const allQueueItems = await db.syncQueue.toArray();
    const existingQueueByOpId = new Map(allQueueItems.map((q) => [q.operationId, q]));

    for (const cust of pendingOnly) {
        const opId = cust.operationId || crypto.randomUUID();
        const existingItem = existingQueueByOpId.get(opId);

        if (!existingItem) {
            const nowIso = new Date().toISOString();
            await db.syncQueue.add({
                operationId: opId,
                operationType: "CREATE",
                entityType: "Customer",
                payload: {
                    localId: cust.customerId,
                    name: cust.name,
                    ...(cust.phone ? { phone: cust.phone } : {}),
                    ...(cust.email ? { email: cust.email } : {}),
                    ...(cust.address ? { address: cust.address } : {}),
                    status: cust.status,
                },
                localSeq: Date.now(),
                status: "PENDING",
                attempts: 0,
                createdAt: cust.cachedAt || nowIso,
                nextAttemptAt: nowIso,
                owner,
                ownerUserId: owner?.userId,
            });
            queuedCount++;

            if (cust.operationId !== opId) {
                await db.cachedCustomers.update(cust.id, { operationId: opId });
            }
        } else if (owner && (!existingItem.ownerUserId || !existingItem.owner)) {
            // Repair missing ownership on already-queued pending items so SyncManager can find and sync them
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

/**
 * Save an offline update to an existing cached customer with PENDING status.
 */
export async function savePendingOfflineCustomerUpdate(
    customerData: {
        customerId: string;
        name: string;
        phone?: string;
        email?: string;
        address?: string;
        status?: "active" | "inactive";
    },
    tenantId: string,
    db: OfflineDatabase = offlineDB,
    operationId?: string
): Promise<CachedCustomerRecord> {
    const cleanTenantId = tenantId.trim();
    if (!cleanTenantId) {
        throw new Error("Tenant ID is required to update an offline customer");
    }

    const cleanCustomerId = customerData.customerId?.trim();
    if (!cleanCustomerId) {
        throw new Error("Customer ID is required");
    }

    const cleanName = customerData.name.trim();
    if (!cleanName) {
        throw new Error("Customer name is required");
    }

    const assignedOpId = operationId || crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const key = makeCachedCustomerId(cleanTenantId, cleanCustomerId);
    const existing = await db.cachedCustomers.get(key);

    const record: CachedCustomerRecord = {
        id: key,
        customerId: cleanCustomerId,
        tenantId: cleanTenantId,
        name: cleanName,
        phone: customerData.phone ? normalizeCustomerPhone(customerData.phone) : (customerData.phone === "" ? undefined : existing?.phone),
        email: customerData.email ? customerData.email.trim().toLowerCase() : (customerData.email === "" ? undefined : existing?.email),
        address: customerData.address !== undefined ? (customerData.address.trim() || undefined) : existing?.address,
        status: customerData.status || existing?.status || "active",
        cachedAt: nowIso,
        syncStatus: "PENDING",
        operationId: assignedOpId,
    };

    await db.cachedCustomers.put(record);

    // If an un-synced queue item exists for this customer, update its payload as well
    try {
        const queueItems = await db.syncQueue.toArray();
        const pendingItem = queueItems.find(
            (q) => q.entityType === "Customer" && (q.payload?.localId === cleanCustomerId || q.operationId === assignedOpId)
        );
        if (pendingItem && pendingItem.id !== undefined && (pendingItem.status === "PENDING" || pendingItem.status === "FAILED")) {
            await db.syncQueue.update(pendingItem.id, {
                payload: {
                    ...pendingItem.payload,
                    name: cleanName,
                    phone: record.phone,
                    email: record.email,
                    address: record.address,
                    status: record.status,
                },
            });
        }
    } catch {}

    return record;
}

/**
 * Resolve a temporary client customer ID to the permanent server MongoDB ObjectId.
 * Updates cachedCustomers and rewrites any queued sales that referenced the local ID.
 */
export async function resolvePendingCustomerId(
    localId: string,
    serverId: string,
    tenantId: string,
    db: OfflineDatabase = offlineDB
): Promise<{ resolved: boolean; dependentSalesUpdated: number }> {
    const cleanTenantId = tenantId.trim();
    const cleanLocalId = localId.trim();
    const cleanServerId = serverId.trim();

    if (!cleanTenantId || !cleanLocalId || !cleanServerId) {
        return { resolved: false, dependentSalesUpdated: 0 };
    }

    return await db.transaction("rw", db.cachedCustomers, db.syncQueue, async () => {
        // 1. Update cachedCustomers table
        const oldKey = makeCachedCustomerId(cleanTenantId, cleanLocalId);
        const existingRecord = await db.cachedCustomers.get(oldKey);

        if (existingRecord) {
            await db.cachedCustomers.delete(oldKey);
            const updatedRecord: CachedCustomerRecord = {
                ...existingRecord,
                id: makeCachedCustomerId(cleanTenantId, cleanServerId),
                customerId: cleanServerId,
                syncStatus: "SYNCED",
                errorMessage: undefined,
                cachedAt: new Date().toISOString(),
            };
            await db.cachedCustomers.put(updatedRecord);
        }

        // 2. Scan syncQueue for sales (or other operations) referencing local customer ID
        let dependentSalesUpdated = 0;
        const allQueueItems = await db.syncQueue.toArray();

        for (const item of allQueueItems) {
            if (item.id === undefined) continue;

            let modified = false;
            const payload = item.payload ? { ...item.payload } : {};

            // Check top-level customerId (Sales, Invoices, Payments)
            if (payload.customerId === cleanLocalId) {
                payload.customerId = cleanServerId;
                modified = true;
            }

            // Remove customerOperationId from dependsOn if resolved
            let newDependsOn = item.dependsOn;
            if (existingRecord?.operationId && newDependsOn && newDependsOn.includes(existingRecord.operationId)) {
                newDependsOn = newDependsOn.filter((opId) => opId !== existingRecord.operationId);
                modified = true;
            }

            if (modified) {
                await db.syncQueue.update(item.id, {
                    payload,
                    dependsOn: newDependsOn && newDependsOn.length > 0 ? newDependsOn : undefined,
                });
                dependentSalesUpdated++;
            }
        }

        return { resolved: true, dependentSalesUpdated };
    });
}

/**
 * Mark a pending customer as requiring attention after a permanent sync failure.
 */
export async function markPendingCustomerNeedsAttention(
    localId: string,
    tenantId: string,
    errorMessage: string,
    db: OfflineDatabase = offlineDB
): Promise<void> {
    const key = makeCachedCustomerId(tenantId.trim(), localId.trim());
    const existing = await db.cachedCustomers.get(key);
    if (existing) {
        await db.cachedCustomers.update(key, {
            syncStatus: "NEEDS_ATTENTION",
            errorMessage,
        });
    }
}
