"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { countAllUnsyncedItems } from "@/lib/offline/pendingQueue";
import { SyncNowButton } from "@/components/offline/SyncNowButton";
import { ExportPendingButton } from "@/components/offline/ExportPendingButton";

export default function SyncPage() {
    const [isOnline, setIsOnline] = useState(true);
    const [pendingCount, setPendingCount] = useState(0);

    async function checkStatus() {
        setIsOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
        try {
            const count = await countAllUnsyncedItems().catch(() => 0);
            setPendingCount(count);
        } catch (err) {
            console.error("Failed to count unsynced items", err);
        }
    }

    useEffect(() => {
        checkStatus();
        const handleOnline = () => { setIsOnline(true); checkStatus(); };
        const handleOffline = () => { setIsOnline(false); checkStatus(); };
        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);
        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, []);

    return (
        <AppShell>
            <main className="flex max-w-3xl flex-col gap-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h1 className="text-2xl font-semibold tracking-tight">Sync status</h1>
                    <Link href="/settings/tills" className="text-sm underline">
                        Till settings
                    </Link>
                </div>

                <div className="flex flex-col gap-4 rounded-lg border p-4 bg-muted/20">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">Connection</span>
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
                            isOnline
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        }`}>
                            <span className={`h-2 w-2 rounded-full ${isOnline ? "bg-emerald-500" : "bg-amber-500"}`} />
                            {isOnline ? "Online" : "Offline"}
                        </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 border-t pt-3">
                        <span className="text-sm font-medium">Offline queued operations</span>
                        <span className="tabular-nums font-bold text-sm">
                            {pendingCount} item{pendingCount === 1 ? "" : "s"}
                        </span>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        Bills created while offline are kept securely in IndexedDB on this machine. They are synced automatically when your connection is restored.
                    </p>

                    <div className="flex flex-wrap items-center gap-3 border-t pt-3">
                        <SyncNowButton onDone={checkStatus} />
                        <ExportPendingButton />
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={checkStatus}
                        >
                            Refresh status
                        </Button>
                    </div>
                </div>
            </main>
        </AppShell>
    );
}
