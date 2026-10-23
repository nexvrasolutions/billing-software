"use client";

import { use, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise } from "@/lib/money";

export default function ReturnSalePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const resolvedParams = use(params);
  const [reason, setReason] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const handleReturn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setMessage("Please enter a reason for the return.");
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/sales-returns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            saleId: resolvedParams.id,
            reason,
            refundMethod,
            items: [],
          }),
        });

        if (res.ok) {
          router.push(`/credit-notes/${crypto.randomUUID()}?saved=1`);
          return;
        }

        const data = await res.json().catch(() => null);
        setMessage(data?.message || "Failed to record return.");
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
        <h1 className="text-2xl font-semibold tracking-tight">Return items</h1>
        <p className="text-sm text-muted-foreground">
          Record returned or damaged goods against this bill. A credit note will be issued.
        </p>

        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}

        <form onSubmit={handleReturn} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="return-reason">Reason for return</Label>
            <Input
              id="return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Defective, wrong size, customer requested refund"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="return-refund">Refund method</Label>
            <select
              id="return-refund"
              value={refundMethod}
              onChange={(e) => setRefundMethod(e.target.value)}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              <option value="store_credit">Store credit (customer account)</option>
            </select>
          </div>

          <Button type="submit" disabled={pending}>
            {pending ? "Saving return..." : "Save return & issue credit note"}
          </Button>
        </form>
      </main>
    </AppShell>
  );
}
