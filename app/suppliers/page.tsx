"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SupplierItem {
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
  };
  paymentTerms?: {
    type?: string;
    creditDays?: number;
  };
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New supplier form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [state, setState] = useState("");
  const [paymentType, setPaymentType] = useState("cash");
  const [creditDays, setCreditDays] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const fetchSuppliers = async (q = "") => {
    try {
      setLoading(true);
      const url = q.trim()
        ? `/api/suppliers?q=${encodeURIComponent(q.trim())}`
        : "/api/suppliers";
      const res = await fetch(url, { credentials: "same-origin" });
      const data = await res.json().catch(() => null);

      if (data?.success && Array.isArray(data.suppliers)) {
        setSuppliers(data.suppliers);
        setError(null);
      } else {
        setError(data?.message || "Failed to load suppliers");
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
        const res = await fetch("/api/suppliers", { credentials: "same-origin" });
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (data?.success && Array.isArray(data.suppliers)) {
          setSuppliers(data.suppliers);
          setError(null);
        } else {
          setError(data?.message || "Failed to load suppliers");
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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchSuppliers(searchQuery);
  };

  const handleCreateSupplier = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError("Supplier name is required.");
      return;
    }

    setFormError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/suppliers", {
          method: "POST",
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
            paymentType,
            creditDays: Number(creditDays) || 0,
          }),
        });

        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          setName("");
          setContactPerson("");
          setPhone("");
          setEmail("");
          setGstin("");
          setAddress("");
          setState("");
          setCreditDays("0");
          setShowAddForm(false);
          fetchSuppliers(searchQuery);
        } else {
          setFormError(data?.message || "Failed to create supplier");
        }
      } catch {
        setFormError("Unable to save supplier. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
            <p className="text-xs text-muted-foreground">
              Manage vendors, purchase terms, GST numbers, and contact details.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? "Cancel" : "Add supplier"}
          </Button>
        </div>

        {/* Add Supplier Form */}
        {showAddForm && (
          <form
            onSubmit={handleCreateSupplier}
            className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
          >
            <h2 className="font-semibold">New supplier</h2>
            {formError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {formError}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-name">Business name *</Label>
                <Input
                  id="sup-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Acme Wholesale Ltd"
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-contact">Contact person</Label>
                <Input
                  id="sup-contact"
                  value={contactPerson}
                  onChange={(e) => setContactPerson(e.target.value)}
                  placeholder="Representative name"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-phone">Phone number</Label>
                <Input
                  id="sup-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 9876543210"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-email">Email</Label>
                <Input
                  id="sup-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="vendor@example.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-gstin">GSTIN</Label>
                <Input
                  id="sup-gstin"
                  value={gstin}
                  onChange={(e) => setGstin(e.target.value.toUpperCase())}
                  placeholder="15-character GSTIN"
                  maxLength={15}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-address">Address</Label>
                <Input
                  id="sup-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street / Warehouse location"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-paytype">Payment terms</Label>
                <select
                  id="sup-paytype"
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value)}
                  className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                >
                  <option value="cash">Cash on delivery</option>
                  <option value="credit">Credit terms</option>
                  <option value="advance">Advance payment</option>
                </select>
              </div>
              {paymentType === "credit" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sup-credit-days">Credit days</Label>
                  <Input
                    id="sup-credit-days"
                    type="number"
                    min="0"
                    value={creditDays}
                    onChange={(e) => setCreditDays(e.target.value)}
                    placeholder="e.g. 30"
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving..." : "Save supplier"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAddForm(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {/* Search Bar */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, phone, code or GSTIN..."
            className="max-w-xs"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
          {searchQuery && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearchQuery("");
                fetchSuppliers("");
              }}
            >
              Clear
            </Button>
          )}
        </form>

        {/* Supplier List Table */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading suppliers...</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : suppliers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {searchQuery ? "No suppliers matching your search." : "No suppliers added yet."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="w-full text-sm" aria-label="Suppliers">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2.5 font-medium">Code</th>
                  <th className="p-2.5 font-medium">Supplier name</th>
                  <th className="p-2.5 font-medium">Contact</th>
                  <th className="p-2.5 font-medium">GSTIN</th>
                  <th className="p-2.5 text-right font-medium">Terms</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {suppliers.map((s) => (
                  <tr key={s._id} className="hover:bg-muted/30">
                    <td className="p-2.5 text-muted-foreground font-mono text-xs">
                      {s.supplierCode || "—"}
                    </td>
                    <td className="p-2.5">
                      <Link
                        href={`/suppliers/${s._id}`}
                        className="font-medium underline hover:text-primary"
                      >
                        {s.name}
                      </Link>
                      {s.contact?.contactPerson && (
                        <span className="text-xs text-muted-foreground block">
                          {s.contact.contactPerson}
                        </span>
                      )}
                    </td>
                    <td className="p-2.5 text-muted-foreground">
                      {s.contact?.phone || s.contact?.email || "—"}
                    </td>
                    <td className="p-2.5 text-muted-foreground font-mono text-xs">
                      {s.tax?.gstin || "Unregistered"}
                    </td>
                    <td className="p-2.5 text-right capitalize">
                      {s.paymentTerms?.type === "credit"
                        ? `${s.paymentTerms.creditDays || 0}d credit`
                        : s.paymentTerms?.type || "Cash"}
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
