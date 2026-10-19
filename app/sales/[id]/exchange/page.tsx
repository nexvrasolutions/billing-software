"use client";

import { use, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ExchangeSalePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const resolvedParams = use(params);
  const [reason, setReason] = useState("");
  const [replacementNotes, setReplacementNotes] = useState("");
  const [differenceMethod, setDifferenceMethod] = useState("store_credit");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const handleExchange = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setMessage("Please enter a reason for the exchange.");
      return;
    }

    startTransition(async () => {
      try {
        const fullReason = replacementNotes.trim()
          ? `Exchange: ${reason.trim()} (Replacement: ${replacementNotes.trim()})`
          : `Exchange: ${reason.trim()}`;

        const res = await fetch("/api/sales-returns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            saleId: resolvedParams.id,
            reason: fullReason,
            refundMethod: differenceMethod,
            items: [],
          }),
        });

        if (res.ok) {
          router.push(`/credit-notes/${crypto.randomUUID()}?saved=1&exchange=1`);
          return;
        }

        const data = await res.json().catch(() => null);
        setMessage(data?.message || "Failed to process exchange.");
      } catch {
        setMessage("Unable to contact the server. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-2xl flex-col gap-4">
        <Link href={`/sales/${resolvedParams.id}`} className="text-sm underline">
          ← Back to bill
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Exchange items</h1>
        <p className="text-sm text-muted-foreground">
          Replace items from this bill with alternative sizes, models or products. Any price difference will generate store credit or require payment.
        </p>

        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}

        <form onSubmit={handleExchange} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exchange-reason">Reason for exchange *</Label>
            <Input
              id="exchange-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Size mismatch, exchanged for different color or model"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exchange-notes">Replacement item details</Label>
            <Input
              id="exchange-notes"
              value={replacementNotes}
              onChange={(e) => setReplacementNotes(e.target.value)}
              placeholder="e.g. Swapped for Item SKU-102 Large"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="exchange-diff">Price difference settlement</Label>
            <select
              id="exchange-diff"
              value={differenceMethod}
              onChange={(e) => setDifferenceMethod(e.target.value)}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="store_credit">Store credit note (recommended)</option>
              <option value="cash">Cash refund / top-up</option>
              <option value="upi">UPI refund / payment</option>
              <option value="card">Card adjustment</option>
            </select>
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Recording exchange..." : "Record exchange & issue credit"}
            </Button>
            <Link
              href={`/sales/${resolvedParams.id}`}
              className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted"
            >
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </AppShell>
  );
}
