"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { restoreOfflineSession, readRememberedIdentity } from "@/lib/offline/offlineAccess";
import {
  getCachedCustomersForTenant,
  searchCachedCustomers,
  saveCachedCustomers,
  savePendingOfflineCustomer,
  ensurePendingCustomersQueued,
} from "@/lib/offline/customerCache";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import { syncPendingOperations } from "@/lib/offline/SyncManager";

interface CustomerItem {
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

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [emptyCacheNotice, setEmptyCacheNotice] = useState(false);

  // New customer form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Request sequencing, cancellation, and concurrency guards
  const activeRequestIdRef = useRef(0);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const isSyncingRef = useRef(false);
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const lastQueriedQueryRef = useRef<string | null>("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCustomers = useCallback(async (q = "") => {
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
          ? `/api/customers?q=${encodeURIComponent(cleanQ)}`
          : "/api/customers";

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
          setCustomers([]);
          setIsOffline(false);
          setError(
            res.status === 401
              ? "Please sign in to access customers."
              : "You do not have permission to view customers."
          );
          setLoading(false);
          return;
        }

        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (requestId !== activeRequestIdRef.current) return;

          if (data?.success && Array.isArray(data.customers)) {
            // Determine tenantId safely for local caching and customer lookup
            let tenantId: string | null = null;
            if (data.customers.length > 0 && data.customers[0]?.tenantId) {
              tenantId = String(data.customers[0].tenantId);
            }
            if (!tenantId) {
              const remembered = await readRememberedIdentity().catch(() => null);
              tenantId = remembered?.tenantId ?? null;
            }
            if (!tenantId) {
              const restored = await restoreOfflineSession().catch(() => null);
              tenantId = restored?.identity?.tenantId ?? null;
            }
            if (!tenantId) {
              const authRes = await fetch("/api/auth/me", { credentials: "same-origin" }).catch(() => null);
              const authData = await authRes?.json().catch(() => null);
              if (authData?.tenant?.id) {
                tenantId = String(authData.tenant.id);
              }
            }

            if (tenantId) {
              await saveCachedCustomers(data.customers, tenantId).catch(() => undefined);
            }

            if (requestId !== activeRequestIdRef.current) return;

            // Retrieve local pending, needs-attention, and recently synced records to reconcile alongside server records
            let localToMerge: CustomerItem[] = [];
            if (tenantId) {
              try {
                const cachedRecords = await getCachedCustomersForTenant(tenantId, { includeInactive: true });
                const nowMs = Date.now();
                const RECENT_SYNC_WINDOW_MS = 2 * 60 * 1000; // 2-minute bounded reconciliation window

                let filteredLocal = cachedRecords.filter((r) => {
                  if (r.syncStatus === "PENDING" || r.syncStatus === "NEEDS_ATTENTION") {
                    return true;
                  }
                  // Keep recently synced records visible during the brief window before server query catches up
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
                      (p.email && p.email.toLowerCase().includes(lowerQ))
                  );
                }

                localToMerge = filteredLocal.map((r) => ({
                  _id: r.customerId,
                  name: r.name,
                  phone: r.phone,
                  email: r.email,
                  address: r.address,
                  status: r.status,
                  syncStatus: r.syncStatus,
                  errorMessage: r.errorMessage,
                }));
              } catch {}
            }

            if (requestId !== activeRequestIdRef.current) return;

            const serverMapped: CustomerItem[] = data.customers.map((c: any) => ({
              _id: String(c._id || c.id || ""),
              name: c.name,
              phone: c.phone,
              email: c.email,
              address: c.address,
              status: c.status === "inactive" ? "inactive" : "active",
              createdAt: c.createdAt,
              syncStatus: "SYNCED",
            }));

            // Merge server records with unsynced and recently synced local records (deduplicating by authoritative _id)
            const serverIds = new Set(serverMapped.map((s) => s._id));
            const merged: CustomerItem[] = [...serverMapped];
            for (const p of localToMerge) {
              if (!serverIds.has(p._id)) {
                merged.push(p);
              }
            }
            merged.sort((a, b) => a.name.localeCompare(b.name));

            setCustomers(merged);
            setIsOffline(false);
            setError(null);
            setLoading(false);
            return;
          }
        }
        // Server returned 500/503 (Atlas offline): proceed to offline cache fallback
      } catch (err: any) {
        if (err?.name === "AbortError" || abortController.signal.aborted) {
          // Newer request superseded this one; discard silently
          return;
        }
        if (requestId !== activeRequestIdRef.current) return;
        // Network timeout or fetch failure: proceed to offline cache fallback
      }
    }

    if (requestId !== activeRequestIdRef.current) return;

    // 2. Offline Fallback: verified offline session & tenant-partitioned cache only
    try {
      const restored = await restoreOfflineSession().catch(() => null);
      if (requestId !== activeRequestIdRef.current) return;

      if (!restored || !restored.ok || !restored.identity?.tenantId) {
        setCustomers([]);
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
        ? await searchCachedCustomers(cleanQ, tenantId, { includeInactive: true })
        : await getCachedCustomersForTenant(tenantId, { includeInactive: true });

      if (requestId !== activeRequestIdRef.current) return;

      if (cached.length === 0) {
        setCustomers([]);
        setIsOffline(true);
        setEmptyCacheNotice(true);
        setError(null);
        setLoading(false);
        return;
      }

      const mapped: CustomerItem[] = cached.map((c) => ({
        _id: c.customerId,
        name: c.name,
        phone: c.phone,
        email: c.email,
        address: c.address,
        status: c.status,
        syncStatus: c.syncStatus,
        errorMessage: c.errorMessage,
      }));

      setCustomers(mapped);
      setIsOffline(true);
      setError(null);
    } catch {
      if (requestId !== activeRequestIdRef.current) return;
      setError("Failed to load customer records.");
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
        await ensurePendingCustomersQueued(tenantId).catch(() => 0);
      }
      const syncResult = await syncPendingOperations().catch(() => undefined);
      if (syncResult?.results && syncResult.results.some((r) => r.status === "SYNCED")) {
        didSyncAny = true;
      }
    } finally {
      isSyncingRef.current = false;
      if (didSyncAny) {
        void loadCustomers(searchQueryRef.current);
      }
    }
  }, [loadCustomers]);

  // Mount effect: handles initial loading and attaches network listeners without depending on searchQuery
  useEffect(() => {
    void loadCustomers("");

    if (typeof navigator !== "undefined" && navigator.onLine) {
      void runBackgroundSync();
    }

    const onOnline = () => {
      void runBackgroundSync();
    };
    const onOffline = () => {
      void loadCustomers(searchQueryRef.current);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
      }
    };
  }, [loadCustomers, runBackgroundSync]);

  // Debounced search on user input: avoids spamming requests on every keystroke
  useEffect(() => {
    const cleanQ = searchQuery.trim();
    // Prevent duplicate requests if the trimmed query matches what was already queried
    // (covers initial mount with empty string and Strict Mode remounts)
    if (cleanQ === (lastQueriedQueryRef.current ?? "")) {
      return;
    }

    const timer = setTimeout(() => {
      void loadCustomers(searchQuery);
    }, 350);
    debounceTimerRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (debounceTimerRef.current === timer) {
        debounceTimerRef.current = null;
      }
    };
  }, [searchQuery, loadCustomers]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    void loadCustomers(searchQuery);
  };

  const handleClearSearch = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setSearchQuery("");
    void loadCustomers("");
  };

  const handleCreateCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setFormError("Customer name is required.");
      return;
    }

    setFormError(null);
    startTransition(async () => {
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // 1. If online, attempt server creation first
      if (!isNavOffline) {
        try {
          const res = await fetch("/api/customers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
            body: JSON.stringify({
              name: cleanName,
              phone: phone.trim() || undefined,
              email: email.trim() || undefined,
              address: address.trim() || undefined,
            }),
          });

          const data = await res.json().catch(() => null);

          if (res.ok && data?.success) {
            setName("");
            setPhone("");
            setEmail("");
            setAddress("");
            setShowAddForm(false);
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = null;
            }
            void loadCustomers(searchQuery);
            return;
          }

          if (res.status === 400 || res.status === 401 || res.status === 403) {
            setFormError(data?.message || "Failed to create customer");
            return;
          }
          // Server returned 500 or 503 (Atlas offline): proceed to offline creation
        } catch {
          // Network failed: proceed to offline creation
        }
      }

      // 2. Offline customer creation via verified offline session
      try {
        const restored = await restoreOfflineSession().catch(() => null);
        if (!restored || !restored.ok || !restored.identity?.tenantId) {
          setFormError(
            restored?.reason ||
            "Unable to save customer offline. Please sign in online before working offline."
          );
          return;
        }

        await savePendingOfflineCustomer(
          {
            name: cleanName,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            address: address.trim() || undefined,
          },
          restored.identity.tenantId
        );

        setName("");
        setPhone("");
        setEmail("");
        setAddress("");
        setShowAddForm(false);
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        void loadCustomers(searchQuery);
      } catch (err: any) {
        setFormError(err?.message || "Unable to save customer. Please try again.");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
            <p className="text-xs text-muted-foreground">
              Manage retail and account customers, credit balances, and contact details.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? "Cancel" : "Add customer"}
          </Button>
        </div>

        {/* Offline Status Banner */}
        {isOffline && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-2 font-medium">
              <span className="size-2 rounded-full bg-amber-500 animate-pulse" />
              Offline Mode — Viewing locally cached customer records for this business.
            </span>
            <span>New customers created offline will sync automatically when reconnected.</span>
          </div>
        )}

        {/* Add Customer Form */}
        {showAddForm && (
          <form
            onSubmit={handleCreateCustomer}
            className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
          >
            <h2 className="font-semibold">New customer</h2>
            {formError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {formError}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-name">Name *</Label>
                <Input
                  id="cust-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Customer or business name"
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-phone">Phone number</Label>
                <Input
                  id="cust-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 9876543210"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-email">Email</Label>
                <Input
                  id="cust-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="customer@example.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-address">Billing address</Label>
                <Input
                  id="cust-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street, city, pin code"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving..." : isOffline ? "Save offline" : "Save customer"}
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
            placeholder="Search by name, phone or email..."
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

        {/* Customer List Display */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading customers...</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : emptyCacheNotice ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">No cached customers available offline</p>
            <p className="mt-1 text-xs">
              Customer records for this business are cached automatically when you connect online.
            </p>
          </div>
        ) : customers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {searchQuery ? "No customers matching your search." : "No customers added yet."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="w-full text-sm" aria-label="Customers">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2.5 font-medium">Customer name</th>
                  <th className="p-2.5 font-medium">Phone</th>
                  <th className="p-2.5 font-medium">Email</th>
                  <th className="p-2.5 font-medium">Address</th>
                  <th className="p-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {customers.map((c) => (
                  <tr key={c._id} className="hover:bg-muted/30">
                    <td className="p-2.5">
                      <Link
                        href={`/customers/${c._id}`}
                        className="font-medium underline hover:text-primary"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="p-2.5 text-muted-foreground">{c.phone || "—"}</td>
                    <td className="p-2.5 text-muted-foreground">{c.email || "—"}</td>
                    <td className="p-2.5 text-muted-foreground truncate max-w-[200px]">
                      {c.address || "—"}
                    </td>
                    <td className="p-2.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {c.syncStatus === "PENDING" && (
                          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            Pending sync
                          </span>
                        )}
                        {c.syncStatus === "NEEDS_ATTENTION" && (
                          <span
                            title={c.errorMessage || "Sync failed. Needs attention."}
                            className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300 cursor-help"
                          >
                            Sync failed
                          </span>
                        )}
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                            c.status === "active"
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {c.status}
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
