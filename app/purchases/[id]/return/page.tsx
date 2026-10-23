"use client";

import { use, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";

interface PurchaseItem {
  productId: string;
  productSnapshot?: {
    name: string;
    SKU: string;
    unit?: string;
  };
  quantity: number;
  unitPrice: number;
  total: number;
}

interface PurchaseBill {
  _id: string;
  purchaseNo?: string;
  supplierInvoiceNo?: string;
  supplierId?: string;
  supplierSnapshot?: {
    name: string;
  };
  warehouse?: {
    name: string;
  };
  items: PurchaseItem[];
  grandTotal: number;
}

export default function PurchaseReturnPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const { id } = use(params);
  const [purchase, setPurchase] = useState<PurchaseBill | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    async function loadPurchase() {
      try {
        setLoading(true);
        const res = await fetch(`/api/purchases/${id}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success && data.purchase) {
          setPurchase(data.purchase);
          // Initialize return quantities
          const initialQtys: Record<string, number> = {};
          (data.purchase.items || []).forEach((item: PurchaseItem) => {
            initialQtys[item.productId] = 0;
          });
          setReturnQtys(initialQtys);
        } else {
          setError(data?.message || "Failed to load purchase bill.");
        }
      } catch {
        setError("Unable to connect to the server.");
      } finally {
        setLoading(false);
      }
    }
    loadPurchase();
  }, [id]);

  const handleReturnSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!purchase) return;

    const itemsToReturn = Object.entries(returnQtys)
      .filter(([, qty]) => qty > 0)
      .map(([productId, quantity]) => ({
        productId,
        quantity,
      }));

    if (itemsToReturn.length === 0) {
      setError("Please specify a return quantity of at least 1 item.");
      return;
    }

    if (!reason.trim()) {
      setError("Please provide a reason for the return.");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        const returnNo = `PR-${Date.now().toString().slice(-6)}`;
        const res = await fetch("/api/purchase-returns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            purchaseReturnNo: returnNo,
            purchaseId: id,
            warehouse: { name: purchase.warehouse?.name || "Main Store" },
            items: itemsToReturn,
            reason: reason.trim(),
            operationId: crypto.randomUUID(),
          }),
        });

        const data = await res.json().catch(() => null);

        if (res.ok && (data?.success || data?.purchaseReturn)) {
          router.push(`/purchases/${id}?returned=1`);
        } else {
          setError(data?.message || "Failed to submit purchase return.");
        }
      } catch {
        setError("Unable to submit return. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <Link href={`/purchases/${id}`} className="text-sm underline">
          ← Back to purchase bill
        </Link>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading purchase bill...</p>
        ) : error && !purchase ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : !purchase ? (
          <p className="text-sm text-muted-foreground">Purchase bill not found.</p>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Return goods to supplier
              </h1>
              <p className="text-xs text-muted-foreground">
                Bill {purchase.supplierInvoiceNo || purchase.purchaseNo} · Vendor:{" "}
                <span className="font-medium text-foreground">
                  {purchase.supplierSnapshot?.name || "Supplier"}
                </span>
              </p>
            </div>

            {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}

            <form
              onSubmit={handleReturnSubmit}
              className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
            >
              <h2 className="font-semibold">Select items &amp; quantities to return</h2>
              <div className="table-scroll">
                <table className="w-full text-sm" aria-label="Items to return">
                  <thead className="border-b bg-muted/40 text-left">
                    <tr>
                      <th className="p-2.5 font-medium">Item</th>
                      <th className="p-2.5 text-right font-medium">Purchased</th>
                      <th className="p-2.5 text-right font-medium">Unit cost</th>
                      <th className="p-2.5 text-right font-medium w-32">Return qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(purchase.items || []).map((item) => (
                      <tr key={item.productId}>
                        <td className="p-2.5">
                          <p className="font-medium">
                            {item.productSnapshot?.name || "Product"}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono">
                            {item.productSnapshot?.SKU || ""}
                          </p>
                        </td>
                        <td className="p-2.5 text-right tabular-nums">
                          {formatQuantity(item.quantity)}{" "}
                          {item.productSnapshot?.unit || ""}
                        </td>
                        <td className="p-2.5 text-right tabular-nums">
                          {formatPaise(rupeesToPaise(item.unitPrice))}
                        </td>
                        <td className="p-2.5 text-right">
                          <Input
                            type="number"
                            min="0"
                            max={item.quantity}
                            step="any"
                            value={returnQtys[item.productId] || ""}
                            onChange={(e) => {
                              const val = Math.max(0, Math.min(item.quantity, Number(e.target.value) || 0));
                              setReturnQtys((prev) => ({
                                ...prev,
                                [item.productId]: val,
                              }));
                            }}
                            className="h-8 text-right tabular-nums w-24 ml-auto"
                            placeholder="0"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="return-reason">Reason for return *</Label>
                <Input
                  id="return-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Damaged goods, expired stock, wrong product shipped"
                  required
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Processing return..." : "Submit purchase return"}
                </Button>
                <Link
                  href={`/purchases/${id}`}
                  className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted"
                >
                  Cancel
                </Link>
              </div>
            </form>
          </>
        )}
      </main>
    </AppShell>
  );
}
