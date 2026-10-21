"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";

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
        name: string;
        supplierCode?: string;
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
    notes?: string;
    items?: Array<{
        productId: string;
        productSnapshot?: {
            name: string;
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
        total: number;
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
    const [paymentModal, setPaymentModal] = useState<PaymentModalState | null>(null);

    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        let isCancelled = false;

        async function fetchPurchase() {
            try {
                const res = await fetch(`/api/purchases/${id}`);
                const data = await res.json();
                if (isCancelled) return;
                if (data.success && data.purchase) {
                    setPurchase(data.purchase);
                    setPayments(data.payments || []);
                } else {
                    setError(data.message || "Failed to load purchase");
                }
            } catch (err: unknown) {
                if (isCancelled) return;
                const msg = err instanceof Error ? err.message : "Failed to load purchase";
                setError(msg);
            } finally {
                if (!isCancelled) {
                    setLoading(false);
                }
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

        // Set submitting state while keeping operationId and paymentNo stable!
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

    const canRecordPayment = Boolean(
        purchase &&
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
                    <p className="text-sm text-destructive">{error || "Purchase not found."}</p>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h1 className="text-2xl font-semibold tracking-tight">
                                    Bill {purchase.supplierInvoiceNo || purchase.purchaseNo}
                                    {purchase.status === "cancelled" ? (
                                        <span className="text-base font-normal text-destructive"> (voided)</span>
                                    ) : null}
                                </h1>

                                <p className="text-sm mt-0.5">
                                    <span className="font-medium">{purchase.supplierSnapshot?.name || "Supplier"}</span> · bill date{" "}
                                    {purchase.purchaseDate ? new Date(purchase.purchaseDate).toISOString().slice(0, 10) : "—"}
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
                                                {item.tax?.rate ? `${item.tax.rate}%` : "0%"}
                                            </td>
                                            <td className="p-2 text-right tabular-nums font-medium">
                                                {formatPaise(rupeesToPaise(item.total))}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <dl className="totals max-w-sm rounded-lg border text-sm self-end" aria-label="Bill totals">
                            <div className="flex justify-between p-2">
                                <dt className="text-muted-foreground">Subtotal</dt>
                                <dd className="tabular-nums font-medium">{formatPaise(rupeesToPaise(purchase.subtotal || 0))}</dd>
                            </div>
                            <div className="flex justify-between p-2 border-t">
                                <dt className="text-muted-foreground">Tax Total</dt>
                                <dd className="tabular-nums font-medium">{formatPaise(rupeesToPaise(purchase.taxTotal || 0))}</dd>
                            </div>
                            <div className="flex justify-between p-2 border-t bg-muted/20">
                                <dt className="font-semibold">Grand Total</dt>
                                <dd className="tabular-nums font-semibold text-base">{formatPaise(rupeesToPaise(purchase.grandTotal || 0))}</dd>
                            </div>
                            <div className="flex justify-between p-2 border-t">
                                <dt className="text-muted-foreground">Total paid</dt>
                                <dd className="tabular-nums">{formatPaise(rupeesToPaise(purchase.paidAmount || 0))}</dd>
                            </div>
                            <div className="flex justify-between p-2 border-t">
                                <dt className="text-muted-foreground">Due Amount</dt>
                                <dd className={`tabular-nums font-medium ${purchase.dueAmount > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                                    {formatPaise(rupeesToPaise(purchase.dueAmount || 0))}
                                    {purchase.dueAmount === 0 ? " (Settled)" : ""}
                                </dd>
                            </div>
                        </dl>

                        {/* Payment history */}
                        <section className="flex flex-col gap-3 mt-4 border-t pt-4" aria-label="Payment history">
                            <div className="flex items-center justify-between">
                                <h2 className="text-base font-semibold">Payment history</h2>
                                <span className="text-xs text-muted-foreground">
                                    {payments.length} record{payments.length === 1 ? "" : "s"}
                                </span>
                            </div>

                            {payments.length === 0 ? (
                                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                                    No payment transactions recorded for this bill yet.
                                    {purchase.paidAmount > 0 ? " (Initial amount was paid directly with the bill.)" : ""}
                                </div>
                            ) : (
                                <div className="table-scroll">
                                    <table className="w-full text-sm" aria-label="Purchase payments">
                                        <thead className="border-b bg-muted/40 text-left">
                                            <tr>
                                                <th className="p-2.5 font-medium">Date</th>
                                                <th className="p-2.5 font-medium">Payment #</th>
                                                <th className="p-2.5 font-medium">Method</th>
                                                <th className="p-2.5 font-medium">Reference</th>
                                                <th className="p-2.5 font-medium">Notes</th>
                                                <th className="p-2.5 text-right font-medium">Amount</th>
                                                <th className="p-2.5 text-right font-medium">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {payments.map((p) => {
                                                const dateStr = p.paymentDate
                                                    ? new Date(p.paymentDate).toLocaleDateString("en-IN", {
                                                          dateStyle: "medium",
                                                      })
                                                    : "—";
                                                return (
                                                    <tr key={p._id || p.paymentNo} className="hover:bg-muted/30">
                                                        <td className="p-2.5 text-muted-foreground tabular-nums">{dateStr}</td>
                                                        <td className="p-2.5 font-mono text-xs font-medium">{p.paymentNo}</td>
                                                        <td className="p-2.5 capitalize">{p.paymentMethod || "—"}</td>
                                                        <td className="p-2.5 text-muted-foreground">{p.referenceNo || "—"}</td>
                                                        <td className="p-2.5 text-muted-foreground max-w-[180px] truncate" title={p.notes}>
                                                            {p.notes || "—"}
                                                        </td>
                                                        <td className="p-2.5 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                                                            {formatPaise(rupeesToPaise(p.amount || 0))}
                                                        </td>
                                                        <td className="p-2.5 text-right">
                                                            <span className="inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 capitalize">
                                                                {p.status || "completed"}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>
                    </>
                )}
            </main>

            {/* Record Payment Modal */}
            {paymentModal && purchase && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="pay-modal-title"
                    aria-describedby="pay-modal-desc"
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in"
                    onKeyDown={(e) => {
                        if (e.key === "Escape" && !paymentModal.isSubmitting) {
                            handleClosePaymentModal();
                        }
                    }}
                >
                    <div className="relative w-full max-w-md rounded-xl border bg-background p-6 shadow-2xl">
                        <h2 id="pay-modal-title" className="text-lg font-semibold tracking-tight">
                            Record Supplier Payment
                        </h2>
                        <p id="pay-modal-desc" className="mt-1 text-sm text-muted-foreground">
                            Bill <span className="font-medium text-foreground">{purchase.supplierInvoiceNo || purchase.purchaseNo}</span>
                            {" · "}
                            Due: <span className="font-semibold text-amber-600 dark:text-amber-400">{formatPaise(rupeesToPaise(purchase.dueAmount || 0))}</span>
                        </p>

                        <form onSubmit={handlePaymentSubmit} className="mt-4 flex flex-col gap-3">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="pay-amount">
                                    Amount (₹) <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="pay-amount"
                                    type="number"
                                    step="0.01"
                                    min="0.01"
                                    max={purchase.dueAmount}
                                    required
                                    disabled={paymentModal.isSubmitting}
                                    value={paymentModal.amount}
                                    onChange={(e) =>
                                        setPaymentModal((prev) => (prev ? { ...prev, amount: e.target.value } : null))
                                    }
                                />
                                <span className="text-[11px] text-muted-foreground">
                                    Max payable: {formatPaise(rupeesToPaise(purchase.dueAmount || 0))}
                                </span>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="pay-method">
                                    Payment method <span className="text-destructive">*</span>
                                </Label>
                                <select
                                    id="pay-method"
                                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                    value={paymentModal.paymentMethod}
                                    disabled={paymentModal.isSubmitting}
                                    onChange={(e) =>
                                        setPaymentModal((prev) =>
                                            prev
                                                ? {
                                                      ...prev,
                                                      paymentMethod: e.target.value as PaymentModalState["paymentMethod"],
                                                  }
                                                : null
                                        )
                                    }
                                >
                                    <option value="cash">Cash</option>
                                    <option value="upi">UPI</option>
                                    <option value="bank">Bank transfer</option>
                                    <option value="card">Card</option>
                                    <option value="other">Other</option>
                                </select>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="pay-date">
                                    Payment date <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="pay-date"
                                    type="date"
                                    required
                                    disabled={paymentModal.isSubmitting}
                                    value={paymentModal.paymentDate}
                                    onChange={(e) =>
                                        setPaymentModal((prev) => (prev ? { ...prev, paymentDate: e.target.value } : null))
                                    }
                                />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="pay-ref">
                                    Reference # / Transaction ID <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                                </Label>
                                <Input
                                    id="pay-ref"
                                    placeholder="e.g. UTR / Cheque / Transaction ref"
                                    maxLength={100}
                                    disabled={paymentModal.isSubmitting}
                                    value={paymentModal.referenceNo}
                                    onChange={(e) =>
                                        setPaymentModal((prev) => (prev ? { ...prev, referenceNo: e.target.value } : null))
                                    }
                                />
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="pay-notes">
                                    Notes <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                                </Label>
                                <Input
                                    id="pay-notes"
                                    placeholder="Optional remarks"
                                    maxLength={200}
                                    disabled={paymentModal.isSubmitting}
                                    value={paymentModal.notes}
                                    onChange={(e) =>
                                        setPaymentModal((prev) => (prev ? { ...prev, notes: e.target.value } : null))
                                    }
                                />
                            </div>

                            {paymentModal.submitError && (
                                <div
                                    role="alert"
                                    className="rounded-md bg-destructive/10 p-3 text-xs font-medium text-destructive"
                                >
                                    {paymentModal.submitError}
                                </div>
                            )}

                            <div className="mt-2 flex items-center justify-end gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={paymentModal.isSubmitting}
                                    onClick={handleClosePaymentModal}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={paymentModal.isSubmitting}
                                >
                                    {paymentModal.isSubmitting ? "Recording..." : "Record Payment"}
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </AppShell>
    );
}

