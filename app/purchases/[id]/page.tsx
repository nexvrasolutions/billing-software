"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { restoreOfflineSession, readRememberedIdentity } from "@/lib/offline/offlineAccess";
import {
    getCachedPurchaseById,
    isTemporaryPurchaseId,
    isValidServerPurchaseId,
    saveCachedPurchases,
} from "@/lib/offline/purchaseCache";
import { isTemporarySupplierCode } from "@/lib/offline/supplierCache";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";

interface PaymentItem {
    _id?: string;
    paymentNo: string;
    amount: number;
    paymentMethod: string;
    paymentDate: string;
    referenceNo?: string;
    notes?: string;
    status?: string;
}

interface PurchaseItem {
    _id: string;
    purchaseNo: string;
    supplierId?: string;
    supplierInvoiceNo?: string;
    supplierSnapshot?: {
        name?: string;
        supplierCode?: string;
        phone?: string;
        gstin?: string;
    };
    purchaseDate: string;
    subtotal?: number;
    discountTotal?: number;
    taxTotal?: number;
    shippingCost?: number;
    grandTotal: number;
    paidAmount: number;
    dueAmount: number;
    paymentStatus: string;
    status: string;
    syncStatus?: "PENDING" | "SYNCING" | "SYNCED" | "FAILED" | "NEEDS_ATTENTION";
    errorMessage?: string;
    notes?: string;
    items?: Array<{
        productId: string;
        productSnapshot?: {
            name?: string;
            SKU?: string;
            unit?: string;
        };
        quantity: number;
        unitPrice: number;
        discountRate?: number;
        tax?: {
            rate: number;
            amount: number;
        };
        taxRate?: number;
        total?: number;
    }>;
}

interface PaymentModalState {
    isOpen: boolean;
    operationId: string;
    paymentNo: string;
    amount: string;
    paymentMethod: "cash" | "upi" | "card" | "bank" | "other";
    paymentDate: string;
    referenceNo: string;
    notes: string;
    isSubmitting: boolean;
    submitError: string | null;
}

