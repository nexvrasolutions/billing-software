"use client";

import { useEffect } from "react";

/**
 * In development mode (npm run dev), unregisters any lingering production service workers
 * and clears stale static asset/precache caches on localhost:3000.
 *
 * This prevents stale production-bundled chunks from intercepting dev requests,
 * avoids 404s on buildManifest.js in dev, and ensures the latest code runs on initial load
 * without requiring a hard refresh.
 *
 * This does NOT run in production, and never touches IndexedDB or sync queue data.
 */
export function DevServiceWorkerManager() {
    useEffect(() => {
        if (process.env.NODE_ENV !== "development") return;
        if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

        navigator.serviceWorker.getRegistrations().then((registrations) => {
            for (const registration of registrations) {
                registration.unregister().catch(() => undefined);
            }
        }).catch(() => undefined);

        if ("caches" in window) {
            caches.keys().then((keys) => {
                for (const key of keys) {
                    if (
                        key.includes("next-static-js-assets") ||
                        key.includes("pages") ||
                        key.includes("workbox-precache") ||
                        key.includes("start-url")
                    ) {
                        caches.delete(key).catch(() => undefined);
                    }
                }
            }).catch(() => undefined);
        }
    }, []);

    return null;
}
