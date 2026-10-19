"use client";

import { use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { formatPaise } from "@/lib/money";

export default function CreditNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const searchParams = useSearchParams();
  const saved = searchParams.get("saved") === "1";

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Link href="/sales" className="text-sm underline">
            ← Bills
          </Link>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.print()}
          >
            Print
          </Button>
        </div>

        {saved && (
          <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
            Return saved. Credit note issued.
          </p>
        )}

        <article
          className="flex flex-col gap-4 rounded-lg border bg-card p-4 print:border-0 print:p-0"
          aria-label="Credit note"
        >
          <header className="flex flex-wrap justify-between gap-4">
            <div>
              <p className="text-lg font-semibold">Nexvra Billing Solutions</p>
              <p className="text-sm">Commercial Hub, Kerala</p>
              <p className="text-sm">State: Kerala (32)</p>
              <p className="text-sm">GSTIN: 32ABCDE1234F1Z5</p>
            </div>
            <div className="text-right">
              <h1 className="text-xl font-semibold">Credit Note</h1>
              <p className="text-sm">
                No. <strong>CN-{resolvedParams.id.slice(0, 8).toUpperCase()}</strong>
              </p>
              <p className="text-sm">Date {new Date().toISOString().slice(0, 10)}</p>
            </div>
          </header>

          <section className="text-sm border-t pt-3" aria-label="Buyer">
            <p>Customer: <strong>Walk-in customer</strong></p>
            <p>Reason: Goods return / exchange</p>
          </section>

          <div className="table-scroll">
            <table className="w-full text-sm" aria-label="Returned items">
              <thead className="border-y text-left">
                <tr>
                  <th className="p-1 font-medium">#</th>
                  <th className="p-1 font-medium">Item</th>
                  <th className="p-1 font-medium">HSN</th>
                  <th className="p-1 text-right font-medium">Qty</th>
                  <th className="p-1 text-right font-medium">Taxable</th>
                  <th className="p-1 text-right font-medium">GST</th>
                  <th className="p-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={7} className="p-3 text-center text-muted-foreground">
                    Items returned against original invoice.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm border-t pt-2" aria-label="Totals">
            <dt className="font-semibold">Refund amount</dt>
            <dd className="text-right font-semibold tabular-nums">{formatPaise(0)}</dd>
            <dt>Paid back as</dt>
            <dd className="text-right">Cash</dd>
          </dl>

          <p className="mt-6 text-right text-sm">
            For Nexvra Billing Solutions · Authorised signatory
          </p>
        </article>
      </main>
    </AppShell>
  );
}
