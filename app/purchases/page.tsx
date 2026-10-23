"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { restoreOfflineSession, readRememberedIdentity } from "@/lib/offline/offlineAccess";
import {
    getCachedPurchasesForTenant,
    saveCachedPurchases,
    isTemporaryPurchaseId,
} from "@/lib/offline/purchaseCache";
import { isTemporarySupplierCode } from "@/lib/offline/supplierCache";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import { syncPendingOperations } from "@/lib/offline/SyncManager";

interface PurchaseItem {
    _id: string;
    purchaseNo: string;
    supplierInvoiceNo?: string;
    supplierSnapshot?: {
        name?: string;
        supplierCode?: string;
        phone?: string;
        gstin?: string;
    };
    purchaseDate: string;
    grandTotal: number;
    paidAmount: number;
    paymentStatus?: string;
    status: string;
    syncStatus?: "PENDING" | "SYNCING" | "SYNCED" | "FAILED" | "NEEDS_ATTENTION";
    errorMessage?: string;
}

export default function PurchasesPage() {
    const [purchases, setPurchases] = useState<PurchaseItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isOffline, setIsOffline] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [emptyCacheNotice, setEmptyCacheNotice] = useState(false);

    const activeRequestIdRef = useRef(0);
    const activeAbortControllerRef = useRef<AbortController | null>(null);

    const loadPurchases = useCallback(async () => {
        const requestId = ++activeRequestIdRef.current;

        if (activeAbortControllerRef.current) {
            activeAbortControllerRef.current.abort();
        }
        const abortController = new AbortController();
        activeAbortControllerRef.current = abortController;

        setLoading(true);
        setEmptyCacheNotice(false);
        const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

        // 1. If online, fetch from API first with timeout and cancellation guard
        if (!isNavOffline) {
            try {
                const combinedSignal =
                    typeof AbortSignal.any === "function"
                        ? AbortSignal.any([abortController.signal, AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)])
                        : abortController.signal;

                const res = await fetch("/api/purchases", {
                    credentials: "same-origin",
                    signal: combinedSignal,
                });

                if (requestId !== activeRequestIdRef.current) return;

                // Definitive auth rejection
                if (res.status === 401 || res.status === 403) {
                    setPurchases([]);
                    setIsOffline(false);
                    setError(
                        res.status === 401
                            ? "Please sign in to access purchases."
                            : "You do not have permission to view purchases."
                    );
                    setLoading(false);
                    return;
                }

                if (res.ok) {
                    const data = await res.json().catch(() => null);
                    if (requestId !== activeRequestIdRef.current) return;

                    if (data?.success && Array.isArray(data.purchases)) {
                        let tenantId: string | null = null;
                        if (data.purchases.length > 0 && data.purchases[0]?.tenantId) {
                            tenantId = String(data.purchases[0].tenantId);
                        }
                        if (!tenantId) {
                            const remembered = await readRememberedIdentity().catch(() => null);
                            tenantId = remembered?.tenantId ?? null;
                        }
                        if (!tenantId) {
                            const restored = await restoreOfflineSession().catch(() => null);
                            tenantId = restored?.identity?.tenantId ?? null;
                        }

                        if (tenantId) {
                            await saveCachedPurchases(data.purchases, tenantId).catch(() => undefined);
                        }

                        if (requestId !== activeRequestIdRef.current) return;

                        // Merge pending/needs_attention local purchases alongside server purchases
                        let localToMerge: PurchaseItem[] = [];
                        if (tenantId) {
                            try {
                                const cachedRecords = await getCachedPurchasesForTenant(tenantId, {
                                    includeCancelled: true,
                                });
                                const unsyncedLocal = cachedRecords.filter(
                                    (r) => r.syncStatus === "PENDING" || r.syncStatus === "NEEDS_ATTENTION" || r.syncStatus === "FAILED"
                                );

                                localToMerge = unsyncedLocal.map((r) => ({
                                    _id: r.purchaseId,
                                    purchaseNo: r.purchaseNo,
                                    supplierInvoiceNo: r.supplierInvoiceNo,
                                    supplierSnapshot: r.supplierSnapshot,
                                    purchaseDate: r.purchaseDate,
                                    grandTotal: r.grandTotal,
                                    paidAmount: r.paidAmount,
                                    paymentStatus: r.paymentStatus,
                                    status: r.status,
                                    syncStatus: r.syncStatus,
                                    errorMessage: r.errorMessage,
                                }));
                            } catch {}
                        }

                        if (requestId !== activeRequestIdRef.current) return;

                        const serverMapped: PurchaseItem[] = data.purchases.map((p: any) => ({
                            _id: String(p._id || p.id || ""),
                            purchaseNo: p.purchaseNo,
                            supplierInvoiceNo: p.supplierInvoiceNo,
                            supplierSnapshot: p.supplierSnapshot,
                            purchaseDate: p.purchaseDate,
                            grandTotal: p.grandTotal,
                            paidAmount: p.paidAmount,
                            paymentStatus: p.paymentStatus,
                            status: p.status || "received",
                            syncStatus: "SYNCED",
                        }));

                        const serverIds = new Set(serverMapped.map((s) => s._id));
                        const merged: PurchaseItem[] = [...serverMapped];
                        for (const local of localToMerge) {
                            if (!serverIds.has(local._id)) {
                                merged.unshift(local); // Put local pending purchases at the top
                            }
                        }

                        setPurchases(merged);
                        setIsOffline(false);
                        setError(null);
                        setLoading(false);
                        return;
                    }
                }
            } catch (err: any) {
                if (err?.name === "AbortError" || abortController.signal.aborted) {
                    return;
                }
                if (requestId !== activeRequestIdRef.current) return;
            }
        }

        if (requestId !== activeRequestIdRef.current) return;

        // 2. Offline Fallback: verified offline session & tenant-partitioned cache
        try {
            const restored = await restoreOfflineSession().catch(() => null);
            if (requestId !== activeRequestIdRef.current) return;

            if (!restored || !restored.ok || !restored.identity?.tenantId) {
                setPurchases([]);
                setIsOffline(false);
                setError(
                    restored?.reason ||
                    "Offline access is not available for this account. Please sign in online first."
                );
                setLoading(false);
                return;
            }

            const tenantId = restored.identity.tenantId;
            const cached = await getCachedPurchasesForTenant(tenantId, { includeCancelled: true });

            if (requestId !== activeRequestIdRef.current) return;

            if (cached.length === 0) {
                setPurchases([]);
                setIsOffline(true);
                setEmptyCacheNotice(true);
                setError(null);
                setLoading(false);
                return;
            }

            const mapped: PurchaseItem[] = cached.map((c) => ({
                _id: c.purchaseId,
                purchaseNo: c.purchaseNo,
                supplierInvoiceNo: c.supplierInvoiceNo,
                supplierSnapshot: c.supplierSnapshot,
                purchaseDate: c.purchaseDate,
                grandTotal: c.grandTotal,
                paidAmount: c.paidAmount,
                paymentStatus: c.paymentStatus,
                status: c.status,
                syncStatus: c.syncStatus,
                errorMessage: c.errorMessage,
            }));

            setPurchases(mapped);
            setIsOffline(true);
            setError(null);
            setLoading(false);
        } catch (err: any) {
            if (requestId !== activeRequestIdRef.current) return;
            setPurchases([]);
            setIsOffline(false);
            setError(err?.message || "Failed to load purchases from cache");
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadPurchases();
    }, [loadPurchases]);

    // Handle online/offline event transitions
    useEffect(() => {
        function handleOnline() {
            void loadPurchases();
        }
        function handleOffline() {
            setIsOffline(true);
        }

        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);
        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, [loadPurchases]);

    async function handleManualSync() {
        setIsSyncing(true);
        try {
            await syncPendingOperations();
            await loadPurchases();
        } catch {
        } finally {
            setIsSyncing(false);
        }
    }

    return (
        <AppShell>
            <main className="flex max-w-4xl flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
                        <p className="text-sm text-muted-foreground">
                            Manage purchase orders, supplier bills, and inward stock.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                        <Link href="/suppliers" className="underline">
                            Suppliers
                        </Link>
                        {!isOffline && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleManualSync}
                                disabled={isSyncing}
                            >
                                {isSyncing ? "Syncing..." : "Sync now"}
                            </Button>
                        )}
                        <Link href="/purchases/new" className="action-primary">
                            New purchase
                        </Link>
                    </div>
                </div>

                {isOffline && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                        <div className="flex items-center justify-between">
                            <span>
                                <strong>Working offline:</strong> Viewing locally cached purchases. New purchases will be saved to your device and synced automatically upon reconnection.
                            </span>
                        </div>
                    </div>
                )}

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading purchases...</p>
                ) : error ? (
                    <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                        {error}
                    </div>
                ) : emptyCacheNotice ? (
                    <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                        No purchases found in local offline storage. Connect online once to synchronize purchase records.
                    </div>
                ) : purchases.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No purchases yet.</p>
                ) : (
                    <div className="table-scroll">
                        <table className="w-full text-sm" aria-label="Purchases">
                            <thead className="border-b bg-muted/40 text-left">
                                <tr>
                                    <th className="p-2 font-medium">Bill date</th>
                                    <th className="p-2 font-medium">Supplier</th>
                                    <th className="p-2 font-medium">Bill no.</th>
                                    <th className="p-2 text-right font-medium">Total</th>
                                    <th className="p-2 text-right font-medium">Paid with bill</th>
                                    <th className="p-2 font-medium">Status</th>
                                    <th className="p-2 font-medium">Sync</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {purchases.map((p) => {
                                    const dateStr = p.purchaseDate
                                        ? new Date(p.purchaseDate).toISOString().slice(0, 10)
                                        : "—";
                                    const isTempSupplier = isTemporarySupplierCode(p.supplierSnapshot?.supplierCode);
                                    const isTempPurchase = isTemporaryPurchaseId(p._id);

                                    return (
                                        <tr key={p._id}>
                                            <td className="p-2">{dateStr}</td>
                                            <td className="p-2">
                                                <div className="flex flex-col">
                                                    <span>{p.supplierSnapshot?.name || "Supplier"}</span>
                                                    {isTempSupplier && (
                                                        <span className="text-xs text-amber-600 dark:text-amber-400">
                                                            (Pending supplier confirmation)
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="p-2">
                                                <Link href={`/purchases/${p._id}`} className="underline font-medium">
                                                    {p.supplierInvoiceNo || p.purchaseNo}
                                                </Link>
                                                {isTempPurchase && (
                                                    <span className="ml-1.5 text-xs text-muted-foreground">
                                                        (Local provisional)
                                                    </span>
                                                )}
                                            </td>
                                            <td className="p-2 text-right tabular-nums">
                                                {formatPaise(rupeesToPaise(p.grandTotal))}
                                            </td>
                                            <td className="p-2 text-right tabular-nums">
                                                {p.paidAmount > 0 ? formatPaise(rupeesToPaise(p.paidAmount)) : "—"}
                                            </td>
                                            <td className="p-2">
                                                {p.status === "cancelled" ? (
                                                    <span className="text-destructive font-medium">Voided</span>
                                                ) : (
                                                    <span className="capitalize">{p.status}</span>
                                                )}
                                            </td>
                                            <td className="p-2">
                                                {p.syncStatus === "PENDING" ? (
                                                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                                        Pending sync
                                                    </span>
                                                ) : p.syncStatus === "NEEDS_ATTENTION" ? (
                                                    <span
                                                        className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
                                                        title={p.errorMessage || "Sync conflict requires attention"}
                                                    >
                                                        Needs attention
                                                    </span>
                                                ) : p.syncStatus === "FAILED" ? (
                                                    <span
                                                        className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/40 dark:text-orange-300"
                                                        title={p.errorMessage || "Retrying soon"}
                                                    >
                                                        Retrying
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                                                        Synced
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </main>
        </AppShell>
    );
}
