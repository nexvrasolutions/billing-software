"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { formatPaise, rupeesToPaise } from "@/lib/money";

interface PurchaseItem {
    _id: string;
    purchaseNo: string;
    supplierInvoiceNo?: string;
    supplierSnapshot?: {
        name: string;
        supplierCode: string;
    };
    purchaseDate: string;
    grandTotal: number;
    paidAmount: number;
    paymentStatus: string;
    status: string;
}

export default function PurchasesPage() {
    const [purchases, setPurchases] = useState<PurchaseItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchPurchases() {
            try {
                const res = await fetch("/api/purchases");
                const data = await res.json();
                if (data.success) {
                    setPurchases(data.purchases || []);
                } else {
                    setError(data.message || "Failed to load purchases");
                }
            } catch (err: any) {
                setError(err.message || "Failed to load purchases");
            } finally {
                setLoading(false);
            }
        }
        fetchPurchases();
    }, []);

    return (
        <AppShell>
            <main className="flex max-w-4xl flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                        <Link href="/suppliers" className="underline">
                            Suppliers
                        </Link>
                        <Link href="/purchases/new" className="action-primary">
                            New purchase
                        </Link>
                    </div>
                </div>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading purchases...</p>
                ) : error ? (
                    <p className="text-sm text-destructive">{error}</p>
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
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {purchases.map((p) => {
                                    const dateStr = p.purchaseDate
                                        ? new Date(p.purchaseDate).toISOString().slice(0, 10)
                                        : "—";
                                    return (
                                        <tr key={p._id}>
                                            <td className="p-2">{dateStr}</td>
                                            <td className="p-2">{p.supplierSnapshot?.name || "Supplier"}</td>
                                            <td className="p-2">
                                                <Link href={`/purchases/${p._id}`} className="underline font-medium">
                                                    {p.supplierInvoiceNo || p.purchaseNo}
                                                </Link>
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
