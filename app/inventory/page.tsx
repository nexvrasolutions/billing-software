"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";

interface ProductItem {
    _id: string;
    name: string;
    SKU: string;
    barcode?: string;
    purchasePrice?: number;
    sellingPrice: number;
    stockQuantity: number;
    status: "active" | "inactive";
}

export default function InventoryPage() {
    const [products, setProducts] = useState<ProductItem[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchStock() {
            try {
                const res = await fetch("/api/products?includeCost=true");
                const data = await res.json();
                if (data.success) {
                    setProducts(data.products || []);
                } else {
                    setError(data.message || "Failed to load inventory");
                }
            } catch (err: any) {
                setError(err.message || "Failed to load inventory");
            } finally {
                setLoading(false);
            }
        }
        fetchStock();
    }, []);

    const filtered = products.filter((p) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
            p.name.toLowerCase().includes(q) ||
            p.SKU.toLowerCase().includes(q) ||
            (p.barcode && p.barcode.toLowerCase().includes(q))
        );
    });

    return (
        <AppShell>
            <main className="flex max-w-5xl flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h1 className="text-2xl font-semibold tracking-tight">Stock</h1>
                    <div className="flex gap-3 text-sm">
                        <Link href="/inventory/adjust" className="underline">
                            Adjust stock
                        </Link>
                    </div>
                </div>

                <div className="flex gap-2">
                    <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search name or SKU"
                        aria-label="Search stock"
                        className="h-8 w-80 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    />
                </div>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading inventory...</p>
                ) : error ? (
                    <p className="text-sm text-destructive">{error}</p>
                ) : filtered.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {searchQuery ? "Nothing found." : "No products yet."}
                    </p>
                ) : (
                    <div className="table-scroll">
                        <table className="w-full text-sm" aria-label="Stock levels">
                            <thead className="border-b bg-muted/40 text-left">
                                <tr>
                                    <th className="p-2 font-medium">Item</th>
                                    <th className="p-2 font-medium">SKU</th>
                                    <th className="p-2 text-right font-medium">Available</th>
                                    <th className="p-2 text-right font-medium">Purchase cost</th>
                                    <th className="p-2 text-right font-medium">Selling price</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {filtered.map((p) => (
                                    <tr key={p._id} aria-label={p.name}>
                                        <td className="p-2">
                                            <Link href={`/catalog/products/${p._id}`} className="underline font-medium">
                                                {p.name}
                                            </Link>
                                            {p.status === "inactive" ? (
                                                <span className="text-muted-foreground"> (archived)</span>
                                            ) : null}
                                        </td>
                                        <td className="p-2 text-muted-foreground">{p.SKU}</td>
                                        <td className="p-2 text-right tabular-nums font-semibold">
                                            {formatQuantity(p.stockQuantity)}
                                        </td>
                                        <td className="p-2 text-right tabular-nums">
                                            {typeof p.purchasePrice === "number"
                                                ? formatPaise(rupeesToPaise(p.purchasePrice))
                                                : "—"}
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
            </main>
        </AppShell>
    );
}
