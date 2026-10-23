"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { formatPaise, rupeesToPaise } from "@/lib/money";

const VIEWS = [
    { id: "sales", label: "Sales by day", group: "Sales" },
    { id: "by_item", label: "By item", group: "Sales" },
    { id: "payments", label: "Money in and out", group: "Money" },
    { id: "low_stock", label: "Low stock", group: "Stock" },
    { id: "tax", label: "GST summary", group: "GST" },
] as const;

export default function ReportsPage() {
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = `${today.slice(0, 8)}01`;

    const [activeView, setActiveView] = useState<string>("sales");
    const [from, setFrom] = useState(firstOfMonth);
    const [to, setTo] = useState(today);

    const [sales, setSales] = useState<any[]>([]);
    const [products, setProducts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function loadReportData() {
            try {
                const [salesRes, prodRes] = await Promise.all([
                    fetch("/api/sales"),
                    fetch("/api/products"),
                ]);
                const salesData = await salesRes.json();
                const prodData = await prodRes.json();
                if (salesData.success) setSales(salesData.sales || []);
                if (prodData.success) setProducts(prodData.products || []);
            } catch (err) {
                console.error("Failed to load report data", err);
            } finally {
                setLoading(false);
            }
        }
        loadReportData();
    }, []);

    const [canViewAudit, setCanViewAudit] = useState(false);

    useEffect(() => {
        async function checkAuditAccess() {
            try {
                const res = await fetch("/api/auth/me");
                if (res.ok) {
                    const data = await res.json();
                    const isOwner = Boolean(data.user?.isOwner);
                    const permissions: string[] = data.permissions || [];
                    if (isOwner || permissions.includes("auditLogs.read")) {
                        setCanViewAudit(true);
                    }
                }
            } catch {
                // Ignore error
            }
        }
        checkAuditAccess();
    }, []);

    // Filter sales by date range
    const filteredSales = sales.filter((s) => {
        const d = s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : "";
        return d >= from && d <= to;
    });

    const netSales = filteredSales.reduce((sum, s) => sum + (s.grandTotal || 0), 0);
    const taxTotal = filteredSales.reduce((sum, s) => sum + (s.taxTotal || 0), 0);

    return (
        <AppShell>
            <main className="flex max-w-5xl flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
                    {canViewAudit && (
                        <Link href="/reports/audit" className="text-sm underline">
                            Audit log
                        </Link>
                    )}
                </div>

                {/* View switcher nav */}
                <div className="flex flex-wrap gap-1 rounded-lg border p-1 bg-muted/20 text-xs">
                    {VIEWS.map((v) => (
                        <button
                            key={v.id}
                            type="button"
                            onClick={() => setActiveView(v.id)}
                            className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                                activeView === v.id
                                    ? "bg-primary text-primary-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {v.label}
                        </button>
                    ))}
                </div>

                {/* Date range filter */}
                <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-sm">
                        From
                        <input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        To
                        <input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                </div>

                {/* Summary Card */}
                <dl className="totals max-w-md rounded-lg border text-sm" aria-label="Report summary">
                    <div className="flex justify-between p-2.5">
                        <dt className="text-muted-foreground">Net sales ({from} to {to})</dt>
                        <dd className="tabular-nums font-semibold">{formatPaise(rupeesToPaise(netSales))}</dd>
                    </div>
                    <div className="flex justify-between p-2.5 border-t">
                        <dt className="text-muted-foreground">Total bills</dt>
                        <dd className="tabular-nums font-medium">{filteredSales.length}</dd>
                    </div>
                    <div className="flex justify-between p-2.5 border-t">
                        <dt className="text-muted-foreground">Tax collected (GST)</dt>
                        <dd className="tabular-nums font-medium">{formatPaise(rupeesToPaise(taxTotal))}</dd>
                    </div>
                </dl>

                {/* Table representation based on active view */}
                {activeView === "sales" && (
                    <div className="table-scroll">
                        <table className="w-full text-sm" aria-label="Sales by day">
                            <thead className="border-b bg-muted/40 text-left">
                                <tr>
                                    <th className="p-2 font-medium">Bill no.</th>
                                    <th className="p-2 font-medium">Date</th>
                                    <th className="p-2 font-medium">Customer</th>
                                    <th className="p-2 text-right font-medium">Tax</th>
                                    <th className="p-2 text-right font-medium">Total</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {filteredSales.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="p-3 text-center text-muted-foreground">
                                            No sales in this period.
                                        </td>
                                    </tr>
                                ) : (
                                    filteredSales.map((s) => (
                                        <tr key={s._id}>
                                            <td className="p-2 font-medium">
                                                <Link href={`/sales/${s._id}`} className="underline">
                                                    {s.billNumber}
                                                </Link>
                                            </td>
                                            <td className="p-2">
                                                {s.saleDate ? new Date(s.saleDate).toISOString().slice(0, 10) : "—"}
                                            </td>
                                            <td className="p-2">{s.customerSnapshot?.name || "Walk-in"}</td>
                                            <td className="p-2 text-right tabular-nums">
                                                {formatPaise(rupeesToPaise(s.taxTotal || 0))}
                                            </td>
                                            <td className="p-2 text-right tabular-nums font-medium">
                                                {formatPaise(rupeesToPaise(s.grandTotal || 0))}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                )}

                {activeView === "low_stock" && (
                    <div className="table-scroll">
                        <table className="w-full text-sm" aria-label="Low stock">
                            <thead className="border-b bg-muted/40 text-left">
                                <tr>
                                    <th className="p-2 font-medium">Item</th>
                                    <th className="p-2 font-medium">SKU</th>
                                    <th className="p-2 text-right font-medium">Stock remaining</th>
                                    <th className="p-2 text-right font-medium">Selling price</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {products.filter((p) => p.stockQuantity < 5).map((p) => (
                                    <tr key={p._id}>
                                        <td className="p-2 font-medium">{p.name}</td>
                                        <td className="p-2 text-muted-foreground">{p.SKU}</td>
                                        <td className="p-2 text-right tabular-nums font-bold text-amber-600 dark:text-amber-400">
                                            {p.stockQuantity}
                                        </td>
                                        <td className="p-2 text-right tabular-nums">
                                            {formatPaise(rupeesToPaise(p.sellingPrice))}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {activeView === "tax" && (
                    <div className="table-scroll">
                        <table className="w-full text-sm" aria-label="GST summary">
                            <thead className="border-b bg-muted/40 text-left">
                                <tr>
                                    <th className="p-2 font-medium">Rate</th>
                                    <th className="p-2 text-right font-medium">Taxable value</th>
                                    <th className="p-2 text-right font-medium">CGST</th>
                                    <th className="p-2 text-right font-medium">SGST</th>
                                    <th className="p-2 text-right font-medium">Total tax</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                <tr>
                                    <td className="p-2 font-medium">Standard (GST)</td>
                                    <td className="p-2 text-right tabular-nums">{formatPaise(rupeesToPaise(netSales - taxTotal))}</td>
                                    <td className="p-2 text-right tabular-nums">{formatPaise(rupeesToPaise(taxTotal / 2))}</td>
                                    <td className="p-2 text-right tabular-nums">{formatPaise(rupeesToPaise(taxTotal / 2))}</td>
                                    <td className="p-2 text-right tabular-nums font-semibold">{formatPaise(rupeesToPaise(taxTotal))}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                )}
            </main>
        </AppShell>
    );
}
