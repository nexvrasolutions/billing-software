
/*
 * Logout cache cleanup (testable: the cache storage is passed in).
 *
 * Only the runtime page/data caches created by @ducanh2912/next-pwa's
 * default rules are removed, by exact name. The precache (the offline app
 * shell, including /dashboard and /offline-test), static asset caches and
 * IndexedDB (the offline queue) are never touched. "apis" is not listed: API
 * responses are no longer cached (see next.config.ts and worker/index.ts).
 */
export const LOGOUT_CLEARED_CACHES = [
    "pages",
    "pages-rsc",
    "pages-rsc-prefetch",
    "next-data",
    "start-url",
] as const;

export interface CacheDeleter {
    delete(cacheName: string): Promise<boolean>;
}

/** Delete the listed runtime caches; returns the names that existed. Never throws. */
export async function clearRuntimeCaches(cacheStorage: CacheDeleter | null | undefined): Promise<string[]> {
    if (!cacheStorage) return [];

    const removed: string[] = [];
    for (const name of LOGOUT_CLEARED_CACHES) {
        try {
            if (await cacheStorage.delete(name)) removed.push(name);
        } catch {
            // Best effort: one failing cache does not stop the others.
        }
    }
    return removed;
}
