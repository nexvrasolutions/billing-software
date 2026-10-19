"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { formatPaise } from "@/lib/money";
import { isProvisionalInvoiceNo } from "@/lib/invoiceNumber";

interface BillItem {
  id: string;
  number: string;
  provisionalInvoiceNo?: string;
  createdAt: string;
  buyerName: string;
  payablePaise: number;
  creditPaise: number;
  status: "posted" | "voided";
}

export default function SalesPage() {
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [bills, setBills] = useState<BillItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSales() {
      try {
        const res = await fetch("/api/sales", { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.sales && Array.isArray(data.sales)) {
          const mapped: BillItem[] = data.sales.map((s: {
            _id?: string;
            id?: string;
            invoiceNo?: string;
            createdAt?: string;
            saleDate?: string;
            customerSnapshot?: { name?: string };
            provisionalInvoiceNo?: string;
            totalAmount?: number;
            paymentStatus?: string;
          }) => ({
            id: s._id || s.id || crypto.randomUUID(),
            number: s.invoiceNo || "INV-0001",
            provisionalInvoiceNo: s.provisionalInvoiceNo || undefined,
            createdAt: s.saleDate || s.createdAt || new Date().toISOString(),
            buyerName: s.customerSnapshot?.name || "Walk-in customer",
            payablePaise: Math.round((s.totalAmount ?? 0) * 100),
            creditPaise: 0,
            status: s.paymentStatus === "cancelled" ? "voided" : "posted",
          }));
          setBills(mapped);
        }
      } catch {
        // Offline or unreachable
      } finally {
        setLoading(false);
      }
    }
    loadSales();
  }, []);

  const filteredBills = bills.filter((b) => b.createdAt.startsWith(day));
  const posted = filteredBills.filter((b) => b.status === "posted");
  const total = posted.reduce((sum, b) => sum + b.payablePaise, 0);

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Bills</h1>
          <Link href="/pos" className="action-primary">
            New bill
          </Link>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
          }}
          className="flex items-end gap-2"
        >
          <label className="flex flex-col gap-1 text-sm">
            Day
            <input
              type="date"
              name="day"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            />
          </label>
        </form>

        <p className="text-sm">
          {posted.length} bill{posted.length === 1 ? "" : "s"}, {formatPaise(total)}
          {filteredBills.length > posted.length
            ? ` (${String(filteredBills.length - posted.length)} voided, not counted)`
            : ""}
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading bills...</p>
        ) : filteredBills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills on this day.</p>
        ) : (
          <div className="table-scroll">
            <table className="w-full text-sm" aria-label="Bills">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2 font-medium">Bill</th>
                  <th className="p-2 font-medium">Time</th>
                  <th className="p-2 font-medium">Customer</th>
                  <th className="p-2 text-right font-medium">Amount</th>
                  <th className="p-2 text-right font-medium">On account</th>
                  <th className="p-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredBills.map((b) => (
                  <tr key={b.id}>
                    <td className="p-2">
                      <Link href={`/sales/${b.id}`} className="underline font-medium">
                        {b.number}
                      </Link>
                      {isProvisionalInvoiceNo(b.number) && (
                        <span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          Provisional
                        </span>
                      )}
                      {!isProvisionalInvoiceNo(b.number) && b.provisionalInvoiceNo && (
                        <span className="block text-[11px] text-muted-foreground font-mono">
                          Ref: {b.provisionalInvoiceNo}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      {new Date(b.createdAt).toLocaleTimeString("en-IN", {
                        timeZone: "Asia/Kolkata",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="p-2">{b.buyerName}</td>
                    <td className="p-2 text-right tabular-nums">{formatPaise(b.payablePaise)}</td>
                    <td className="p-2 text-right tabular-nums">
                      {b.creditPaise > 0 ? formatPaise(b.creditPaise) : ""}
                    </td>
                    <td className="p-2 capitalize">{b.status}</td>
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
