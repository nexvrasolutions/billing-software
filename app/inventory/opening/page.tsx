"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatQuantity } from "@/lib/quantity";

interface ProductItem {
  _id: string;
  name: string;
  SKU: string;
  stockQuantity?: number;
  unit?: string;
}

export default function OpeningStockPage() {
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [warehouseName, setWarehouseName] = useState("Main Store");
  const [reason, setReason] = useState("Initial opening stock");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadProducts = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/products", { credentials: "same-origin" });
      const data = await res.json().catch(() => null);

      if (data?.success && Array.isArray(data.products)) {
        setProducts(data.products);
        if (data.products.length > 0 && !selectedProductId) {
          setSelectedProductId(data.products[0]._id);
        }
      } else {
        setError(data?.message || "Failed to load products");
      }
    } catch {
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    async function loadInitial() {
      try {
        const res = await fetch("/api/products", { credentials: "same-origin" });
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (data?.success && Array.isArray(data.products)) {
          setProducts(data.products);
          if (data.products.length > 0) {
            setSelectedProductId(data.products[0]._id);
          }
        } else {
          setError(data?.message || "Failed to load products");
        }
      } catch {
        if (active) setError("Unable to connect to the server.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadInitial();
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(quantity);
    if (!selectedProductId) {
      setError("Please select a product.");
      return;
    }
    if (isNaN(qty) || qty === 0) {
      setError("Opening quantity must be a non-zero number.");
      return;
    }

    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        const operationId = crypto.randomUUID();
        const res = await fetch("/api/stock-adjustments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            operationId,
            productId: selectedProductId,
            quantity: qty,
            warehouse: { name: warehouseName.trim() || "Main Store" },
            reason: reason.trim() || "Initial opening stock",
          }),
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          setMessage(`Opening stock of ${qty} recorded successfully.`);
          setQuantity("");
          loadProducts();
        } else {
          setError(data?.message || "Failed to record opening stock.");
        }
      } catch {
        setError("Unable to connect to the server. Please try again.");
      }
    });
  };

  const selectedProduct = products.find((p) => p._id === selectedProductId);

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Opening stock</h1>
            <p className="text-xs text-muted-foreground">
              Record initial stock quantities for products at the start of operations or accounting periods.
            </p>
          </div>
          <Link href="/inventory" className="text-sm underline">
            View current stock →
          </Link>
        </div>

        {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
        {message && <p role="status" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{message}</p>}

        {/* Opening Stock Entry Form */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
        >
          <h2 className="font-semibold">Record opening stock entry</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="stock-product">Select product *</Label>
              {loading ? (
                <p className="text-xs text-muted-foreground">Loading products...</p>
              ) : (
                <select
                  id="stock-product"
                  value={selectedProductId}
                  onChange={(e) => setSelectedProductId(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  required
                >
                  {products.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name} ({p.SKU}) — Current stock: {formatQuantity(p.stockQuantity ?? 0)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stock-qty">
                Quantity to add * {selectedProduct?.unit ? `(${selectedProduct.unit})` : ""}
              </Label>
              <Input
                id="stock-qty"
                type="number"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 50"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stock-wh">Warehouse / Store location</Label>
              <Input
                id="stock-wh"
                value={warehouseName}
                onChange={(e) => setWarehouseName(e.target.value)}
                placeholder="Main Store"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="stock-reason">Reason</Label>
              <Input
                id="stock-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Initial opening stock count"
                required
              />
            </div>
          </div>

          <div>
            <Button type="submit" disabled={isPending || loading || products.length === 0}>
              {isPending ? "Recording adjustment..." : "Post opening stock"}
            </Button>
          </div>
        </form>

        {/* Existing Products Preview */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Current stock overview</h2>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading inventory...</p>
          ) : products.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No products found.{" "}
              <Link href="/catalog/products" className="underline">
                Create products first
              </Link>
              .
            </p>
          ) : (
            <div className="table-scroll">
              <table className="w-full text-sm" aria-label="Stock overview">
                <thead className="border-b bg-muted/40 text-left">
                  <tr>
                    <th className="p-2.5 font-medium">Product</th>
                    <th className="p-2.5 font-medium">SKU</th>
                    <th className="p-2.5 text-right font-medium">Current on hand</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {products.slice(0, 15).map((p) => (
                    <tr key={p._id} className="hover:bg-muted/30">
                      <td className="p-2.5 font-medium">{p.name}</td>
                      <td className="p-2.5 text-muted-foreground font-mono text-xs">{p.SKU}</td>
                      <td className="p-2.5 text-right tabular-nums font-semibold">
                        {formatQuantity(p.stockQuantity ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}
