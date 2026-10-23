"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

const REASONS = [
    { value: "damaged", label: "Damaged" },
    { value: "lost", label: "Lost / stolen" },
    { value: "expired", label: "Expired" },
    { value: "found", label: "Found" },
    { value: "count_correction", label: "Count correction" },
    { value: "other", label: "Other" },
];

export default function AdjustStockPage() {
    const router = useRouter();
    const [products, setProducts] = useState<any[]>([]);
    const [productId, setProductId] = useState("");
    const [direction, setDirection] = useState<"out" | "in">("out");
    const [quantity, setQuantity] = useState("");
    const [reason, setReason] = useState("");
    const [note, setNote] = useState("");
    const [warehouse, setWarehouse] = useState("Main Store");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        async function fetchProducts() {
            try {
                const res = await fetch("/api/products");
                const data = await res.json();
                if (data.success) {
                    setProducts(data.products || []);
                }
            } catch (err) {
                console.error("Failed to load products", err);
            }
        }
        fetchProducts();
    }, []);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setSuccess(null);

        const qtyNum = Number(quantity);
        if (!productId) {
            setError("Please select a product.");
            return;
        }
        if (!qtyNum || qtyNum <= 0) {
            setError("Quantity must be greater than zero.");
            return;
        }
        if (!reason) {
            setError("Please choose a reason for the adjustment.");
            return;
        }

        setLoading(true);
        const signedQty = direction === "out" ? -qtyNum : qtyNum;
        const operationId = `adj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        try {
            const res = await fetch("/api/stock-adjustments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    operationId,
                    productId,
                    quantity: signedQty,
                    warehouse: { name: warehouse },
                    reason: note ? `${reason}: ${note}` : reason,
                }),
            });

            const data = await res.json();
            if (data.success) {
                setSuccess("Stock adjustment recorded successfully.");
                setQuantity("");
                setNote("");
                setTimeout(() => {
                    router.push("/inventory");
                }, 1200);
            } else {
                setError(data.message || "Failed to adjust stock");
            }
        } catch (err: any) {
            setError(err.message || "Network error");
        } finally {
            setLoading(false);
        }
    }

    return (
        <AppShell>
            <main className="flex max-w-3xl flex-col gap-4">
                <Link href="/inventory" className="text-sm underline">
                    ← Stock
                </Link>
                <h1 className="text-2xl font-semibold tracking-tight">Adjust stock</h1>
                <p className="text-sm text-muted-foreground">
                    Damaged, lost, expired or found stock, and count corrections. Every adjustment needs a reason and is recorded with your name.
                </p>

                {error && <p className="text-sm text-destructive">{error}</p>}
                {success && <p className="text-sm text-emerald-600 dark:text-emerald-400">{success}</p>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="warehouse">Warehouse / Branch</Label>
                        <Input
                            id="warehouse"
                            value={warehouse}
                            onChange={(e) => setWarehouse(e.target.value)}
                            required
                            className="w-48"
                        />
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="product">Product</Label>
                            <select
                                id="product"
                                value={productId}
                                onChange={(e) => setProductId(e.target.value)}
                                required
                                className={selectClass}
                            >
                                <option value="">Choose a product</option>
                                {products.map((p) => (
                                    <option key={p._id} value={p._id}>
                                        {p.name} ({p.SKU}) — Current: {p.stockQuantity}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="direction">Stock goes</Label>
                            <select
                                id="direction"
                                value={direction}
                                onChange={(e) => setDirection(e.target.value as "out" | "in")}
                                required
                                className={selectClass}
                            >
                                <option value="out">Out (less stock)</option>
                                <option value="in">In (more stock)</option>
                            </select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="quantity">Quantity</Label>
                            <Input
                                id="quantity"
                                value={quantity}
                                onChange={(e) => setQuantity(e.target.value)}
                                required
                                inputMode="decimal"
                                placeholder="0"
                                className="w-28"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="reasonCode">Reason</Label>
                            <select
                                id="reasonCode"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                required
                                className={selectClass}
                            >
                                <option value="">Choose a reason</option>
                                {REASONS.map((r) => (
                                    <option key={r.value} value={r.value}>
                                        {r.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <Label htmlFor="note">Note (optional)</Label>
                        <Input
                            id="note"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Additional details..."
                            maxLength={500}
                        />
                    </div>

                    <Button type="submit" disabled={loading} className="self-start">
                        {loading ? "Saving..." : "Save adjustment"}
                    </Button>
                </form>
            </main>
        </AppShell>
    );
}
