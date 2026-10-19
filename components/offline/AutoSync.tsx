"use client";

import { useEffect, useRef } from "react";

import { syncPendingOperations, type SyncRunResult } from "@/lib/offline/SyncManager";
import { shouldStartAutoSync, type AutoSyncTrigger } from "@/lib/offline/autoSyncPolicy";

/*
 * Sends this account's waiting operations automatically when the page opens,
 * when the browser goes back online and when the tab becomes visible again
 * (see autoSyncPolicy.ts for the limits). Renders nothing. Mount it only
 * where the session has just been verified online; the sync itself checks
 * the session again and never sends another account's items.
 */
export function AutoSync({ onFinished }: { onFinished?: (result: SyncRunResult) => void }) {
    const inFlight = useRef(false);
    const lastStartedAt = useRef<number | null>(null);
    const onFinishedRef = useRef(onFinished);

    useEffect(() => {
        onFinishedRef.current = onFinished;
    }, [onFinished]);

    useEffect(() => {
        let unmounted = false;

        async function trigger(kind: AutoSyncTrigger) {
            const now = Date.now();
            if (!shouldStartAutoSync({
                trigger: kind,
                online: navigator.onLine,
                inFlight: inFlight.current,
                lastStartedAt: lastStartedAt.current,
                now,
            })) {
                return;
            }

            inFlight.current = true;
            lastStartedAt.current = now;
            try {
                const result = await syncPendingOperations();
                if (!unmounted) onFinishedRef.current?.(result);
            } catch {
                // Waiting operations stay on this device; the next trigger
                // or "Sync now" tries again.
            } finally {
                inFlight.current = false;
            }
        }

        const onOnline = () => void trigger("online");
        const onVisible = () => {
            if (document.visibilityState === "visible") void trigger("visible");
        };

        void trigger("open");
        window.addEventListener("online", onOnline);
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            unmounted = true;
            window.removeEventListener("online", onOnline);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    return null;
}
