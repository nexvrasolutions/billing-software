"use client";

import { useEffect, useState } from "react";

/*
 * "New version available" notice. A new service worker installs in the
 * background but waits (skipWaiting: false in next.config.ts) instead of
 * taking over open tabs, because activating it removes the old version's
 * cached files that an open, possibly offline, tab may still need.
 *
 * The user decides when to update: "Reload to update" tells the waiting
 * worker to activate and reloads once it controls the page. The new version
 * is already fully downloaded when this shows, so reloading works offline.
 * Waiting operations live in IndexedDB and are not touched by an update.
 */
export function UpdateBanner() {
    const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
    const [updating, setUpdating] = useState(false);

    useEffect(() => {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

        let cancelled = false;
        // Only an UPDATE is announced: a worker installed while the page is
        // already controlled. The first install needs no reload.
        const offer = (worker: ServiceWorker | null) => {
            if (!cancelled && worker && navigator.serviceWorker.controller) setWaiting(worker);
        };

        void navigator.serviceWorker.getRegistration().then((registration) => {
            if (!registration || cancelled) return;
            offer(registration.waiting);
            registration.addEventListener("updatefound", () => {
                const installing = registration.installing;
                installing?.addEventListener("statechange", () => {
                    if (installing.state === "installed") offer(installing);
                });
            });
        }).catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, []);

    if (!waiting) return null;

    function update() {
        if (!waiting) return;
        setUpdating(true);
        navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
        waiting.postMessage({ type: "SKIP_WAITING" });
    }

    return (
        <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            A new version of the app is available. Finish the sale you are entering and close other tabs of
            this app, then{" "}
            <button type="button" onClick={update} disabled={updating} className="font-medium underline disabled:opacity-60">
                {updating ? "Updating..." : "Reload to update"}
            </button>
            . Waiting operations stay on this device.
        </div>
    );
}
