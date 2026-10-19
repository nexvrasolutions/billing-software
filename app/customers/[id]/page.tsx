"use client";

import { use, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise } from "@/lib/money";
import { restoreOfflineSession } from "@/lib/offline/offlineAccess";
import {
  makeCachedCustomerId,
  savePendingOfflineCustomerUpdate,
} from "@/lib/offline/customerCache";
import { offlineDB } from "@/lib/offline/db";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";

interface CustomerDetail {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  status: "active" | "inactive";
  createdAt?: string;
  syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";
}

interface CustomerBill {
  _id: string;
  invoiceNumber?: string;
  saleNumber?: string;
  grandTotal?: number;
  totalAmountPaise?: number;
  paidAmount?: number;
  paymentStatus?: string;
  createdAt: string;
}

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [bills, setBills] = useState<CustomerBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  // Edit customer state
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;

    async function loadCustomer() {
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // 1. If online, attempt to fetch from server first
      if (!isNavOffline) {
        try {
          const res = await fetch(`/api/customers/${id}`, {
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
          });

          if (res.status === 401 || res.status === 403) {
            if (!active) return;
            setError(
              res.status === 401
                ? "Please sign in to access customer details."
                : "You do not have permission to view this customer."
            );
            setLoading(false);
            return;
          }

          const data = await res.json().catch(() => null);

          if (active && res.ok && data?.success && data.customer) {
            setCustomer(data.customer);
            setBills(data.bills || []);
            setName(data.customer.name || "");
            setPhone(data.customer.phone || "");
            setEmail(data.customer.email || "");
            setAddress(data.customer.address || "");
            setStatus(data.customer.status || "active");
            setIsOffline(false);
            setError(null);
            setLoading(false);
            return;
          }

          if (res.status === 404) {
            if (!active) return;
            setError("Customer not found");
            setLoading(false);
            return;
          }
        } catch {
          // Network error or timeout: fall back to offline cache
        }
      }

      // 2. Offline fallback: read customer record from Dexie cache
      try {
        const restored = await restoreOfflineSession().catch(() => null);
        if (restored?.ok && restored.identity?.tenantId) {
          const tenantId = restored.identity.tenantId;
          const cachedKey = makeCachedCustomerId(tenantId, id);
          const cached = await offlineDB.cachedCustomers.get(cachedKey);

          if (active && cached) {
            setCustomer({
              _id: cached.customerId,
              name: cached.name,
              phone: cached.phone,
              email: cached.email,
              address: cached.address,
              status: cached.status,
              syncStatus: cached.syncStatus,
            });
            setName(cached.name);
            setPhone(cached.phone || "");
            setEmail(cached.email || "");
            setAddress(cached.address || "");
            setStatus(cached.status);
            setBills([]);
            setIsOffline(true);
            setError(null);
            setLoading(false);
            return;
          }
        }

        if (active) {
          setError("Customer record not available offline. Please connect online to view.");
        }
      } catch {
        if (active) setError("Unable to load customer details.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadCustomer();
    return () => {
      active = false;
    };
  }, [id]);

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setUpdateError("Name cannot be empty.");
      return;
    }

    setUpdateError(null);
    startTransition(async () => {
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // 1. If online, attempt server update first
      if (!isNavOffline) {
        try {
          const res = await fetch(`/api/customers/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
            body: JSON.stringify({
              name: cleanName,
              phone: phone.trim() || undefined,
              email: email.trim() || undefined,
              address: address.trim() || undefined,
              status,
            }),
          });

          const data = await res.json().catch(() => null);

          if (res.ok && data?.success) {
            setCustomer(data.customer);
            setIsEditing(false);
            return;
          }

          if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
            setUpdateError(data?.message || "Failed to update customer");
            return;
          }
        } catch {
          // Network failed: proceed to offline update
        }
      }

      // 2. Offline update fallback via Dexie cache
      try {
        const restored = await restoreOfflineSession().catch(() => null);
        if (!restored || !restored.ok || !restored.identity?.tenantId) {
          setUpdateError(
            restored?.reason ||
            "Unable to update customer offline. Please sign in online first."
          );
          return;
        }

        const updated = await savePendingOfflineCustomerUpdate(
          {
            customerId: id,
            name: cleanName,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            address: address.trim() || undefined,
            status,
          },
          restored.identity.tenantId
        );

        setCustomer({
          _id: updated.customerId,
          name: updated.name,
          phone: updated.phone,
          email: updated.email,
          address: updated.address,
          status: updated.status,
          syncStatus: updated.syncStatus,
        });
        setIsEditing(false);
      } catch (err: any) {
        setUpdateError(err?.message || "Unable to update customer. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <Link href="/customers" className="text-sm underline">
          ← Back to customers
        </Link>

        {/* Offline notice banner */}
        {isOffline && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-2 font-medium">
              <span className="size-2 rounded-full bg-amber-500 animate-pulse" />
              Offline Mode — Viewing locally cached customer record.
            </span>
            <span>Edits will sync automatically when reconnected. Billing history requires an online connection.</span>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading customer details...</p>
        ) : error || !customer ? (
          <p role="alert" className="text-sm text-destructive">{error || "Customer not found."}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
                  {customer.syncStatus === "PENDING" && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      Pending sync
                    </span>
                  )}
                  {customer.syncStatus === "NEEDS_ATTENTION" && (
                    <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                      Sync failed
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Customer record · {customer.phone || "No phone"} · {customer.email || "No email"}
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
                <h2 className="font-semibold">Edit customer profile</h2>
                {updateError && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {updateError}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-name">Name *</Label>
                    <Input
                      id="edit-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-phone">Phone number</Label>
                    <Input
                      id="edit-phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-email">Email</Label>
                    <Input
                      id="edit-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-address">Billing address</Label>
                    <Input
                      id="edit-address"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-status">Status</Label>
                    <select
                      id="edit-status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value as "active" | "inactive")}
                      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={isPending}>
                    {isPending ? "Saving..." : isOffline ? "Save offline" : "Save changes"}
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
                <p className="text-xs text-muted-foreground">Status</p>
                <p className="mt-1 font-semibold capitalize">{customer.status}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Total bills recorded</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {isOffline ? "—" : bills.length}
                </p>
                {isOffline && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Online required</p>
                )}
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Address</p>
                <p className="mt-1 text-sm">{customer.address || "No address saved"}</p>
              </div>
            </div>

            {/* Recent bills list */}
            <section className="flex flex-col gap-2">
              <h2 className="text-base font-semibold">Purchase &amp; billing history</h2>
              {isOffline ? (
                <p className="text-sm text-muted-foreground">
                  Billing history is unavailable while offline. Connect online to view historical sales.
                </p>
              ) : bills.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bills recorded for this customer yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="w-full text-sm" aria-label="Customer bills">
                    <thead className="border-b bg-muted/40 text-left">
                      <tr>
                        <th className="p-2.5 font-medium">Date</th>
                        <th className="p-2.5 font-medium">Bill #</th>
                        <th className="p-2.5 text-right font-medium">Total</th>
                        <th className="p-2.5 text-right font-medium">Payment status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {bills.map((b) => (
                        <tr key={b._id} className="hover:bg-muted/30">
                          <td className="p-2.5 text-muted-foreground">
                            {new Date(b.createdAt).toLocaleDateString("en-IN", {
                              dateStyle: "medium",
                            })}
                          </td>
                          <td className="p-2.5">
                            <Link
                              href={`/sales/${b._id}`}
                              className="font-medium underline hover:text-primary"
                            >
                              {b.invoiceNumber || b.saleNumber || b._id}
                            </Link>
                          </td>
                          <td className="p-2.5 text-right tabular-nums font-medium">
                            {typeof b.totalAmountPaise === "number"
                              ? formatPaise(b.totalAmountPaise)
                              : typeof b.grandTotal === "number"
                              ? `₹${b.grandTotal.toFixed(2)}`
                              : "—"}
                          </td>
                          <td className="p-2.5 text-right">
                            <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize">
                              {b.paymentStatus || "completed"}
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
