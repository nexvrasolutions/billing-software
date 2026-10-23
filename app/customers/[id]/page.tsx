"use client";

import { use, useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise } from "@/lib/money";
import { restoreOfflineSession } from "@/lib/offline/offlineAccess";
import {
  ensurePendingCustomersQueued,
  makeCachedCustomerId,
  savePendingOfflineCustomerUpdate,
} from "@/lib/offline/customerCache";
import { offlineDB } from "@/lib/offline/db";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import { syncPendingOperations } from "@/lib/offline/SyncManager";

interface CustomerDetail {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  status: "active" | "inactive";
  createdAt?: string;
  syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";
  errorMessage?: string;
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

type CustomerLifecycleActionType = "deactivate" | "reactivate" | "delete";

interface PendingCustomerLifecycleModal {
  action: CustomerLifecycleActionType;
  title: string;
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

  // Lifecycle action state
  const [pendingModal, setPendingModal] = useState<PendingCustomerLifecycleModal | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
  const [isPendingLifecycle, setIsPendingLifecycle] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);

  const isSyncingRef = useRef(false);

  const loadCustomer = useCallback(async () => {
    const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

    // 1. Check local Dexie cache first for pending local edits
    let cachedRecord: any = null;
    let tenantId: string | undefined;
    try {
      const restored = await restoreOfflineSession().catch(() => null);
      if (restored?.ok && restored.identity?.tenantId) {
        tenantId = restored.identity.tenantId;
        const cachedKey = makeCachedCustomerId(tenantId, id);
        cachedRecord = await offlineDB.cachedCustomers.get(cachedKey);
      }
    } catch {}

    // If the local cache has a pending edit or needs attention, NEVER overwrite it with stale server data!
    if (cachedRecord && (cachedRecord.syncStatus === "PENDING" || cachedRecord.syncStatus === "NEEDS_ATTENTION")) {
      setCustomer({
        _id: cachedRecord.customerId,
        name: cachedRecord.name,
        phone: cachedRecord.phone,
        email: cachedRecord.email,
        address: cachedRecord.address,
        status: cachedRecord.status,
        syncStatus: cachedRecord.syncStatus,
        errorMessage: cachedRecord.errorMessage,
      });
      setName(cachedRecord.name);
      setPhone(cachedRecord.phone || "");
      setEmail(cachedRecord.email || "");
      setAddress(cachedRecord.address || "");
      setStatus(cachedRecord.status);
      setBills([]);
      setIsOffline(isNavOffline);
      setError(null);
      setLoading(false);

      if (!isNavOffline && cachedRecord.syncStatus === "PENDING") {
        void triggerSync();
      }
      return;
    }

    // 2. If online and no pending local edit, attempt to fetch from server
    if (!isNavOffline) {
      try {
        const res = await fetch(`/api/customers/${id}`, {
          credentials: "same-origin",
          signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
        });

        if (res.status === 401 || res.status === 403) {
          setError(
            res.status === 401
              ? "Please sign in to access customer details."
              : "You do not have permission to view this customer."
          );
          setLoading(false);
          return;
        }

        const data = await res.json().catch(() => null);

        if (res.ok && data?.success && data.customer) {
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
          setError("Customer not found");
          setLoading(false);
          return;
        }
      } catch {
        // Network error or timeout: fall back to offline cache
      }
    }

    // 3. Fallback to cached customer if available
    if (cachedRecord) {
      setCustomer({
        _id: cachedRecord.customerId,
        name: cachedRecord.name,
        phone: cachedRecord.phone,
        email: cachedRecord.email,
        address: cachedRecord.address,
        status: cachedRecord.status,
        syncStatus: cachedRecord.syncStatus,
        errorMessage: cachedRecord.errorMessage,
      });
      setName(cachedRecord.name);
      setPhone(cachedRecord.phone || "");
      setEmail(cachedRecord.email || "");
      setAddress(cachedRecord.address || "");
      setStatus(cachedRecord.status);
      setBills([]);
      setIsOffline(true);
      setError(null);
      setLoading(false);
      return;
    }

    setError("Customer record not available offline. Please connect online to view.");
    setLoading(false);
  }, [id]);

