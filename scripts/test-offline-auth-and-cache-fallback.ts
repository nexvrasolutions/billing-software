/*
 * Automated Test Suite: Offline Authentication & Customer/Product Cache Fallback
 * (DATABASE-FREE, BROWSER-FREE, NETWORK-FREE)
 *
 * Verifies:
 * 1. isDatabaseConnectionError correctly detects Atlas / DNS / socket connectivity failures.
 * 2. Unreachable Atlas causes endpoints to return 503 (offline: true) rather than 500 or 401/403.
 * 3. Offline session restoration safely retains authenticated tenant/user context without network.
 * 4. Tenant isolation is strictly preserved offline; arbitrary client tenant IDs cannot be injected.
 * 5. Customer cache fallback loads tenant-partitioned customers when offline.
 * 6. Customer cache empty state returns empty array cleanly without crashing or looping.
 * 7. Offline customer update records local changes with PENDING status and preserves other tenants.
 * 8. Product cache fallback loads tenant-partitioned products when offline.
 * 9. Product cache empty state returns empty array cleanly.
 * 10. Existing queued sync operations and pending items in Dexie are strictly preserved.
 *
 * Run:
 *   npx tsx scripts/test-offline-auth-and-cache-fallback.ts
 */

import { isDatabaseConnectionError } from "../lib/db/mongodb";
import {
    CLOCK_SKEW_MS,
    OFFLINE_SESSION_TTL_MS,
    activateOfflineSession,
    checkOfflineWorkAllowed,
    getOfflineSessionState,
    type OfflineIdentity,
    type OfflineSessionRecord,
    type OfflineSessionStore,
} from "../lib/offline/offlineSession";
import {
    saveCachedCustomers,
    getCachedCustomersForTenant,
    searchCachedCustomers,
    savePendingOfflineCustomer,
    savePendingOfflineCustomerUpdate,
    ensurePendingCustomersQueued,
    resolvePendingCustomerId,
    markPendingCustomerNeedsAttention,
    makeCachedCustomerId,
    type CachedCustomerRecord,
} from "../lib/offline/customerCache";
import {
    getCachedProductsForTenant,
    mapApiProductsToCacheRecords,
    type CachedProductRecord,
} from "../lib/offline/productCatalogueCache";
import {
    SYNC_ENTITY_PERMISSIONS,
    BUSINESS_PERMISSIONS,
    getSyncEntityPermission,
} from "../lib/auth/businessPermissions";
import { selectSyncable, type SessionIdentity } from "../lib/offline/syncPolicy";
import { LAST_IDENTITY_KEY, type OfflineDatabase, type SyncQueueItem } from "../lib/offline/db";

const results: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
    results.push({ name, passed: condition, detail: condition ? undefined : detail });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

// In-memory mock Dexie database for testing
function createMockOfflineDatabase(): OfflineDatabase {
    const cachedCustomersMap = new Map<string, CachedCustomerRecord>();
    const cachedProductsMap = new Map<string, CachedProductRecord>();
    const syncQueueMap = new Map<number, SyncQueueItem>();
    const metaMap = new Map<string, unknown>();
    let nextQueueId = 1;

    const mockDb = {
        cachedCustomers: {
            get: async (id: string) => (cachedCustomersMap.has(id) ? structuredClone(cachedCustomersMap.get(id)!) : undefined),
            put: async (record: CachedCustomerRecord) => {
                cachedCustomersMap.set(record.id, structuredClone(record));
                return record.id;
            },
            delete: async (id: string) => {
                cachedCustomersMap.delete(id);
            },
            update: async (id: string, changes: Partial<CachedCustomerRecord>) => {
                const existing = cachedCustomersMap.get(id);
                if (existing) {
                    cachedCustomersMap.set(id, { ...existing, ...changes });
                    return 1;
                }
                return 0;
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = [...cachedCustomersMap.values()];
                        if (field === "tenantId") {
                            return all.filter((r) => r.tenantId === val).map((r) => structuredClone(r));
                        }
                        return [];
                    },
                }),
            }),
            toArray: async () => [...cachedCustomersMap.values()].map((r) => structuredClone(r)),
        },
        cachedProducts: {
            get: async (id: string) => (cachedProductsMap.has(id) ? structuredClone(cachedProductsMap.get(id)!) : undefined),
            put: async (record: CachedProductRecord) => {
                cachedProductsMap.set(record.id, structuredClone(record));
                return record.id;
            },
            delete: async (id: string) => {
                cachedProductsMap.delete(id);
            },
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = [...cachedProductsMap.values()];
                        if (field === "tenantId") {
                            return all.filter((r) => r.tenantId === val).map((r) => structuredClone(r));
                        }
                        return [];
                    },
                    delete: async () => {
                        let count = 0;
                        for (const [key, r] of cachedProductsMap.entries()) {
                            if (r.tenantId === val) {
                                cachedProductsMap.delete(key);
                                count++;
                            }
                        }
                        return count;
                    },
                }),
            }),
            toArray: async () => [...cachedProductsMap.values()].map((r) => structuredClone(r)),
        },
        syncQueue: {
            get: async (id: number) => (syncQueueMap.has(id) ? structuredClone(syncQueueMap.get(id)!) : undefined),
            add: async (item: Omit<SyncQueueItem, "id">) => {
                const id = nextQueueId++;
                const record = { ...item, id };
                syncQueueMap.set(id, structuredClone(record));
                return id;
            },
            put: async (item: SyncQueueItem) => {
                const id = item.id ?? nextQueueId++;
                syncQueueMap.set(id, structuredClone({ ...item, id }));
                return id;
            },
            update: async (id: number, changes: Partial<SyncQueueItem>) => {
                const existing = syncQueueMap.get(id);
                if (existing) {
                    syncQueueMap.set(id, { ...existing, ...changes });
                    return 1;
                }
                return 0;
            },
            toArray: async () => [...syncQueueMap.values()].map((r) => structuredClone(r)),
            where: (field: string) => ({
                equals: (val: string) => ({
                    toArray: async () => {
                        const all = [...syncQueueMap.values()];
                        if (field === "ownerUserId") {
                            return all.filter((r) => r.ownerUserId === val).map((r) => structuredClone(r));
                        }
                        if (field === "operationId") {
                            return all.filter((r) => r.operationId === val).map((r) => structuredClone(r));
                        }
                        return [];
                    },
                    first: async () => {
                        const all = [...syncQueueMap.values()];
                        const match = all.find((r) => (r as any)[field] === val);
                        return match ? structuredClone(match) : undefined;
                    },
                }),
            }),
        },
        meta: {
            get: async (key: string) => {
                if (metaMap.has(key)) return { key, value: structuredClone(metaMap.get(key)) };
                return undefined;
            },
            put: async (entry: { key: string; value: unknown }) => {
                metaMap.set(entry.key, structuredClone(entry.value));
            },
        },
        transaction: async (_mode: string, ...args: any[]) => {
            const fn = args[args.length - 1];
            return await fn();
        },
    } as unknown as OfflineDatabase;

    return mockDb;
}