export default function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const [purchase, setPurchase] = useState<PurchaseItem | null>(null);
    const [payments, setPayments] = useState<PaymentItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isOfflineView, setIsOfflineView] = useState(false);
    const [paymentModal, setPaymentModal] = useState<PaymentModalState | null>(null);

    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        let isCancelled = false;

        async function fetchPurchase() {
            setLoading(true);
            setError(null);

            const isTemp = isTemporaryPurchaseId(id);
            const isValidServer = isValidServerPurchaseId(id);

            // 1. If it's a server ObjectId and navigator is online, try fetching from server
            if (isValidServer && typeof navigator !== "undefined" && navigator.onLine) {
                try {
                    const timeoutController = new AbortController();
                    const timeoutId = setTimeout(() => timeoutController.abort(), SESSION_CHECK_TIMEOUT_MS);

                    const res = await fetch(`/api/purchases/${id}`, {
                        signal: timeoutController.signal,
                        credentials: "same-origin",
                    });
                    clearTimeout(timeoutId);

                    const data = await res.json().catch(() => null);

                    if (isCancelled) return;

                    if (res.ok && data?.success && data.purchase) {
                        const serverP = data.purchase;
                        const mapped: PurchaseItem = {
                            _id: String(serverP._id || serverP.id),
                            purchaseNo: serverP.purchaseNo,
                            supplierId: serverP.supplierId,
                            supplierInvoiceNo: serverP.supplierInvoiceNo,
                            supplierSnapshot: serverP.supplierSnapshot,
                            purchaseDate: serverP.purchaseDate,
                            subtotal: serverP.subtotal,
                            discountTotal: serverP.discountTotal,
                            taxTotal: serverP.taxTotal,
                            shippingCost: serverP.shippingCost,
                            grandTotal: serverP.grandTotal,
                            paidAmount: serverP.paidAmount,
                            dueAmount: serverP.dueAmount,
                            paymentStatus: serverP.paymentStatus,
                            status: serverP.status || "received",
                            syncStatus: "SYNCED",
                            notes: serverP.notes,
                            items: serverP.items,
                        };

                        setPurchase(mapped);
                        setPayments(data.payments || []);
                        setIsOfflineView(false);

                        // Cache in IndexedDB if tenantId is available
                        let tenantId = serverP.tenantId ? String(serverP.tenantId) : null;
                        if (!tenantId) {
                            const remembered = await readRememberedIdentity().catch(() => null);
                            tenantId = remembered?.tenantId || null;
                        }
                        if (tenantId) {
                            await saveCachedPurchases([serverP], tenantId).catch(() => undefined);
                        }

                        setLoading(false);
                        return;
                    }
                } catch {
                    // Server fetch failed / timed out; fall through to local cache
                }
            }

            if (isCancelled) return;

            // 2. Offline Fallback: load purchase from cachedPurchases
            try {
                let tenantId: string | null = null;
                const restored = await restoreOfflineSession().catch(() => null);
                if (restored?.ok && restored.identity?.tenantId) {
                    tenantId = restored.identity.tenantId;
                }
                if (!tenantId) {
                    const remembered = await readRememberedIdentity().catch(() => null);
                    tenantId = remembered?.tenantId || null;
                }

                if (!tenantId) {
                    setError("Unable to identify authorized business session to load purchase.");
                    setLoading(false);
                    return;
                }

                const cached = await getCachedPurchaseById(id, tenantId);

                if (isCancelled) return;

                if (!cached) {
                    setError(isTemp ? "Offline provisional purchase not found." : "Purchase bill not found.");
                    setLoading(false);
                    return;
                }

                const mapped: PurchaseItem = {
                    _id: cached.purchaseId,
                    purchaseNo: cached.purchaseNo,
                    supplierId: cached.supplierId,
                    supplierInvoiceNo: cached.supplierInvoiceNo,
                    supplierSnapshot: cached.supplierSnapshot,
                    purchaseDate: cached.purchaseDate,
                    subtotal: cached.subtotal,
                    discountTotal: cached.discountTotal,
                    taxTotal: cached.taxTotal,
                    shippingCost: cached.shippingCost,
                    grandTotal: cached.grandTotal,
                    paidAmount: cached.paidAmount,
                    dueAmount: cached.dueAmount ?? Math.max(0, cached.grandTotal - cached.paidAmount),
                    paymentStatus: cached.paymentStatus || "unpaid",
                    status: cached.status,
                    syncStatus: cached.syncStatus,
                    errorMessage: cached.errorMessage,
                    notes: cached.notes,
                    items: (cached.items || []).map((item) => {
                        const taxRate = item.taxRate ?? 0;
                        const gross = item.quantity * item.unitPrice;
                        const disc = (gross * (item.discountRate ?? 0)) / 100;
                        const taxable = gross - disc;
                        const taxAmt = (taxable * taxRate) / 100;
                        return {
                            productId: item.productId,
                            productSnapshot: item.productSnapshot,
                            quantity: item.quantity,
                            unitPrice: item.unitPrice,
                            discountRate: item.discountRate,
                            taxRate,
                            tax: { rate: taxRate, amount: taxAmt },
                            total: taxable + taxAmt,
                        };
                    }),
                };

                setPurchase(mapped);
                setPayments([]);
                setIsOfflineView(true);
                setLoading(false);
            } catch (err: any) {
                if (isCancelled) return;
                setError(err?.message || "Failed to load purchase");
                setLoading(false);
            }
        }

        void fetchPurchase();

        return () => {
            isCancelled = true;
        };
    }, [id, refreshKey]);

    function handleOpenPaymentModal() {
        if (!purchase) return;
        const initialOperationId =
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `op-pay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const initialPaymentNo = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

        setPaymentModal({
            isOpen: true,
            operationId: initialOperationId,
            paymentNo: initialPaymentNo,
            amount: String(purchase.dueAmount > 0 ? purchase.dueAmount : ""),
            paymentMethod: "cash",
            paymentDate: new Date().toISOString().slice(0, 10),
            referenceNo: "",
            notes: "",
            isSubmitting: false,
            submitError: null,
        });
    }

    function handleClosePaymentModal() {
        if (paymentModal?.isSubmitting) return;
        setPaymentModal(null);
    }

    async function handlePaymentSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!paymentModal || !purchase) return;

        const amountNum = Number(paymentModal.amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            setPaymentModal((prev) => (prev ? { ...prev, submitError: "Amount must be greater than zero." } : null));
            return;
        }

        if (amountNum > purchase.dueAmount) {
            setPaymentModal((prev) =>
                prev
                    ? {
                          ...prev,
                          submitError: `Payment amount (₹${amountNum}) cannot exceed the due amount (₹${purchase.dueAmount}).`,
                      }
                    : null
            );
            return;
        }

        if (!paymentModal.paymentDate) {
            setPaymentModal((prev) => (prev ? { ...prev, submitError: "Payment date is required." } : null));
            return;
        }

        setPaymentModal((prev) => (prev ? { ...prev, isSubmitting: true, submitError: null } : null));

        try {
            const res = await fetch("/api/payments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    operationId: paymentModal.operationId,
                    paymentNo: paymentModal.paymentNo,
                    type: "payment",
                    amount: amountNum,
                    paymentMethod: paymentModal.paymentMethod,
                    paymentDate: new Date(paymentModal.paymentDate),
                    purchaseId: purchase._id,
                    supplierId: purchase.supplierId,
                    referenceNo: paymentModal.referenceNo.trim() || undefined,
                    notes: paymentModal.notes.trim() || undefined,
                    status: "completed",
                }),
            });

            const data = await res.json();
            if (res.ok && data.success) {
                setPaymentModal(null);
                setRefreshKey((k) => k + 1);
            } else {
                setPaymentModal((prev) =>
                    prev
                        ? {
                              ...prev,
                              isSubmitting: false,
                              submitError: data.message || "Failed to record payment",
                          }
                        : null
                );
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Network error. Please try again.";
            setPaymentModal((prev) =>
                prev
                    ? {
                          ...prev,
                          isSubmitting: false,
                          submitError: msg,
                      }
                    : null
            );
        }
    }

    const isTemporary = isTemporaryPurchaseId(purchase?._id);
    const isUnsynced = purchase?.syncStatus !== "SYNCED";

    const canRecordPayment = Boolean(
        purchase &&
        !isTemporary &&
        !isUnsynced &&
        (purchase.dueAmount ?? 0) > 0 &&
        purchase.status === "received"
    );

    return (
        <AppShell>
            <main className="flex max-w-4xl flex-col gap-4">
                <Link href="/purchases" className="text-sm underline">
                    ← Purchases
                </Link>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading purchase bill...</p>
                ) : !purchase ? (
                    <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                        {error || "Purchase not found."}
                    </div>
                ) : (
                    <>
                        {isTemporary && (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                                <strong>Provisional offline bill:</strong> This purchase was recorded offline ({purchase._id}). It will be synchronized with the server when online connection is active.
                            </div>
                        )}

                        {purchase.syncStatus === "NEEDS_ATTENTION" && (
                            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                                <strong>Synchronization conflict:</strong> {purchase.errorMessage || "This purchase requires attention before it can be applied to the server."}
                            </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h1 className="text-2xl font-semibold tracking-tight">
                                    Bill {purchase.supplierInvoiceNo || purchase.purchaseNo}
                                    {purchase.status === "cancelled" ? (
                                        <span className="text-base font-normal text-destructive"> (voided)</span>
                                    ) : null}
                                </h1>

                                <p className="text-sm mt-0.5">
                                    <span className="font-medium">{purchase.supplierSnapshot?.name || "Supplier"}</span>
                                    {isTemporarySupplierCode(purchase.supplierSnapshot?.supplierCode) && (
                                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                                            (Pending supplier)
                                        </span>
                                    )}
                                    {" · bill date "}
                                    {purchase.purchaseDate
                                        ? new Date(purchase.purchaseDate).toISOString().slice(0, 10)
                                        : "—"}
                                    {purchase.notes ? ` · ${purchase.notes}` : ""}
                                </p>
                            </div>

                            {canRecordPayment && (
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={handleOpenPaymentModal}
                                    className="gap-1.5"
                                >
                                    Record Payment
                                </Button>
                            )}

                            {isUnsynced && (
                                <span className="text-xs text-muted-foreground italic">
                                    (Payments can be recorded once synchronized online)
                                </span>
                            )}
                        </div>

                        <div className="table-scroll">
                            <table className="w-full text-sm" aria-label="Bill lines">
                                <thead className="border-b bg-muted/40 text-left">
                                    <tr>
                                        <th className="p-2 font-medium">#</th>
                                        <th className="p-2 font-medium">Item</th>
                                        <th className="p-2 text-right font-medium">Qty</th>
                                        <th className="p-2 text-right font-medium">Price before GST</th>
                                        <th className="p-2 text-right font-medium">GST</th>
                                        <th className="p-2 text-right font-medium">Line total</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {(purchase.items || []).map((item, idx) => (
                                        <tr key={idx}>
                                            <td className="p-2">{idx + 1}</td>
                                            <td className="p-2">
                                                {item.productSnapshot?.name || "Item"}{" "}
                                                <span className="text-muted-foreground">
                                                    {item.productSnapshot?.SKU ? `(${item.productSnapshot.SKU})` : ""}
                                                </span>
                                            </td>
                                            <td className="p-2 text-right tabular-nums">
                                                {formatQuantity(item.quantity)} {item.productSnapshot?.unit || ""}
                                            </td>
                                            <td className="p-2 text-right tabular-nums">
                                                {formatPaise(rupeesToPaise(item.unitPrice))}
                                            </td>
                                            <td className="p-2 text-right tabular-nums">
                                                {item.taxRate !== undefined
                                                    ? `${item.taxRate}%`
                                                    : item.tax?.rate !== undefined
                                                    ? `${item.tax.rate}%`
                                                    : "0%"}
                                            </td>
                                            <td className="p-2 text-right tabular-nums font-medium">
                                                {formatPaise(rupeesToPaise(item.total ?? (item.quantity * item.unitPrice)))}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Bill Totals Summary */}
                        <div className="flex flex-col items-end gap-1.5 border-t pt-3 text-sm">
                            {purchase.subtotal !== undefined && (
                                <div className="flex justify-between w-64">
                                    <span className="text-muted-foreground">Subtotal (before tax):</span>
                                    <span className="tabular-nums">{formatPaise(rupeesToPaise(purchase.subtotal))}</span>
                                </div>
                            )}
                            {purchase.taxTotal !== undefined && (
                                <div className="flex justify-between w-64">
                                    <span className="text-muted-foreground">GST:</span>
                                    <span className="tabular-nums">{formatPaise(rupeesToPaise(purchase.taxTotal))}</span>
                                </div>
                            )}
                            {purchase.shippingCost !== undefined && purchase.shippingCost > 0 && (
                                <div className="flex justify-between w-64">
                                    <span className="text-muted-foreground">Shipping:</span>
                                    <span className="tabular-nums">{formatPaise(rupeesToPaise(purchase.shippingCost))}</span>
                                </div>
                            )}
                            <div className="flex justify-between w-64 font-semibold text-base border-t pt-1">
                                <span>Grand Total:</span>
                                <span className="tabular-nums">{formatPaise(rupeesToPaise(purchase.grandTotal))}</span>
                            </div>
                            <div className="flex justify-between w-64 text-muted-foreground">
                                <span>Paid with bill:</span>
                                <span className="tabular-nums">{formatPaise(rupeesToPaise(purchase.paidAmount))}</span>
                            </div>
                            <div className="flex justify-between w-64 font-medium text-amber-700 dark:text-amber-400">
                                <span>Balance due:</span>
                                <span className="tabular-nums">{formatPaise(rupeesToPaise(purchase.dueAmount))}</span>
                            </div>
                        </div>

                        {/* Payments Section */}
                        {payments.length > 0 && (
                            <section className="flex flex-col gap-2 pt-4">
                                <h2 className="text-lg font-semibold tracking-tight">Payments Recorded</h2>
                                <div className="table-scroll">
                                    <table className="w-full text-sm" aria-label="Payments">
                                        <thead className="border-b bg-muted/40 text-left">
                                            <tr>
                                                <th className="p-2 font-medium">Receipt #</th>
                                                <th className="p-2 font-medium">Date</th>
                                                <th className="p-2 font-medium">Method</th>
                                                <th className="p-2 text-right font-medium">Amount</th>
                                                <th className="p-2 font-medium">Ref #</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {payments.map((p) => (
                                                <tr key={p._id || p.paymentNo}>
                                                    <td className="p-2 font-mono text-xs">{p.paymentNo}</td>
                                                    <td className="p-2">
                                                        {p.paymentDate ? new Date(p.paymentDate).toISOString().slice(0, 10) : "—"}
                                                    </td>
                                                    <td className="p-2 capitalize">{p.paymentMethod}</td>
                                                    <td className="p-2 text-right tabular-nums">
                                                        {formatPaise(rupeesToPaise(p.amount))}
                                                    </td>
                                                    <td className="p-2">{p.referenceNo || "—"}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        )}
                    </>
                )}

                {/* Record Payment Modal */}
                {paymentModal?.isOpen && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="pay-modal-title"
                    >
                        <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg">
                            <h2 id="pay-modal-title" className="text-lg font-semibold">
                                Record Bill Payment
                            </h2>
                            <p className="text-sm text-muted-foreground mt-1">
                                Pay against bill {purchase?.supplierInvoiceNo || purchase?.purchaseNo}. Max due: ₹{purchase?.dueAmount}.
                            </p>

                            <form onSubmit={handlePaymentSubmit} className="mt-4 flex flex-col gap-3">
                                {paymentModal.submitError && (
                                    <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive">
                                        {paymentModal.submitError}
                                    </div>
                                )}

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor="pay-amt">Amount (₹)</Label>
                                    <Input
                                        id="pay-amt"
                                        type="number"
                                        step="0.01"
                                        value={paymentModal.amount}
                                        onChange={(e) =>
                                            setPaymentModal((prev) =>
                                                prev ? { ...prev, amount: e.target.value, submitError: null } : null
                                            )
                                        }
                                        required
                                        autoFocus
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor="pay-method">Payment Method</Label>
                                    <select
                                        id="pay-method"
                                        value={paymentModal.paymentMethod}
                                        onChange={(e) =>
                                            setPaymentModal((prev) =>
                                                prev
                                                    ? {
                                                          ...prev,
                                                          paymentMethod: e.target.value as any,
                                                      }
                                                    : null
                                            )
                                        }
                                        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                                    >
                                        <option value="cash">Cash</option>
                                        <option value="bank">Bank Transfer / NEFT</option>
                                        <option value="upi">UPI</option>
                                        <option value="card">Card</option>
                                        <option value="other">Other</option>
                                    </select>
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor="pay-date">Payment Date</Label>
                                    <Input
                                        id="pay-date"
                                        type="date"
                                        value={paymentModal.paymentDate}
                                        onChange={(e) =>
                                            setPaymentModal((prev) =>
                                                prev ? { ...prev, paymentDate: e.target.value } : null
                                            )
                                        }
                                        required
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor="pay-ref">Reference No. (optional)</Label>
                                    <Input
                                        id="pay-ref"
                                        placeholder="e.g. UTR / Transaction ID"
                                        value={paymentModal.referenceNo}
                                        onChange={(e) =>
                                            setPaymentModal((prev) =>
                                                prev ? { ...prev, referenceNo: e.target.value } : null
                                            )
                                        }
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor="pay-notes">Notes (optional)</Label>
                                    <Input
                                        id="pay-notes"
                                        placeholder="Optional payment notes"
                                        value={paymentModal.notes}
                                        onChange={(e) =>
                                            setPaymentModal((prev) =>
                                                prev ? { ...prev, notes: e.target.value } : null
                                            )
                                        }
                                    />
                                </div>

                                <div className="mt-2 flex justify-end gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={handleClosePaymentModal}
                                        disabled={paymentModal.isSubmitting}
                                    >
                                        Cancel
                                    </Button>
                                    <Button type="submit" disabled={paymentModal.isSubmitting}>
                                        {paymentModal.isSubmitting ? "Recording..." : "Confirm Payment"}
                                    </Button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </main>
        </AppShell>
    );
}