  const triggerSync = useCallback(async () => {
    if (isSyncingRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;

    isSyncingRef.current = true;
    try {
      let tenantId: string | undefined;
      const restored = await restoreOfflineSession().catch(() => null);
      if (restored?.ok && restored.identity?.tenantId) {
        tenantId = restored.identity.tenantId;
        await ensurePendingCustomersQueued(tenantId, offlineDB, restored.identity).catch(() => 0);
      }

      const syncResult = await syncPendingOperations().catch(() => undefined);
      if (syncResult?.results && syncResult.results.some((r) => r.status === "SYNCED" || r.status === "NEEDS_ATTENTION")) {
        await loadCustomer();
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, [loadCustomer]);

  useEffect(() => {
    void loadCustomer();

    const onOnline = () => {
      setIsOffline(false);
      void triggerSync();
    };

    const onOffline = () => {
      setIsOffline(true);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [loadCustomer, triggerSync]);

  const handleExecuteLifecycleAction = async () => {
    if (!pendingModal || isPendingLifecycle) return;

    // Safety boundary: lifecycle actions are strictly online-only
    const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;
    if (isNavOffline || isOffline) {
      setLifecycleError("Lifecycle actions (deactivate, reactivate, delete) require an active online connection.");
      return;
    }

    setIsPendingLifecycle(true);
    setLifecycleError(null);

    try {
      if (pendingModal.action === "delete") {
        const res = await fetch(`/api/customers/${id}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          // Reconcile local Dexie cache if tenant identity available
          try {
            const restored = await restoreOfflineSession().catch(() => null);
            if (restored?.ok && restored.identity?.tenantId) {
              const cachedKey = makeCachedCustomerId(restored.identity.tenantId, id);
              if (data.deactivated) {
                await offlineDB.cachedCustomers.update(cachedKey, { status: "inactive" }).catch(() => 0);
              } else {
                await offlineDB.cachedCustomers.delete(cachedKey).catch(() => 0);
              }
            }
          } catch {}

          if (data.deactivated && data.customer) {
            setCustomer(data.customer);
            setStatus("inactive");
            setLifecycleNotice(
              data.message || "Customer has transaction history and was deactivated instead of deleted."
            );
          } else {
            setIsDeleted(true);
            setCustomer((prev) => (prev ? { ...prev, status: "inactive" } : null));
            setLifecycleNotice(data.message || "Customer deleted successfully.");
          }
          setPendingModal(null);
          setLifecycleReason("");
          setLifecycleError(null);
        } else {
          setLifecycleError(data?.message || "Failed to delete customer.");
        }
      } else {
        const res = await fetch(`/api/customers/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            action: pendingModal.action,
            reason: lifecycleReason.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success && data.customer) {
          // Reconcile local Dexie cache
          try {
            const restored = await restoreOfflineSession().catch(() => null);
            if (restored?.ok && restored.identity?.tenantId) {
              const cachedKey = makeCachedCustomerId(restored.identity.tenantId, id);
              await offlineDB.cachedCustomers.update(cachedKey, { status: data.customer.status }).catch(() => 0);
            }
          } catch {}

          setCustomer(data.customer);
          setStatus(data.customer.status);
          setLifecycleNotice(`Customer ${pendingModal.action}d successfully.`);
          setPendingModal(null);
          setLifecycleReason("");
          setLifecycleError(null);
        } else {
          setLifecycleError(data?.message || `Failed to ${pendingModal.action} customer.`);
        }
      }
    } catch {
      setLifecycleError("Unable to connect to the server. Please try again.");
    } finally {
      setIsPendingLifecycle(false);
    }
  };

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
              phone: phone.trim().length > 0 ? phone.trim() : null,
              email: email.trim().length > 0 ? email.trim() : null,
              address: address.trim().length > 0 ? address.trim() : null,
            }),
          });

          const data = await res.json().catch(() => null);

          if (res.ok && data?.success) {
            setCustomer(data.customer);
            setIsEditing(false);
            return;
          }

          if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 409) {
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
          restored.identity.tenantId,
          offlineDB,
          undefined,
          restored.identity
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

        // If online connection is available, trigger background sync
        if (typeof navigator !== "undefined" && navigator.onLine) {
          void triggerSync();
        }
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
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                      isDeleted
                        ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                        : customer.status === "active"
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isDeleted ? "Deleted" : customer.status}
                  </span>
                  {customer.syncStatus === "PENDING" && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      Pending sync
                    </span>
                  )}
                  {customer.syncStatus === "NEEDS_ATTENTION" && (
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                        Sync failed
                      </span>
                      <button
                        type="button"
                        onClick={() => void triggerSync()}
                        className="text-xs text-primary underline hover:text-primary/80"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>
                {customer.syncStatus === "NEEDS_ATTENTION" && customer.errorMessage && (
                  <p className="mt-1 text-xs text-destructive font-medium">
                    {customer.errorMessage}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Customer record · {customer.phone || "No phone"} · {customer.email || "No email"}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!isEditing && !isDeleted && (
                  <>
                    {customer.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isOffline}
                        title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                        onClick={() => {
                          setLifecycleError(null);
                          setLifecycleReason("");
                          setPendingModal({ action: "deactivate", title: "Deactivate Customer" });
                        }}
                      >
                        Deactivate
                      </Button>
                    )}

                    {customer.status === "inactive" && (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={isOffline}
                        title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                        onClick={() => {
                          setLifecycleError(null);
                          setLifecycleReason("");
                          setPendingModal({ action: "reactivate", title: "Reactivate Customer" });
                        }}
                      >
                        Reactivate
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isOffline}
                      title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                      className="text-destructive hover:bg-destructive/10 disabled:text-muted-foreground"
                      onClick={() => {
                        setLifecycleError(null);
                        setLifecycleReason("");
                        setPendingModal({ action: "delete", title: "Delete Customer" });
                      }}
                    >
                      Delete
                    </Button>
                  </>
                )}

                {!isDeleted && (
                  <Button
                    variant={isEditing ? "outline" : "default"}
                    size="sm"
                    onClick={() => setIsEditing(!isEditing)}
                  >
                    {isEditing ? "Cancel" : "Edit details"}
                  </Button>
                )}
              </div>
            </div>

            {/* Lifecycle feedback notifications */}
            {lifecycleNotice && (
              <div
                role="status"
                className="rounded-md bg-emerald-500/10 p-3 text-xs font-medium text-emerald-800 dark:text-emerald-300"
              >
                {lifecycleNotice}
              </div>
            )}
            {lifecycleError && !pendingModal && (
              <div
                role="alert"
                className="rounded-md bg-destructive/10 p-3 text-xs font-medium text-destructive"
              >
                {lifecycleError}
              </div>
            )}

            {/* Edit details form */}
            {isEditing && (
              <form
                noValidate
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
                    <Label>Status</Label>
                    <div className="flex items-center gap-2 h-8">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${
                        status === "active" ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400"
                      }`}>
                        {status}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        (Use Deactivate / Reactivate above)
                      </span>
                    </div>
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

      {/* Customer Lifecycle Confirmation Modal */}
      {pendingModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cust-lifecycle-modal-title"
          aria-describedby="cust-lifecycle-modal-description"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !isPendingLifecycle) {
              setPendingModal(null);
              setLifecycleReason("");
              setLifecycleError(null);
            }
          }}
        >
          <div className="relative w-full max-w-lg rounded-xl border bg-background p-6 shadow-2xl">
            <h2 id="cust-lifecycle-modal-title" className="text-lg font-semibold tracking-tight">
              {pendingModal.title}
            </h2>

            <p id="cust-lifecycle-modal-description" className="mt-2 text-sm text-muted-foreground leading-relaxed">
              {pendingModal.action === "deactivate" && (
                <>
                  Are you sure you want to deactivate{" "}
                  <strong className="text-foreground">{customer?.name || "this customer"}</strong>?
                  Inactive customers cannot be selected when creating new sales or bills. Existing
                  sales history, invoices, and ledger records are safely preserved.
                </>
              )}
              {pendingModal.action === "reactivate" && (
                <>
                  Are you sure you want to reactivate{" "}
                  <strong className="text-foreground">{customer?.name || "this customer"}</strong>?
                  The customer will become active again and available for recording new sales and bills.
                </>
              )}
              {pendingModal.action === "delete" && (
                <>
                  Are you sure you want to delete{" "}
                  <strong className="text-foreground">{customer?.name || "this customer"}</strong>?
                  If this customer has existing transaction history (sales, returns, payments, or ledger
                  entries), they will be safely deactivated to preserve accounting records. Unreferenced
                  customers will be deleted.
                </>
              )}
            </p>

            {/* Optional reason input for deactivate */}
            {pendingModal.action === "deactivate" && (
              <div className="mt-4 flex flex-col gap-1.5">
                <Label htmlFor="cust-lifecycle-reason">
                  Reason for deactivation{" "}
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="cust-lifecycle-reason"
                  name="lifecycleReason"
                  value={lifecycleReason}
                  onChange={(e) => setLifecycleReason(e.target.value)}
                  placeholder="e.g., Customer requested account closure, duplicate record"
                  maxLength={500}
                  disabled={isPendingLifecycle}
                />
                <span className="text-[11px] text-muted-foreground text-right">
                  {lifecycleReason.length}/500
                </span>
              </div>
            )}

            {/* Modal error display */}
            {lifecycleError && (
              <div
                role="alert"
                className="mt-4 rounded-md bg-destructive/10 p-3 text-xs font-medium text-destructive"
              >
                {lifecycleError}
              </div>
            )}

            {/* Actions row */}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={isPendingLifecycle}
                onClick={() => {
                  setPendingModal(null);
                  setLifecycleReason("");
                  setLifecycleError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant={pendingModal.action === "delete" ? "destructive" : "default"}
                disabled={isPendingLifecycle}
                onClick={handleExecuteLifecycleAction}
              >
                {isPendingLifecycle
                  ? "Processing..."
                  : pendingModal.action === "delete"
                  ? "Confirm Delete"
                  : pendingModal.action === "deactivate"
                  ? "Deactivate Customer"
                  : "Reactivate Customer"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
