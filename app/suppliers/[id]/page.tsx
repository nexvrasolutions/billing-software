"use client";

import { use, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise, rupeesToPaise } from "@/lib/money";

interface SupplierDetail {
  _id: string;
  supplierCode?: string;
  name: string;
  contact?: {
    contactPerson?: string;
    phone?: string;
    email?: string;
  };
  address?: {
    line1?: string;
    state?: string;
  };
  tax?: {
    gstin?: string;
    taxRegistrationType?: string;
  };
  paymentTerms?: {
    type?: string;
    creditDays?: number;
  };
  creditLimit?: number;
}

interface SupplierPurchase {
  _id: string;
  purchaseNo?: string;
  supplierInvoiceNo?: string;
  purchaseDate?: string;
  grandTotal?: number;
  paidAmount?: number;
  dueAmount?: number;
  status?: string;
}

export default function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [supplier, setSupplier] = useState<SupplierDetail | null>(null);
  const [purchases, setPurchases] = useState<SupplierPurchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [state, setState] = useState("");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    async function loadSupplier() {
      try {
        const res = await fetch(`/api/suppliers/${id}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => null);

        if (!active) return;
        if (res.ok && data?.success && data.supplier) {
          setSupplier(data.supplier);
          setPurchases(data.purchases || []);
          setName(data.supplier.name || "");
          setContactPerson(data.supplier.contact?.contactPerson || "");
          setPhone(data.supplier.contact?.phone || "");
          setEmail(data.supplier.contact?.email || "");
          setGstin(data.supplier.tax?.gstin || "");
          setAddress(data.supplier.address?.line1 || "");
          setState(data.supplier.address?.state || "");
          setError(null);
        } else {
          setError(data?.message || "Supplier not found");
        }
      } catch {
        if (active) setError("Unable to connect to the server.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSupplier();
    return () => {
      active = false;
    };
  }, [id]);

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setUpdateError("Name cannot be empty.");
      return;
    }

    setUpdateError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/suppliers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            name: name.trim(),
            contactPerson: contactPerson.trim() || undefined,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            gstin: gstin.trim() || undefined,
            address: address.trim() || undefined,
            state: state.trim() || undefined,
          }),
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          setSupplier(data.supplier);
          setIsEditing(false);
        } else {
          setUpdateError(data?.message || "Failed to update supplier");
        }
      } catch {
        setUpdateError("Unable to update supplier. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <Link href="/suppliers" className="text-sm underline">
          ← Back to suppliers
        </Link>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading supplier details...</p>
        ) : error || !supplier ? (
          <p role="alert" className="text-sm text-destructive">{error || "Supplier not found."}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{supplier.name}</h1>
                <p className="text-xs text-muted-foreground">
                  Supplier code: <span className="font-mono">{supplier.supplierCode || id}</span> ·{" "}
                  {supplier.tax?.gstin ? `GSTIN: ${supplier.tax.gstin}` : "No GSTIN"}
                </p>
              </div>
              <Button
                variant={isEditing ? "outline" : "default"}
                onClick={() => setIsEditing(!isEditing)}
              >
                {isEditing ? "Cancel" : "Edit details"}
              </Button>
            </div>

            {/* Edit details form */}
            {isEditing && (
              <form
                onSubmit={handleUpdate}
                className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
              >
                <h2 className="font-semibold">Edit supplier profile</h2>
                {updateError && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {updateError}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-name">Business name *</Label>
                    <Input
                      id="sup-edit-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-contact">Contact person</Label>
                    <Input
                      id="sup-edit-contact"
                      value={contactPerson}
                      onChange={(e) => setContactPerson(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-phone">Phone number</Label>
                    <Input
                      id="sup-edit-phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-email">Email</Label>
                    <Input
                      id="sup-edit-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-gstin">GSTIN</Label>
                    <Input
                      id="sup-edit-gstin"
                      value={gstin}
                      onChange={(e) => setGstin(e.target.value.toUpperCase())}
                      maxLength={15}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-address">Address</Label>
                    <Input
                      id="sup-edit-address"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={isPending}>
                    {isPending ? "Saving..." : "Save changes"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditing(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {/* Overview cards */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Payment terms</p>
                <p className="mt-1 font-semibold capitalize">
                  {supplier.paymentTerms?.type === "credit"
                    ? `${supplier.paymentTerms.creditDays || 0} days credit`
                    : supplier.paymentTerms?.type || "Cash"}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Purchases recorded</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{purchases.length}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Contact &amp; Location</p>
                <p className="mt-1 text-sm">
                  {supplier.contact?.phone || supplier.contact?.email || "No direct contact"}
                  {supplier.address?.line1 ? ` · ${supplier.address.line1}` : ""}
                </p>
              </div>
            </div>

            {/* Purchases from this supplier */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Purchase bills from this vendor</h2>
                <Link href="/purchases/new" className="text-xs underline">
                  Record new purchase
                </Link>
              </div>
              {purchases.length === 0 ? (
                <p className="text-sm text-muted-foreground">No purchase bills recorded for this supplier yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="w-full text-sm" aria-label="Supplier purchases">
                    <thead className="border-b bg-muted/40 text-left">
                      <tr>
                        <th className="p-2.5 font-medium">Date</th>
                        <th className="p-2.5 font-medium">Bill #</th>
                        <th className="p-2.5 text-right font-medium">Total</th>
                        <th className="p-2.5 text-right font-medium">Due</th>
                        <th className="p-2.5 text-right font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {purchases.map((p) => (
                        <tr key={p._id} className="hover:bg-muted/30">
                          <td className="p-2.5 text-muted-foreground">
                            {p.purchaseDate
                              ? new Date(p.purchaseDate).toLocaleDateString("en-IN", {
                                  dateStyle: "medium",
                                })
                              : "—"}
                          </td>
                          <td className="p-2.5">
                            <Link
                              href={`/purchases/${p._id}`}
                              className="font-medium underline hover:text-primary"
                            >
                              {p.supplierInvoiceNo || p.purchaseNo || p._id}
                            </Link>
                          </td>
                          <td className="p-2.5 text-right tabular-nums font-medium">
                            {typeof p.grandTotal === "number"
                              ? formatPaise(rupeesToPaise(p.grandTotal))
                              : "—"}
                          </td>
                          <td className="p-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">
                            {typeof p.dueAmount === "number"
                              ? formatPaise(rupeesToPaise(p.dueAmount))
                              : "—"}
                          </td>
                          <td className="p-2.5 text-right">
                            <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize">
                              {p.status || "active"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </AppShell>
  );
}
