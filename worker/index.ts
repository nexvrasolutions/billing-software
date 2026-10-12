/*
 * Custom service-worker code, bundled into the generated service worker by
 * @ducanh2912/next-pwa (customWorkerSrc defaults to this "worker" folder).
 *
 * Earlier service workers cached authenticated GET /api/* responses in a
 * cache named "apis". API responses are no longer cached (see
 * next.config.ts); delete that old cache so private data does not remain.
 */

const serviceWorker = self as unknown as {
    addEventListener(
        type: "activate",
        listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void
    ): void;
};

serviceWorker.addEventListener("activate", (event) => {
    event.waitUntil(caches.delete("apis"));
});

export {};