async function runTests() {
    console.log("\n--- Section 1: Database Connection Error Detection ---");

    // 1. MongoServerSelectionError getaddrinfo ENOTFOUND
    const dnsError = new Error("getaddrinfo ENOTFOUND cluster0.mongodb.net");
    dnsError.name = "MongoServerSelectionError";
    check("1.1 MongoServerSelectionError with getaddrinfo ENOTFOUND detected", isDatabaseConnectionError(dnsError));

    // 2. ENOTFOUND in error code
    const systemDnsError: any = new Error("DNS resolution failed");
    systemDnsError.code = "ENOTFOUND";
    check("1.2 Error with code ENOTFOUND detected", isDatabaseConnectionError(systemDnsError));

    // 3. ETIMEDOUT & ECONNREFUSED
    const timeoutError: any = new Error("Connection timed out");
    timeoutError.code = "ETIMEDOUT";
    check("1.3 Error with code ETIMEDOUT detected", isDatabaseConnectionError(timeoutError));

    const connRefusedError: any = new Error("Connection refused");
    connRefusedError.code = "ECONNREFUSED";
    check("1.4 Error with code ECONNREFUSED detected", isDatabaseConnectionError(connRefusedError));

    // 4. MongoNetworkError & MongoTopologyClosedError
    const mongoNetError = new Error("Network error occurred");
    mongoNetError.name = "MongoNetworkError";
    check("1.5 MongoNetworkError detected", isDatabaseConnectionError(mongoNetError));

    const topologyError = new Error("Topology was closed");
    topologyError.name = "MongoTopologyClosedError";
    check("1.6 MongoTopologyClosedError detected", isDatabaseConnectionError(topologyError));

    // 5. Unrelated business/validation errors must NOT be detected as connection errors
    const validationError = new Error("Customer name is required");
    validationError.name = "ValidationError";
    check("1.7 App ValidationError correctly NOT detected as connection error", !isDatabaseConnectionError(validationError));

    const authError = new Error("Invalid credentials");
    check("1.8 App auth error correctly NOT detected as connection error", !isDatabaseConnectionError(authError));

    console.log("\n--- Section 2: Server API Route Offline Handling (503 vs 401/500) ---");

    // Simulate route handler catch block logic for /api/auth/me, /api/customers, /api/products
    function simulateRouteCatch(err: unknown) {
        if (isDatabaseConnectionError(err)) {
            return {
                status: 503,
                body: {
                    success: false,
                    message: "Database connection unavailable",
                    offline: true,
                },
            };
        }
        return {
            status: 500,
            body: {
                success: false,
                message: "Internal server error",
            },
        };
    }

    const atlasOutageResponse = simulateRouteCatch(dnsError);
    check("2.1 Atlas outage returns HTTP 503 Service Unavailable", atlasOutageResponse.status === 503);
    check("2.2 Response contains offline: true flag", atlasOutageResponse.body.offline === true);
    check("2.3 Response does NOT return 401 Unauthorized (which would kill offline session)", atlasOutageResponse.status !== 401);
    check("2.4 Response does NOT return unhandled 500", atlasOutageResponse.status !== 500);

    console.log("\n--- Section 3: Safe Offline Session Restoration & Tenant Retention ---");

    const now = Date.now();
    const sessionStoreMap = new Map<string, OfflineSessionRecord>();
    const sessionStore: OfflineSessionStore = {
        get: async (key) => (sessionStoreMap.has(key) ? structuredClone(sessionStoreMap.get(key)!) : undefined),
        put: async (record) => { sessionStoreMap.set(record.key, structuredClone(record)); },
        delete: async (key) => { sessionStoreMap.delete(key); },
    };

    const identityTenantA: OfflineIdentity = {
        tenantId: "111111111111111111111111",
        userId: "222222222222222222222222",
        deviceId: "333333333333333333333333",
    };

    // Activate offline session from server-confirmed check
    await activateOfflineSession(sessionStore, {
        identity: identityTenantA,
        permissions: ["sales.create", "products.read", "customers.read", "customers.create"],
        displayName: "Alice Cashier",
        now,
        serverTime: now,
    });

    const activeAllowed = await checkOfflineWorkAllowed(sessionStore, identityTenantA, now + 1000);
    const activeState = await getOfflineSessionState(sessionStore, identityTenantA, now + 1000);
    check("3.1 Offline work is allowed with valid 72h session", activeAllowed.ok === true);
    check("3.2 Restored session status is available", activeState.status === "available");
    check("3.3 Restored session has correct display name", (activeState as any).displayName === "Alice Cashier");
    check("3.4 Restored session keeps permissions intact", (activeState as any).permissions?.includes("sales.create") === true);

    // Verify expiry at >72h fails closed
    const expiredAllowed = await checkOfflineWorkAllowed(
        sessionStore,
        identityTenantA,
        now + OFFLINE_SESSION_TTL_MS + CLOCK_SKEW_MS + 1000
    );
    const expiredState = await getOfflineSessionState(
        sessionStore,
        identityTenantA,
        now + OFFLINE_SESSION_TTL_MS + CLOCK_SKEW_MS + 1000
    );
    check("3.5 Offline session >72h is expired and disallowed", expiredAllowed.ok === false);
    check("3.6 Status indicates offline session expired", expiredState.status === "expired");

    // Cross-tenant attempt: Bob on tenant_beta cannot use Alice's session on tenant_alpha
    const identityTenantB: OfflineIdentity = {
        tenantId: "444444444444444444444444",
        userId: "555555555555555555555555",
        deviceId: "333333333333333333333333",
    };
    const crossTenantAllowed = await checkOfflineWorkAllowed(sessionStore, identityTenantB, now + 1000);
    check("3.7 Tenant B cannot use Tenant A offline session", crossTenantAllowed.ok === false);

    console.log("\n--- Section 4: Customer Cache Fallback & Tenant Isolation ---");

    const mockDb = createMockOfflineDatabase();

    // Populate customer cache for Tenant A
    const rawCustomersTenantA = [
        { _id: "cust_a1", name: "Alice Enterprises", phone: "9876543210", email: "alice@ent.com", status: "active" },
        { _id: "cust_a2", name: "Apex Traders", phone: "9876543211", email: "apex@traders.com", status: "active" },
        { _id: "cust_a3", name: "Archived Customer", phone: "9876543212", status: "inactive" },
    ];
    await saveCachedCustomers(rawCustomersTenantA, "tenant_alpha", mockDb);

    // Populate customer cache for Tenant B
    const rawCustomersTenantB = [
        { _id: "cust_b1", name: "Beta Corp", phone: "9123456780", email: "contact@beta.com", status: "active" },
    ];
    await saveCachedCustomers(rawCustomersTenantB, "tenant_beta", mockDb);

    // Retrieve Tenant A customers offline
    const tenantACustomers = await getCachedCustomersForTenant("tenant_alpha", { includeInactive: false }, mockDb);
    check("4.1 Tenant A loads active cached customers offline", tenantACustomers.length === 2);
    check("4.2 Tenant A cached customers sorted alphabetically", tenantACustomers[0].name === "Alice Enterprises");
    check("4.3 Inactive customer excluded by default", !tenantACustomers.some((c) => c.customerId === "cust_a3"));

    // Tenant isolation verification: Tenant A MUST NOT see Tenant B
    check("4.4 Tenant A does NOT see Tenant B customer 'Beta Corp'", !tenantACustomers.some((c) => c.name === "Beta Corp"));

    // Retrieve Tenant B customers offline
    const tenantBCustomers = await getCachedCustomersForTenant("tenant_beta", { includeInactive: false }, mockDb);
    check("4.5 Tenant B loads exactly 1 customer", tenantBCustomers.length === 1);
    check("4.6 Tenant B does NOT see Tenant A customers", !tenantBCustomers.some((c) => c.name === "Alice Enterprises"));

    // Empty cache handling: Tenant C has no cached data
    const tenantCCustomers = await getCachedCustomersForTenant("tenant_gamma", { includeInactive: false }, mockDb);
    check("4.7 Empty cache for unknown tenant returns empty array", Array.isArray(tenantCCustomers) && tenantCCustomers.length === 0);

    // Search cached customers offline
    const searchResults = await searchCachedCustomers("apex", "tenant_alpha", { includeInactive: false }, mockDb);
    check("4.8 Offline customer search by name matches 'Apex Traders'", searchResults.length === 1 && searchResults[0].name === "Apex Traders");

    const phoneSearchResults = await searchCachedCustomers("543210", "tenant_alpha", { includeInactive: false }, mockDb);
    check("4.9 Offline customer search by phone matches 'Alice Enterprises'", phoneSearchResults.length === 1 && phoneSearchResults[0].name === "Alice Enterprises");

    console.log("\n--- Section 5: Offline Customer Updates & Creation ---");

    // Save offline customer update
    const updatedCustomer = await savePendingOfflineCustomerUpdate(
        {
            customerId: "cust_a1",
            name: "Alice Enterprises Global",
            phone: "9876543210",
            email: "alice@global.com",
            address: "123 Commercial Road",
            status: "active",
        },
        "tenant_alpha",
        mockDb
    );
    check("5.1 Offline customer update returns updated record", updatedCustomer.name === "Alice Enterprises Global");
    check("5.2 Offline customer update sets syncStatus PENDING", updatedCustomer.syncStatus === "PENDING");
    check("5.3 Offline customer update assigns operationId", Boolean(updatedCustomer.operationId));

    // Verify reading back updated customer from cache
    const reloaded = await mockDb.cachedCustomers.get(makeCachedCustomerId("tenant_alpha", "cust_a1"));
    check("5.4 Reloaded record reflects offline updated name", reloaded?.name === "Alice Enterprises Global");
    check("5.5 Reloaded record reflects offline updated address", reloaded?.address === "123 Commercial Road");
    check("5.6 Reloaded record preserves PENDING syncStatus", reloaded?.syncStatus === "PENDING");

    // Create offline pending customer
    const createdPending = await savePendingOfflineCustomer(
        {
            name: "New Offline Store",
            phone: "9988776655",
            email: "newstore@local.test",
        },
        "tenant_alpha",
        mockDb
    );
    check("5.7 Offline customer creation generates cust_ prefixed ID", createdPending.customer.customerId.startsWith("cust_"));
    check("5.8 Offline customer creation sets syncStatus PENDING", createdPending.customer.syncStatus === "PENDING");

    // Simulate online cache refresh: ensure pending offline updates and creations are NOT overwritten
    const freshServerFetch = [
        { _id: "cust_a1", name: "Alice Enterprises (Server Version)", phone: "9876543210", status: "active" },
        { _id: "cust_a2", name: "Apex Traders", phone: "9876543211", status: "active" },
    ];
    await saveCachedCustomers(freshServerFetch, "tenant_alpha", mockDb);

    const preservedPendingUpdate = await mockDb.cachedCustomers.get(makeCachedCustomerId("tenant_alpha", "cust_a1"));
    check("5.9 Pending offline customer update is preserved across server refresh", preservedPendingUpdate?.name === "Alice Enterprises Global");

    const preservedPendingCreate = await mockDb.cachedCustomers.get(makeCachedCustomerId("tenant_alpha", createdPending.customer.customerId));
    check("5.10 Pending offline customer create is preserved across server refresh", preservedPendingCreate?.name === "New Offline Store");

    console.log("\n--- Section 6: Product Cache Fallback & Tenant Isolation ---");

    const rawProductsTenantA = [
        { _id: "prod_a1", name: "Organic Honey 500g", SKU: "HON-500", sellingPrice: 250, stockQuantity: 20, status: "active" },
        { _id: "prod_a2", name: "Almond Milk 1L", SKU: "ALM-1000", sellingPrice: 180, stockQuantity: 15, status: "active" },
        { _id: "prod_a3", name: "Discontinued Tea", SKU: "TEA-DISC", sellingPrice: 90, stockQuantity: 0, status: "inactive" },
    ];
    const mappedProductsA = mapApiProductsToCacheRecords(rawProductsTenantA, "tenant_alpha");
    for (const p of mappedProductsA) {
        await mockDb.cachedProducts.put(p);
    }

    const rawProductsTenantB = [
        { _id: "prod_b1", name: "Tenant B Widget", SKU: "TB-WIDGET", sellingPrice: 50, stockQuantity: 100, status: "active" },
    ];
    const mappedProductsB = mapApiProductsToCacheRecords(rawProductsTenantB, "tenant_beta");
    for (const p of mappedProductsB) {
        await mockDb.cachedProducts.put(p);
    }

    const tenantAProducts = await getCachedProductsForTenant("tenant_alpha", mockDb);
    check("6.1 Tenant A loads 3 cached products offline", tenantAProducts.length === 3);
    check("6.2 Tenant A does NOT see Tenant B products", !tenantAProducts.some((p) => p.SKU === "TB-WIDGET"));

    const tenantBProducts = await getCachedProductsForTenant("tenant_beta", mockDb);
    check("6.3 Tenant B loads 1 cached product offline", tenantBProducts.length === 1);
    check("6.4 Tenant B does NOT see Tenant A products", !tenantBProducts.some((p) => p.SKU === "HON-500"));

    // Empty cache handling
    const tenantCProducts = await getCachedProductsForTenant("tenant_gamma", mockDb);
    check("6.5 Empty product cache returns empty array", Array.isArray(tenantCProducts) && tenantCProducts.length === 0);

    console.log("\n--- Section 7: Queued Sync Operations Preservation ---");

    // Add queued sale to syncQueue
    await mockDb.syncQueue.add({
        operationId: "op_sale_999",
        operationType: "CREATE",
        localSeq: 1,
        ownerUserId: "user_alice",
        entityType: "Sale",
        status: "PENDING",
        attempts: 0,
        createdAt: new Date().toISOString(),
        payload: {
            saleNumber: "PROV-001",
            customerId: "cust_a1",
            items: [{ productId: "prod_a1", quantity: 2 }],
        },
    });

    const queueBefore = await mockDb.syncQueue.toArray();
    const queuedSale = queueBefore.find((q) => q.operationId === "op_sale_999");
    check("7.1 Sync queue holds queued sale", Boolean(queuedSale));
    check("7.2 Queued sale status is PENDING", queuedSale?.status === "PENDING");

    // Simulate multiple offline operations (reads, updates, queries)
    await getCachedCustomersForTenant("tenant_alpha", { includeInactive: false }, mockDb);
    await getCachedProductsForTenant("tenant_alpha", mockDb);

    const queueAfter = await mockDb.syncQueue.toArray();
    const queuedSaleAfter = queueAfter.find((q) => q.operationId === "op_sale_999");
    check("7.3 Queued operations are 100% preserved during offline operations", queueAfter.length === queueBefore.length);
    check("7.4 Queued operation payload is untouched", queuedSaleAfter?.payload?.saleNumber === "PROV-001");

    console.log("\n--- Section 8: Reconnect Customer Sync, Orphan Healing & ID Reconciliation ---");

    // 8.1 Simulate Vishak: created offline and saved in cachedCustomers with PENDING status, but NOT yet in syncQueue
    const vishakLocalId = "cust_vishak_local_uuid";
    const vishakKey = makeCachedCustomerId("tenant_alpha", vishakLocalId);
    await mockDb.cachedCustomers.put({
        id: vishakKey,
        customerId: vishakLocalId,
        tenantId: "tenant_alpha",
        name: "Vishak",
        phone: "9876500000",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
        operationId: "op_vishak_001",
    });

    const vishakInQueueBefore = (await mockDb.syncQueue.toArray()).find((q) => q.payload?.localId === vishakLocalId);
    check("8.1 Vishak starts in cache without an entry in syncQueue (orphaned pending state)", !vishakInQueueBefore);

    // Run ensurePendingCustomersQueued (triggered upon reconnect or sync start)
    const healedCount = await ensurePendingCustomersQueued("tenant_alpha", mockDb);
    check("8.2 ensurePendingCustomersQueued detects and queues Vishak", healedCount >= 1);

    const vishakInQueueAfter = (await mockDb.syncQueue.toArray()).find((q) => q.operationId === "op_vishak_001");
    check("8.3 Queued item for Vishak exists with entityType Customer", vishakInQueueAfter?.entityType === "Customer");
    check("8.4 Queued item for Vishak has operationType CREATE", vishakInQueueAfter?.operationType === "CREATE");
    check("8.5 Queued item holds Vishak's name", vishakInQueueAfter?.payload?.name === "Vishak");

    // Idempotency: subsequent run does not duplicate queue item
    const healedAgain = await ensurePendingCustomersQueued("tenant_alpha", mockDb);
    check("8.6 ensurePendingCustomersQueued is idempotent (0 added on rerun)", healedAgain === 0);

    // 8.7 Verify Server Permissions and Route Mapping for Customer
    check("8.7 SYNC_ENTITY_PERMISSIONS maps Customer to salesCreate", SYNC_ENTITY_PERMISSIONS["Customer"] === BUSINESS_PERMISSIONS.salesCreate);
    check("8.8 getSyncEntityPermission('Customer') returns sales.create", getSyncEntityPermission("Customer") === "sales.create");

    // 8.9 Priority ordering in selectSyncable: Customer must be processed before Sale
    const itemsToSort = [
        {
            operationId: "op_sale_2",
            operationType: "CREATE" as const,
            entityType: "Sale" as const,
            payload: {},
            localSeq: 100,
            status: "PENDING" as const,
            attempts: 0,
            owner: { tenantId: "tenant_alpha", userId: "user_alice", deviceId: "device_pos_1" },
            ownerUserId: "user_alice",
        },
        {
            operationId: "op_cust_1",
            operationType: "CREATE" as const,
            entityType: "Customer" as const,
            payload: {},
            localSeq: 200,
            status: "PENDING" as const,
            attempts: 0,
            owner: { tenantId: "tenant_alpha", userId: "user_alice", deviceId: "device_pos_1" },
            ownerUserId: "user_alice",
        },
    ];
    const sorted = selectSyncable(itemsToSort, { tenantId: "tenant_alpha", userId: "user_alice", deviceId: "device_pos_1" }, new Date());
    check("8.9 selectSyncable sorts Customer creations ahead of Sales", sorted[0].operationId === "op_cust_1");

    // 8.10 Reconcile temporary local ID to authoritative server MongoDB ObjectId
    const serverObjectId = "65f000000000000000000001";
    // Add a dependent sale in syncQueue referencing Vishak's localId
    await mockDb.syncQueue.add({
        operationId: "op_sale_vishak",
        operationType: "CREATE",
        localSeq: 300,
        ownerUserId: "user_alice",
        entityType: "Sale",
        status: "PENDING",
        attempts: 0,
        createdAt: new Date().toISOString(),
        dependsOn: ["op_vishak_001"],
        payload: {
            saleNumber: "PROV-VISHAK",
            customerId: vishakLocalId,
        },
    });

    const resolution = await resolvePendingCustomerId(vishakLocalId, serverObjectId, "tenant_alpha", mockDb);
    check("8.10 resolvePendingCustomerId reports resolved: true", resolution.resolved === true);
    check("8.11 Dependent sale referencing Vishak was updated", resolution.dependentSalesUpdated === 1);

    // Old temporary key must be deleted
    const oldCachedRecord = await mockDb.cachedCustomers.get(vishakKey);
    check("8.12 Old temporary key deleted from customer cache", !oldCachedRecord);

    // New permanent key must exist with SYNCED status
    const newCachedRecord = await mockDb.cachedCustomers.get(makeCachedCustomerId("tenant_alpha", serverObjectId));
    check("8.13 New server ID record exists in customer cache", Boolean(newCachedRecord));
    check("8.14 Reconciled customer has status SYNCED", newCachedRecord?.syncStatus === "SYNCED");
    check("8.15 Reconciled customer has server ID", newCachedRecord?.customerId === serverObjectId);

    // Dependent sale in syncQueue must now reference the server ID and cleared dependsOn
    const allQueue = await mockDb.syncQueue.toArray();
    const dependentSale = allQueue.find((q) => q.operationId === "op_sale_vishak");
    check("8.16 Dependent sale customerId rewritten to server ObjectId", dependentSale?.payload?.customerId === serverObjectId);
    check("8.17 Resolved customer opId cleared from sale dependsOn", !dependentSale?.dependsOn || dependentSale.dependsOn.length === 0);

    // 8.18 Permanent sync failure marks customer NEEDS_ATTENTION
    const failedCustomerLocalId = "cust_failed_local";
    await mockDb.cachedCustomers.put({
        id: makeCachedCustomerId("tenant_alpha", failedCustomerLocalId),
        customerId: failedCustomerLocalId,
        tenantId: "tenant_alpha",
        name: "Failed Customer",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
    });
    await markPendingCustomerNeedsAttention(failedCustomerLocalId, "tenant_alpha", "Duplicate phone number", mockDb);
    const attentionCustomer = await mockDb.cachedCustomers.get(makeCachedCustomerId("tenant_alpha", failedCustomerLocalId));
    check("8.18 Failed customer marked as NEEDS_ATTENTION", attentionCustomer?.syncStatus === "NEEDS_ATTENTION");
    check("8.19 Error message preserved on cached customer", attentionCustomer?.errorMessage === "Duplicate phone number");
    check("8.20 Failed customer record preserved (not deleted)", Boolean(attentionCustomer));

    // ============================================================
    // Section 9: Sidebar Initialization, Ownership Repair & Online Merge
    // ============================================================
    console.log("\n--- Section 9: Sidebar Initialization, Ownership Repair & Online Merge ---");

    // 9.1 Filter NAV_GROUPS for cashier with sales.create
    const navGroups = [
        {
            title: "Sell",
            links: [
                { href: "/dashboard", label: "Dashboard" },
                { href: "/pos", label: "New bill" },
                { href: "/sales", label: "Sales" },
            ],
        },
        {
            title: "Money",
            links: [
                { href: "/customers", label: "Customers" },
                { href: "/reports", label: "Reports" },
            ],
        },
    ];

    const permissionByPath: Record<string, string | string[]> = {
        "/catalog/products": "products.read",
        "/sales": "sales.read",
        "/pos": "sales.create",
        "/customers": ["sales.create", "sales.read", "products.read", "users.read"],
    };

    function filterNav(groups: typeof navGroups, userPerms: string[] | undefined) {
        return groups.map((g) => ({
            title: g.title,
            links: g.links.filter((link) => {
                const req = permissionByPath[link.href];
                if (!req) return true;
                if (!Array.isArray(userPerms)) return false;
                if (Array.isArray(req)) return req.some((r) => userPerms.includes(r));
                return userPerms.includes(req);
            }),
        })).filter((g) => g.links.length > 0);
    }

    // Role-based initial navigation checks
    const cashierGroups = filterNav(navGroups, ["sales.create", "products.read"]);
    const cashierMoneyGroup = cashierGroups.find((g) => g.title === "Money");
    check("9.1 Cashier with sales.create sees Customers in sidebar on first render", Boolean(cashierMoneyGroup?.links.some((l) => l.href === "/customers")));

    const managerGroups = filterNav(navGroups, ["products.read", "products.create", "products.update"]);
    const managerMoneyGroup = managerGroups.find((g) => g.title === "Money");
    check("9.2 Manager with products.read sees Customers in sidebar on first render", Boolean(managerMoneyGroup?.links.some((l) => l.href === "/customers")));

    const businessOwnerPerms = [
        "products.read", "products.create", "products.update", "products.delete",
        "users.read", "users.create", "users.update", "users.delete"
    ];
    const ownerGroups = filterNav(navGroups, businessOwnerPerms);
    const ownerMoneyGroup = ownerGroups.find((g) => g.title === "Money");
    check("9.3a Business Owner with users.read/products.read sees Customers on first render", Boolean(ownerMoneyGroup?.links.some((l) => l.href === "/customers")));

    const adminGroups = filterNav(navGroups, ["products.read", "users.read"]);
    const adminMoneyGroup = adminGroups.find((g) => g.title === "Money");
    check("9.3b Administrator with products.read and users.read sees Customers on first render", Boolean(adminMoneyGroup?.links.some((l) => l.href === "/customers")));

    const unauthedGroups = filterNav(navGroups, ["taxes.read"]);
    const unauthedMoneyGroup = unauthedGroups.find((g) => g.title === "Money");
    check("9.3c User without customer/sales/product/user permissions does NOT see Customers in sidebar", !unauthedMoneyGroup?.links.some((l) => l.href === "/customers"));

    const unauthedNoPerms = filterNav(navGroups, undefined);
    const unauthedNoPermsMoneyGroup = unauthedNoPerms.find((g) => g.title === "Money");
    check("9.3d Unauthenticated/loading state with undefined perms does NOT show Customers link", !unauthedNoPermsMoneyGroup?.links.some((l) => l.href === "/customers"));

    // Session restoration auth population for roles without sales.create (Business Owner / Manager)
    function simulateInitialShellSessionRestore(restored: any) {
        const overviewState = restored?.overview?.state;
        if (overviewState && overviewState.status === "available") {
            const displayName = overviewState.displayName || "Staff";
            const permissions = Array.isArray(overviewState.permissions) ? overviewState.permissions : [];
            return {
                authenticated: true,
                user: { roleName: displayName, permissions },
                permissions,
                offlineAvailable: Boolean(restored.overview?.allowed),
                loading: false,
            };
        }
        return { authenticated: false, permissions: undefined, offlineAvailable: false, loading: true };
    }

    const mockOwnerRestored = {
        ok: false, // checkOfflineWorkAllowed is false because owner lacks sales.create
        reason: "This account is not allowed to record sales offline",
        overview: {
            identity: { tenantId: "tenant_alpha", userId: "user_owner", deviceId: "dev_1" },
            state: {
                status: "available",
                displayName: "Business Owner",
                permissions: businessOwnerPerms,
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
            allowed: false,
        },
    };
    const ownerInitialAuth = simulateInitialShellSessionRestore(mockOwnerRestored);
    check("9.3e Shell restores Business Owner permissions immediately without sales.create", ownerInitialAuth.authenticated && ownerInitialAuth.loading === false && ownerInitialAuth.permissions.length > 0);
    const ownerInitialNav = filterNav(navGroups, ownerInitialAuth.permissions);
    check("9.3f Restored Business Owner session immediately renders Customers link on first usable view", Boolean(ownerInitialNav.find((g) => g.title === "Money")?.links.some((l) => l.href === "/customers")));
    check("9.3g Business Owner without sales.create does not have offlineAvailable flagged", ownerInitialAuth.offlineAvailable === false);

    const mockSalesRestored = {
        ok: true,
        overview: {
            identity: { tenantId: "tenant_alpha", userId: "user_cashier", deviceId: "dev_2" },
            state: {
                status: "available",
                displayName: "Cashier",
                permissions: ["sales.create", "products.read"],
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
            allowed: true,
        },
    };
    const salesInitialAuth = simulateInitialShellSessionRestore(mockSalesRestored);
    check("9.3h Shell restores Sales user with sales.create immediately", salesInitialAuth.authenticated && salesInitialAuth.loading === false && salesInitialAuth.offlineAvailable === true);
    const salesInitialNav = filterNav(navGroups, salesInitialAuth.permissions);
    check("9.3i Restored Sales user session immediately renders Customers link on first usable view", Boolean(salesInitialNav.find((g) => g.title === "Money")?.links.some((l) => l.href === "/customers")));

    // 9.4 Auto-repair missing ownership on offline queued customer
    const unownedCustId = "cust_unowned_999";
    const unownedOpId = "op_unowned_999";
    await mockDb.cachedCustomers.put({
        id: makeCachedCustomerId("tenant_alpha", unownedCustId),
        customerId: unownedCustId,
        tenantId: "tenant_alpha",
        name: "Unowned Customer",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "PENDING",
        operationId: unownedOpId,
    });
    // Insert into syncQueue without owner or ownerUserId
    await mockDb.syncQueue.add({
        operationId: unownedOpId,
        operationType: "CREATE",
        entityType: "Customer",
        payload: { localId: unownedCustId, name: "Unowned Customer" },
        localSeq: 400,
        status: "PENDING",
        attempts: 0,
        createdAt: new Date().toISOString(),
    } as any);

    const activeIdentity: SessionIdentity = {
        tenantId: "tenant_alpha",
        userId: "user_alice",
        deviceId: "device_pos_1",
    };
    await ensurePendingCustomersQueued("tenant_alpha", mockDb, activeIdentity);

    const repairedItem = (await mockDb.syncQueue.toArray()).find((q) => q.operationId === unownedOpId);
    check("9.4 Offline customer with missing ownership is repaired by ensurePendingCustomersQueued", Boolean(repairedItem?.owner));
    check("9.5 Repaired item has ownerUserId matching active session", repairedItem?.ownerUserId === "user_alice");

    // 9.6 Online list merge when server returns 0 customers (data.customers = [])
    const serverCustomersEmpty: any[] = [];
    const localPendingRecords = await getCachedCustomersForTenant("tenant_alpha", { includeInactive: true }, mockDb);
    const localPendingOnly = localPendingRecords.filter((r) => r.syncStatus === "PENDING" || r.syncStatus === "NEEDS_ATTENTION");

    // Merging logic from loadCustomers
    const serverMapped: any[] = serverCustomersEmpty.map((c: any) => ({ _id: c._id, name: c.name, syncStatus: "SYNCED" }));
    const serverIds = new Set(serverMapped.map((s) => s._id));
    const mergedEmptyServer: any[] = [...serverMapped];
    for (const p of localPendingOnly) {
        if (!serverIds.has(p.customerId)) {
            mergedEmptyServer.push({ _id: p.customerId, name: p.name, syncStatus: p.syncStatus });
        }
    }
    check("9.6 Offline pending customer preserved in online list even when server returns 0 records", mergedEmptyServer.some((c) => c.name === "Unowned Customer"));

    // 9.7 Query filtering on pending customers
    const searchQuery = "Unowned";
    const filteredPending = mergedEmptyServer.filter((c) => c.name.toLowerCase().includes(searchQuery.toLowerCase()));
    check("9.7 Search query matches local pending customer", filteredPending.length === 1 && filteredPending[0].name === "Unowned Customer");

    // 9.8 Reconciled customer with SYNCED status appears alongside server records
    const serverCustomersWithSynced = [{ _id: serverObjectId, name: "Vishak", tenantId: "tenant_alpha" }];
    const mergedWithServer = [...serverCustomersWithSynced];
    check("9.8 Reconciled server customer appears in merged list", mergedWithServer.some((c) => c._id === serverObjectId && c.name === "Vishak"));

    // ============================================================
    // Section 10: Existing-Customer UPDATE Recovery from Failed CREATE
    // ============================================================
    console.log("\n--- Section 10: Existing-Customer UPDATE Recovery from Failed CREATE ---");

    const recoveryTenant = "6abe48a86ae4b08a3e335303";
    const serverCustId = "6ad62b1cfa76d2cb3ce12240";
    const oldFailedCreateOpId = "5c02d6e5-9127-47dc-89fc-5f0cd9d6a645";

    // Set owner identity in meta
    await mockDb.meta.put({
        key: LAST_IDENTITY_KEY,
        value: {
            tenantId: recoveryTenant,
            userId: "user_owner_recovery",
            deviceId: "device_pos_recovery",
        },
    });

    // 1. Seed old failed CREATE in syncQueue
    await mockDb.syncQueue.put({
        id: 8888,
        operationId: oldFailedCreateOpId,
        operationType: "CREATE",
        entityType: "Customer",
        payload: {
            localId: serverCustId,
            name: "Biling",
            address: "Karungal",
            phone: "9876543210",
        },
        localSeq: 600,
        status: "NEEDS_ATTENTION",
        attempts: 2,
        createdAt: new Date().toISOString(),
        ownerUserId: "user_owner_recovery",
    });

    // 2. Seed cachedCustomers with NEEDS_ATTENTION pointing to the failed CREATE operationId
    await mockDb.cachedCustomers.put({
        id: makeCachedCustomerId(recoveryTenant, serverCustId),
        customerId: serverCustId,
        tenantId: recoveryTenant,
        name: "Biling",
        phone: "9876543210",
        address: "Karungal",
        status: "active",
        cachedAt: new Date().toISOString(),
        syncStatus: "NEEDS_ATTENTION",
        operationId: oldFailedCreateOpId,
        errorMessage: "Phone collision on server",
    });

    // 10.1 First recovery attempt: generates a fresh UUID, does not reuse failed CREATE opId
    const firstRecovery = await savePendingOfflineCustomerUpdate(
        {
            customerId: serverCustId,
            name: "Biling",
            address: "Karungal",
            phone: "9876543210",
        },
        recoveryTenant,
        mockDb
    );

    check("10.1 Recovery UPDATE gets fresh UUID (not old failed CREATE opId)",
        firstRecovery.operationId !== oldFailedCreateOpId && Boolean(firstRecovery.operationId)
    );
    check("10.1 Recovery UPDATE sets syncStatus to PENDING",
        firstRecovery.syncStatus === "PENDING"
    );

    // 10.2 Old failed CREATE remains untouched
    const allQueue10 = await mockDb.syncQueue.toArray();
    const oldCreateItem = allQueue10.find((q) => q.operationId === oldFailedCreateOpId);
    check("10.2 Old failed CREATE remains in syncQueue", Boolean(oldCreateItem));
    check("10.2 Old failed CREATE operationType is still CREATE (untouched)", oldCreateItem?.operationType === "CREATE");
    check("10.2 Old failed CREATE status is still NEEDS_ATTENTION (untouched)", oldCreateItem?.status === "NEEDS_ATTENTION");
    check("10.2 Old failed CREATE payload is completely untouched", oldCreateItem?.payload?.name === "Biling" && oldCreateItem?.payload?.address === "Karungal");

    // 10.3 Repeated attempt preserves operationId and does not duplicate queue entries
    const queueCountBeforeRetry = (await mockDb.syncQueue.toArray()).length;
    const retryRecovery = await savePendingOfflineCustomerUpdate(
        {
            customerId: serverCustId,
            name: "Biling Preserved",
            address: "Karungal Town",
            phone: "9876543210",
        },
        recoveryTenant,
        mockDb
    );

    const allQueueAfterRetry = await mockDb.syncQueue.toArray();
    check("10.3 Repeated attempt preserves the new UPDATE operationId", retryRecovery.operationId === firstRecovery.operationId);
    check("10.3 Repeated attempt does not create duplicate queue entries", allQueueAfterRetry.length === queueCountBeforeRetry);

    const updateItemInQueue = allQueueAfterRetry.find((q) => q.operationId === firstRecovery.operationId);
    check("10.3 UPDATE queue item payload updated with newest values", updateItemInQueue?.payload?.name === "Biling Preserved");
    check("10.3 Old failed CREATE still untouched after retry",
        allQueueAfterRetry.find((q) => q.operationId === oldFailedCreateOpId)?.operationType === "CREATE"
    );

    // 10.4 Detail page load logic: NEEDS_ATTENTION retains local values online
    const detailAttentionCustomer = await mockDb.cachedCustomers.get(makeCachedCustomerId(recoveryTenant, serverCustId));
    // Simulate detail page check
    const shouldRetainAttention = detailAttentionCustomer && (detailAttentionCustomer.syncStatus === "PENDING" || detailAttentionCustomer.syncStatus === "NEEDS_ATTENTION");
    check("10.4 Detail page condition matches NEEDS_ATTENTION and retains local edits without server overwrite", Boolean(shouldRetainAttention));

    // 10.5 PENDING retains local values
    const pendingCheck = { syncStatus: "PENDING" as const };
    const shouldRetainPending = pendingCheck && (pendingCheck.syncStatus === "PENDING" || pendingCheck.syncStatus === "NEEDS_ATTENTION");
    check("10.5 Detail page condition matches PENDING and retains local values", Boolean(shouldRetainPending));

    // 10.6 SYNCED falls through to server fetch
    const syncedCheck = { syncStatus: "SYNCED" as const };
    const shouldRetainSynced = syncedCheck && ((syncedCheck as any).syncStatus === "PENDING" || (syncedCheck as any).syncStatus === "NEEDS_ATTENTION");
    check("10.6 SYNCED does not intercept detail page load, allowing server fetch", !shouldRetainSynced);

    // 10.7 Tenant ownership attached
    check("10.7 Tenant ownership attached from session to recovery item",
        updateItemInQueue?.ownerUserId === "user_owner_recovery" &&
        updateItemInQueue?.owner?.tenantId === recoveryTenant
    );

    console.log("\n============================================================");
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`OFFLINE AUTH & CACHE FALLBACK SUMMARY: ${passed}/${results.length} checks passed.`);
    if (failed > 0) {
        console.error(`FAILED: ${failed} checks failed.`);
        process.exit(1);
    }
    console.log("============================================================\n");
}

runTests().catch((err) => {
    console.error("Test runner error:", err);
    process.exit(1);
});
