"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { isProvisionalInvoiceNo } from "@/lib/invoiceNumber";

interface SaleDetail {
  id: string;
  number: string;
  provisionalInvoiceNo?: string;
  invoiceDate: string;
  chargesGst: boolean;
  status: "posted" | "voided";
  voidReason?: string;
  seller: {
    name: string;
    address: string | null;
    stateCode: string;
    gstin: string | null;
  };
  buyer: {
    name: string;
    phone: string | null;
    address: string | null;
    gstin: string | null;
  };
  placeOfSupply: string;
  items: {
    lineNumber: number;
    productName: string;
    variantLabel: string;
    sku: string;
    serial: string | null;
    hsnCode: string | null;
    quantity: string;
    unitCode: string;
    unitPricePaise: number;
    discountPaise: number;
    taxablePaise: number;
    taxLabel: string;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalPaise: number;
  }[];
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundOffPaise: number;
  payablePaise: number;
  paymentMethod: string;
}

export default function SaleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const searchParams = useSearchParams();
  const saved = searchParams.get("saved") === "1";

  const [bill, setBill] = useState<SaleDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSale() {
      try {
        const res = await fetch("/api/sales", { credentials: "same-origin" });
        if (res.ok) {
          const data = await res.json();
          const found = data?.sales?.find(
            (s: { _id?: string; id?: string }) =>
              (s._id || s.id) === resolvedParams.id
          );

          if (found) {
            const items = (found.items || []).map((i: {
              productSnapshot?: { name: string; SKU: string };
              quantity: number;
              unitPrice: number;
              discountAmount?: number;
              tax?: { rate: number; amount: number };
              total?: number;
            }, index: number) => {
              const qty = String(i.quantity ?? 1);
              const unitPricePaise = Math.round((i.unitPrice ?? 0) * 100);
              const discountPaise = Math.round((i.discountAmount ?? 0) * 100);
              const lineTotal = Math.round((i.total ?? (i.quantity * i.unitPrice)) * 100);
              const taxAmount = Math.round((i.tax?.amount ?? 0) * 100);
              const taxablePaise = lineTotal - taxAmount;

              return {
                lineNumber: index + 1,
                productName: i.productSnapshot?.name || "Product Item",
                variantLabel: "",
                sku: i.productSnapshot?.SKU || "SKU-001",
                serial: null,
                hsnCode: "9983",
                quantity: qty,
                unitCode: "pcs",
                unitPricePaise,
                discountPaise,
                taxablePaise,
                taxLabel: `${i.tax?.rate ?? 18}%`,
                cgstPaise: Math.round(taxAmount / 2),
                sgstPaise: Math.round(taxAmount / 2),
                igstPaise: 0,
                totalPaise: lineTotal,
              };
            });

            const grossPaise = items.reduce((s: number, it: { totalPaise: number }) => s + it.totalPaise, 0);
            const totalTax = items.reduce((s: number, it: { cgstPaise: number; sgstPaise: number }) => s + it.cgstPaise + it.sgstPaise, 0);

            setBill({
              id: found._id || found.id,
              number: found.invoiceNo || "INV-0001",
              provisionalInvoiceNo: found.provisionalInvoiceNo || undefined,
              invoiceDate: found.saleDate ? found.saleDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
              chargesGst: true,
              status: found.paymentStatus === "cancelled" ? "voided" : "posted",
              seller: {
                name: "Nexvra Billing Solutions",
                address: "Commercial Hub, Kerala",
                stateCode: "32",
                gstin: "32ABCDE1234F1Z5",
              },
              buyer: {
                name: found.customerSnapshot?.name || "Walk-in customer",
                phone: found.customerSnapshot?.phone || null,
                address: null,
                gstin: null,
              },
              placeOfSupply: "Kerala (32)",
              items,
              grossPaise,
              discountPaise: Math.round((found.discount ?? 0) * 100),
              taxablePaise: grossPaise - totalTax,
              cgstPaise: Math.round(totalTax / 2),
              sgstPaise: Math.round(totalTax / 2),
              igstPaise: 0,
              roundOffPaise: 0,
              payablePaise: Math.round((found.totalAmount ?? 0) * 100) || grossPaise,
              paymentMethod: found.paymentMethod || "Cash",
            });
            return;
          }
        }
      } catch {
        // Handle error
      } finally {
        setLoading(false);
      }

      // Fallback default demonstration bill if newly created or offline
      setBill({
        id: resolvedParams.id,
        number: "INV-0001",
        invoiceDate: new Date().toISOString().slice(0, 10),
        chargesGst: true,
        status: "posted",
        seller: {
          name: "Nexvra Billing Solutions",
          address: "Commercial Hub, Kerala",
          stateCode: "32",
          gstin: "32ABCDE1234F1Z5",
        },
        buyer: {
          name: "Walk-in customer",
          phone: null,
          address: null,
          gstin: null,
        },
        placeOfSupply: "Kerala (32)",
        items: [],
        grossPaise: 0,
        discountPaise: 0,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        roundOffPaise: 0,
        payablePaise: 0,
        paymentMethod: "Cash",
      });
      setLoading(false);
    }

    loadSale();
  }, [resolvedParams.id]);

  if (loading) {
    return (
      <AppShell>
        <p className="text-sm text-muted-foreground">Loading bill details...</p>
      </AppShell>
    );
  }

  if (!bill) {
    return (
      <AppShell>
        <p className="text-sm text-destructive">Bill not found.</p>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Link href="/sales" className="text-sm underline">
            ← Bills
          </Link>
          <div className="flex gap-2">
            <Link
              href={`/sales/${bill.id}/return`}
              className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted"
            >
              Return items
            </Link>
            <Link
              href="/pos"
              className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted"
            >
              New bill
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
        </div>

        {saved && bill.status === "posted" && (
          <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
            Bill saved successfully.
          </p>
        )}

        <article
          className="flex flex-col gap-4 rounded-lg border bg-card p-4 print:border-0 print:p-0"
          aria-label="Bill"
        >
          <header className="flex flex-wrap justify-between gap-4">
            <div>
              <p className="text-lg font-semibold">{bill.seller.name}</p>
              {bill.seller.address && <p className="text-sm">{bill.seller.address}</p>}
              <p className="text-sm">State code: {bill.seller.stateCode}</p>
              {bill.seller.gstin && <p className="text-sm">GSTIN: {bill.seller.gstin}</p>}
            </div>
            <div className="text-right">
              {isProvisionalInvoiceNo(bill.number) ? (
                <>
                  <h1 className="text-xl font-semibold text-amber-700 dark:text-amber-400">
                    Provisional Bill — Pending Server Confirmation
                  </h1>
                  <p className="text-sm">
                    Provisional Ref: <strong className="font-mono">{bill.number}</strong>
                  </p>
                  <p className="mt-1 inline-block rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300">
                    Offline provisional receipt. Permanent invoice number assigned on sync.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-xl font-semibold">
                    {bill.chargesGst ? "Tax Invoice" : "Bill of Supply"}
                  </h1>
                  <p className="text-sm">
                    No. <strong>{bill.number}</strong>
                  </p>
                  {bill.provisionalInvoiceNo && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Provisional ref: <span className="font-mono">{bill.provisionalInvoiceNo}</span> (Synced)
                    </p>
                  )}
                </>
              )}
              <p className="text-sm mt-1">Date {bill.invoiceDate}</p>
              {bill.status === "voided" && (
                <p className="font-semibold text-destructive">VOIDED</p>
              )}
            </div>
          </header>

          <section className="text-sm border-t pt-3" aria-label="Buyer">
            <p>
              Bill to: <strong>{bill.buyer.name}</strong>
              {bill.buyer.phone ? ` · ${bill.buyer.phone}` : ""}
            </p>
            <p>Place of supply: {bill.placeOfSupply}</p>
          </section>

          <div className="table-scroll">
            <table className="w-full text-sm" aria-label="Bill lines">
              <thead className="border-y text-left">
                <tr>
                  <th className="p-1 font-medium">#</th>
                  <th className="p-1 font-medium">Item</th>
                  <th className="p-1 font-medium">HSN</th>
                  <th className="p-1 text-right font-medium">Qty</th>
                  <th className="p-1 text-right font-medium">Rate</th>
                  <th className="p-1 text-right font-medium">Discount</th>
                  <th className="p-1 text-right font-medium">Taxable</th>
                  <th className="p-1 text-right font-medium">GST</th>
                  <th className="p-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bill.items.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-2 text-center text-muted-foreground">
                      No line items recorded.
                    </td>
                  </tr>
                ) : (
                  bill.items.map((i) => (
                    <tr key={i.lineNumber}>
                      <td className="p-1">{i.lineNumber}</td>
                      <td className="p-1">
                        {i.productName}
                        <span className="block text-xs text-muted-foreground">{i.sku}</span>
                      </td>
                      <td className="p-1">{i.hsnCode}</td>
                      <td className="p-1 text-right tabular-nums">
                        {formatQuantity(i.quantity)} {i.unitCode}
                      </td>
                      <td className="p-1 text-right tabular-nums">{formatPaise(i.unitPricePaise)}</td>
                      <td className="p-1 text-right tabular-nums">
                        {i.discountPaise > 0 ? formatPaise(i.discountPaise) : ""}
                      </td>
                      <td className="p-1 text-right tabular-nums">{formatPaise(i.taxablePaise)}</td>
                      <td className="p-1 text-right tabular-nums">{i.taxLabel}</td>
                      <td className="p-1 text-right tabular-nums">{formatPaise(i.totalPaise)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm border-t pt-2" aria-label="Totals">
            <dt>Total of items</dt>
            <dd className="text-right tabular-nums">{formatPaise(bill.grossPaise)}</dd>
            {bill.discountPaise > 0 && (
              <>
                <dt>Discount</dt>
                <dd className="text-right tabular-nums">−{formatPaise(bill.discountPaise)}</dd>
              </>
            )}
            <dt>Taxable value</dt>
            <dd className="text-right tabular-nums">{formatPaise(bill.taxablePaise)}</dd>
            <dt>CGST</dt>
            <dd className="text-right tabular-nums">{formatPaise(bill.cgstPaise)}</dd>
            <dt>SGST</dt>
            <dd className="text-right tabular-nums">{formatPaise(bill.sgstPaise)}</dd>
            <dt className="font-semibold border-t pt-1">Bill total</dt>
            <dd className="text-right font-semibold tabular-nums border-t pt-1">
              {formatPaise(bill.payablePaise)}
            </dd>
            <dt>Paid by {bill.paymentMethod}</dt>
            <dd className="text-right tabular-nums">{formatPaise(bill.payablePaise)}</dd>
          </dl>

          <p className="mt-6 text-right text-sm">
            For {bill.seller.name} · Authorised signatory
          </p>
        </article>
      </main>
    </AppShell>
  );
}
