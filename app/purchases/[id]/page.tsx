"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";

export default function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const [purchase, setPurchase] = useState<any | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchPurchase() {
            try {
                const res = await fetch(`/api/purchases/${id}`);
                const data = await res.json();
                if (data.success && data.purchase) {
                    setPurchase(data.purchase);
                } else {
                    setError(data.message || "Failed to load purchase");
                }
            } catch (err: any) {
                setError(err.message || "Failed to load purchase");
            } finally {
                setLoading(false);
            }
        }
        fetchPurchase();
    }, [id]);

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
                        <h1 className="text-2xl font-semibold tracking-tight">
                            Bill {purchase.supplierInvoiceNo || purchase.purchaseNo}
                            {purchase.status === "cancelled" ? (
                                <span className="text-base font-normal text-destructive"> (voided)</span>
                            ) : null}
                        </h1>

                        <p className="text-sm">
                            <span className="font-medium">{purchase.supplierSnapshot?.name || "Supplier"}</span> · bill date{" "}
                            {purchase.purchaseDate ? new Date(purchase.purchaseDate).toISOString().slice(0, 10) : "—"}
                            {purchase.notes ? ` · ${purchase.notes}` : ""}
                        </p>

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
                                    {(purchase.items || []).map((item: any, idx: number) => (
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
                                <dt className="text-muted-foreground">Paid with bill</dt>
                                <dd className="tabular-nums">{formatPaise(rupeesToPaise(purchase.paidAmount || 0))}</dd>
                            </div>
                            <div className="flex justify-between p-2 border-t">
                                <dt className="text-muted-foreground">Due Amount</dt>
                                <dd className="tabular-nums font-medium text-amber-600 dark:text-amber-400">
                                    {formatPaise(rupeesToPaise(purchase.dueAmount || 0))}
                                </dd>
                            </div>
                        </dl>
                    </>
                )}
            </main>
        </AppShell>
    );
}
