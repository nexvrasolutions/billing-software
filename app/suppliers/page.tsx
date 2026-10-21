"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { restoreOfflineSession, readRememberedIdentity } from "@/lib/offline/offlineAccess";
import {
  getCachedSuppliersForTenant,
  searchCachedSuppliers,
  saveCachedSuppliers,
  savePendingOfflineSupplier,
  ensurePendingSuppliersQueued,
  isTemporarySupplierCode,
} from "@/lib/offline/supplierCache";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import { syncPendingOperations } from "@/lib/offline/SyncManager";

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
  status?: "active" | "inactive" | "blocked";
  syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";
  errorMessage?: string;
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [emptyCacheNotice, setEmptyCacheNotice] = useState(false);

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

  // Request sequencing, cancellation, and concurrency guards
  const activeRequestIdRef = useRef(0);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const isSyncingRef = useRef(false);
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const lastQueriedQueryRef = useRef<string | null>("");

  const loadSuppliers = useCallback(async (q = "") => {
    const requestId = ++activeRequestIdRef.current;

    // Abort previous in-flight fetch if any
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;

    const cleanQ = q.trim();
    lastQueriedQueryRef.current = cleanQ;

    setLoading(true);
    setEmptyCacheNotice(false);
    const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

    // 1. If navigator is online, try fetching from API first with timeout and cancellation protection
    if (!isNavOffline) {
      try {
        const url = cleanQ
          ? `/api/suppliers?q=${encodeURIComponent(cleanQ)}`
          : "/api/suppliers";

        const combinedSignal = typeof AbortSignal.any === "function"
          ? AbortSignal.any([abortController.signal, AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)])
          : abortController.signal;

        const res = await fetch(url, {
          credentials: "same-origin",
          signal: combinedSignal,
        });

        // Discard if a newer request was issued while waiting
        if (requestId !== activeRequestIdRef.current) return;

        // Definitive session rejection: do not expose offline cache
        if (res.status === 401 || res.status === 403) {
          setSuppliers([]);
          setIsOffline(false);
          setError(
            res.status === 401
              ? "Please sign in to access suppliers."
              : "You do not have permission to view suppliers."
          );
          setLoading(false);
          return;
        }

        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (requestId !== activeRequestIdRef.current) return;

          if (data?.success && Array.isArray(data.suppliers)) {
            // Determine tenantId safely for local caching
            let tenantId: string | null = null;
            if (data.suppliers.length > 0 && data.suppliers[0]?.tenantId) {
              tenantId = String(data.suppliers[0].tenantId);
            }
            if (!tenantId) {
              const remembered = await readRememberedIdentity().catch(() => null);
              tenantId = remembered?.tenantId ?? null;
            }
            if (!tenantId) {
              const restored = await restoreOfflineSession().catch(() => null);
              tenantId = restored?.identity?.tenantId ?? null;
            }

            if (tenantId) {
              await saveCachedSuppliers(data.suppliers, tenantId).catch(() => undefined);
            }

            if (requestId !== activeRequestIdRef.current) return;

            // Retrieve local pending, needs-attention, and recently synced records to reconcile alongside server records
            let localToMerge: SupplierItem[] = [];
            if (tenantId) {
              try {
                const cachedRecords = await getCachedSuppliersForTenant(tenantId, {
                  includeInactive: true,
                  includeBlocked: true,
                });
                const nowMs = Date.now();
                const RECENT_SYNC_WINDOW_MS = 2 * 60 * 1000;

                let filteredLocal = cachedRecords.filter((r) => {
                  if (r.syncStatus === "PENDING" || r.syncStatus === "NEEDS_ATTENTION") {
                    return true;
                  }
                  if (r.syncStatus === "SYNCED" && r.cachedAt) {
                    const age = nowMs - new Date(r.cachedAt).getTime();
                    return age >= 0 && age < RECENT_SYNC_WINDOW_MS;
                  }
                  return false;
                });

                if (cleanQ) {
                  const lowerQ = cleanQ.toLowerCase();
                  filteredLocal = filteredLocal.filter(
                    (p) =>
                      p.name.toLowerCase().includes(lowerQ) ||
                      (p.phone && p.phone.includes(lowerQ)) ||
                      (p.email && p.email.toLowerCase().includes(lowerQ)) ||
                      (p.supplierCode && p.supplierCode.toLowerCase().includes(lowerQ)) ||
                      (p.gstin && p.gstin.toLowerCase().includes(lowerQ))
                  );
                }

                localToMerge = filteredLocal.map((r) => ({
                  _id: r.supplierId,
                  supplierCode: r.supplierCode,
                  name: r.name,
                  contact: {
                    contactPerson: r.contactPerson,
                    phone: r.phone,
                    email: r.email,
                  },
                  address: {
                    line1: r.address || r.line1,
                    state: r.state,
                  },
                  tax: {
                    gstin: r.gstin,
                  },
                  paymentTerms: {
                    type: r.paymentType,
                    creditDays: r.creditDays,
                  },
                  status: r.status,
                  syncStatus: r.syncStatus,
                  errorMessage: r.errorMessage,
                }));
              } catch { }
            }

            if (requestId !== activeRequestIdRef.current) return;

            const serverMapped: SupplierItem[] = data.suppliers.map((s: any) => ({
              _id: String(s._id || s.id || ""),
              supplierCode: s.supplierCode,
              name: s.name,
              contact: s.contact,
              address: s.address,
              tax: s.tax,
              paymentTerms: s.paymentTerms,
              status: s.status || "active",
              syncStatus: "SYNCED",
            }));

            // Merge server records with unsynced local records (deduplicating by authoritative _id)
            const serverIds = new Set(serverMapped.map((s) => s._id));
            const merged: SupplierItem[] = [...serverMapped];
            for (const p of localToMerge) {
              if (!serverIds.has(p._id)) {
                merged.push(p);
              }
            }
            merged.sort((a, b) => a.name.localeCompare(b.name));

            setSuppliers(merged);
            setIsOffline(false);
            setError(null);
            setLoading(false);
            return;
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError" || abortController.signal.aborted) {
          return;
        }
        if (requestId !== activeRequestIdRef.current) return;
      }
    }

    if (requestId !== activeRequestIdRef.current) return;

    // 2. Offline Fallback: verified offline session & tenant-partitioned cache only
    try {
      const restored = await restoreOfflineSession().catch(() => null);
      if (requestId !== activeRequestIdRef.current) return;

      if (!restored || !restored.ok || !restored.identity?.tenantId) {
        setSuppliers([]);
        setIsOffline(false);
        setError(
          restored?.reason ||
          "Offline access is not available for this account. Please sign in online first."
        );
        setLoading(false);
        return;
      }

      const tenantId = restored.identity.tenantId;
      const cached = cleanQ
        ? await searchCachedSuppliers(cleanQ, tenantId, { includeInactive: true, includeBlocked: true })
        : await getCachedSuppliersForTenant(tenantId, { includeInactive: true, includeBlocked: true });

      if (requestId !== activeRequestIdRef.current) return;

      if (cached.length === 0) {
        setSuppliers([]);
        setIsOffline(true);
        setEmptyCacheNotice(true);
        setError(null);
        setLoading(false);
        return;
      }

      const mapped: SupplierItem[] = cached.map((c) => ({
        _id: c.supplierId,
        supplierCode: c.supplierCode,
        name: c.name,
        contact: {
          contactPerson: c.contactPerson,
          phone: c.phone,
          email: c.email,
        },
        address: {
          line1: c.address || c.line1,
          state: c.state,
        },
        tax: {
          gstin: c.gstin,
        },
        paymentTerms: {
          type: c.paymentType,
          creditDays: c.creditDays,
        },
        status: c.status,
        syncStatus: c.syncStatus,
        errorMessage: c.errorMessage,
      }));

      setSuppliers(mapped);
      setIsOffline(true);
      setError(null);
    } catch {
      if (requestId !== activeRequestIdRef.current) return;
      setError("Failed to load supplier records.");
    } finally {
      if (requestId === activeRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const runBackgroundSync = useCallback(async () => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    let didSyncAny = false;
    try {
      let tenantId: string | null = null;
      const remembered = await readRememberedIdentity().catch(() => null);
      if (remembered?.tenantId) tenantId = remembered.tenantId;
      if (!tenantId) {
        const restored = await restoreOfflineSession().catch(() => null);
        if (restored?.identity?.tenantId) tenantId = restored.identity.tenantId;
      }
      if (tenantId) {
        await ensurePendingSuppliersQueued(tenantId).catch(() => 0);
      }
      const syncResult = await syncPendingOperations().catch(() => undefined);
      if (syncResult?.results && syncResult.results.some((r) => r.status === "SYNCED")) {
        didSyncAny = true;
      }
    } finally {
      isSyncingRef.current = false;
      if (didSyncAny) {
        void loadSuppliers(searchQueryRef.current);
      }
    }
  }, [loadSuppliers]);

  // Mount effect: handles initial loading and attaches network listeners
  useEffect(() => {
    void loadSuppliers("");

    if (typeof navigator !== "undefined" && navigator.onLine) {
      void runBackgroundSync();
    }

    const onOnline = () => {
      void runBackgroundSync();
    };
    const onOffline = () => {
      void loadSuppliers(searchQueryRef.current);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
      }
    };
  }, [loadSuppliers, runBackgroundSync]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void loadSuppliers(searchQuery);
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    void loadSuppliers("");
  };

  const handleCreateSupplier = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setFormError("Supplier name is required.");
      return;
    }

    setFormError(null);
    startTransition(async () => {
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // 1. Online creation attempt
      if (!isNavOffline) {
        try {
          const res = await fetch("/api/suppliers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
            body: JSON.stringify({
              name: cleanName,
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
            void loadSuppliers(searchQueryRef.current);
            return;
          }

          if (res.status === 400 || res.status === 401 || res.status === 403) {
            setFormError(data?.message || "Failed to create supplier");
            return;
          }
        } catch {
          // Network failed: proceed to offline creation
        }
      }

      // 2. Offline creation fallback via Dexie cache
      try {
        const restored = await restoreOfflineSession().catch(() => null);
        if (!restored || !restored.ok || !restored.identity?.tenantId) {
          setFormError(
            restored?.reason ||
            "Unable to create supplier offline. Please sign in online first."
          );
          return;
        }

        const saved = await savePendingOfflineSupplier(
          {
            name: cleanName,
            contactPerson: contactPerson.trim() || undefined,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            gstin: gstin.trim() || undefined,
            address: address.trim() || undefined,
            state: state.trim() || undefined,
            paymentType: paymentType === "credit" ? "credit" : "cash",
            creditDays: Number(creditDays) || 0,
          },
          restored.identity.tenantId,
          undefined,
          undefined,
          undefined
        );

        setName("");
        setContactPerson("");
        setPhone("");
        setEmail("");
        setGstin("");
        setAddress("");
        setState("");
        setCreditDays("0");
        setShowAddForm(false);

        // Prepend new pending record locally
        setSuppliers((prev) => [
          {
            _id: saved.supplier.supplierId,
            supplierCode: saved.supplier.supplierCode,
            name: saved.supplier.name,
            contact: {
              contactPerson: saved.supplier.contactPerson,
              phone: saved.supplier.phone,
              email: saved.supplier.email,
            },
            address: {
              line1: saved.supplier.address || saved.supplier.line1,
              state: saved.supplier.state,
            },
            tax: {
              gstin: saved.supplier.gstin,
            },
            paymentTerms: {
              type: saved.supplier.paymentType,
              creditDays: saved.supplier.creditDays,
            },
            status: saved.supplier.status,
            syncStatus: saved.supplier.syncStatus,
          },
          ...prev,
        ]);

        if (typeof navigator !== "undefined" && navigator.onLine) {
          void runBackgroundSync();
        }
      } catch (err: any) {
        setFormError(err?.message || "Unable to save supplier. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-5xl flex-col gap-4">
        {/* Offline notice banner */}
        {isOffline && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-2 font-medium">
              <span className="size-2 rounded-full bg-amber-500 animate-pulse" />
              Offline Mode — Viewing locally cached suppliers.
            </span>
            <span>New suppliers use provisional codes and will sync automatically when reconnected.</span>
          </div>
        )}

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
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">New supplier</h2>
              {isOffline && (
                <span className="text-xs text-amber-700 dark:text-amber-300 font-medium">
                  Saving offline with provisional code
                </span>
              )}
            </div>
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
                  onChange={(e) => setGstin(e.target.value)}
                  placeholder="e.g. 27AAPCA1234A1Z5"
                  maxLength={15}
                  className="font-mono uppercase"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-state">State</Label>
                <Input
                  id="sup-state"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  placeholder="e.g. Maharashtra"
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="sup-address">Address</Label>
                <Input
                  id="sup-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Shop / Plot number, Street, Area"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sup-payment-type">Payment terms</Label>
                <select
                  id="sup-payment-type"
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="cash">Cash / Immediate</option>
                  <option value="credit">Credit terms</option>
                </select>
              </div>
              {paymentType === "credit" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sup-credit-days">Credit days</Label>
                  <Input
                    id="sup-credit-days"
                    type="number"
                    min={0}
                    max={365}
                    value={creditDays}
                    onChange={(e) => setCreditDays(e.target.value)}
                    placeholder="30"
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving..." : isOffline ? "Save offline" : "Save supplier"}
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
              onClick={handleClearSearch}
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
        ) : emptyCacheNotice ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">No cached suppliers available offline</p>
            <p className="mt-1 text-xs">
              Supplier records for this business are cached automatically when you connect online.
            </p>
          </div>
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
                  <th className="p-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {suppliers.map((s) => (
                  <tr key={s._id} className="hover:bg-muted/30">
                    <td className="p-2.5 text-muted-foreground text-xs">
                      {isTemporarySupplierCode(s.supplierCode) ? (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-amber-800 dark:text-amber-300 border border-amber-500/20"
                          title="Provisional code generated offline. Server assigns official sequential code upon sync."
                        >
                          <span>{s.supplierCode}</span>
                          <span className="text-[9px] font-sans uppercase tracking-wider font-semibold opacity-75">(Provisional)</span>
                        </span>
                      ) : (
                        <span className="font-mono text-xs">{s.supplierCode || "—"}</span>
                      )}
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
                    <td className="p-2.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {s.syncStatus === "PENDING" && (
                          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            Pending sync
                          </span>
                        )}
                        {s.syncStatus === "NEEDS_ATTENTION" && (
                          <span
                            title={s.errorMessage || "Sync failed. Needs attention."}
                            className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300 cursor-help"
                          >
                            Sync failed
                          </span>
                        )}
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${s.status === "inactive" || s.status === "blocked"
                              ? "bg-muted text-muted-foreground"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            }`}
                        >
                          {s.status || "active"}
                        </span>
                      </div>
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
