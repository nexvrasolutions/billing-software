"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import {
  confirmServerSession,
  endOfflineAccess,
  getLastRenewalOutcome,
  isSessionRejected,
  renewalProblemText,
  restoreOfflineSession,
  SESSION_CHECK_TIMEOUT_MS,
} from "@/lib/offline/sessionIdentity";
import { countAllUnsyncedItems } from "@/lib/offline/pendingQueue";
import { attentionAdvice, describeUnsynced, type QueueSummary } from "@/lib/offline/queueStatus";
import { SyncNowButton } from "@/components/offline/SyncNowButton";
import { AutoSync } from "@/components/offline/AutoSync";
import {
  persistenceText,
  requestPersistentStorage,
  type PersistenceResult,
} from "@/lib/offline/storageDurability";
import {
  getOfflineAccessOverview,
  settlePendingServerLogout,
  signOutOffline,
  type OfflineAccessOverview,
} from "@/lib/offline/offlineAccess";
import { getCachedProductsForTenant } from "@/lib/offline/productCatalogueCache";
import type { SessionIdentity } from "@/lib/offline/syncPolicy";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";

type SessionCheckResult =
  | { status: "verified" }
  | { status: "offline"; identity: SessionIdentity; overview: OfflineAccessOverview }
  | { status: "unreachable"; reason: string; overview?: OfflineAccessOverview }
  | { status: "login" }
  | { status: "account" };

async function checkSession(): Promise<SessionCheckResult> {
  try {
    const pending = await settlePendingServerLogout();
    if (pending === "unreachable") {
      const restored = await restoreOfflineSession().catch(() => null);
      return {
        status: "unreachable",
        reason: restored?.reason || "A pending sign-out could not be completed yet.",
        overview: restored?.overview,
      };
    }
    if (pending === "done") return { status: "login" };

    const response = await fetch("/api/auth/me", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json().catch(() => null);

    if (isSessionRejected(response.status)) {
      await endOfflineAccess().catch(() => undefined);
      return { status: "login" };
    }

    if (!response.ok) {
      // Server error (502/503/504 etc): attempt offline restoration without requiring new online login
      const restored = await restoreOfflineSession().catch(() => null);
      if (restored && restored.ok && restored.identity && restored.overview) {
        return { status: "offline", identity: restored.identity, overview: restored.overview };
      }
      return {
        status: "unreachable",
        reason: restored?.reason || "Unable to contact the server to verify your session.",
        overview: restored?.overview,
      };
    }

    if (!data?.authenticated) {
      return { status: "login" };
    }

    await confirmServerSession(data, { renew: true }).catch(() => undefined);

    return { status: data?.user?.mustChangePassword ? "account" : "verified" };
  } catch {
    // Network failure / disconnected: restore existing locally persisted authorization
    const restored = await restoreOfflineSession().catch(() => null);
    if (restored && restored.ok && restored.identity && restored.overview) {
      return { status: "offline", identity: restored.identity, overview: restored.overview };
    }
    return {
      status: "unreachable",
      reason: restored?.reason || "Unable to contact the server to verify your session.",
      overview: restored?.overview,
    };
  }
}

function warmOfflinePages() {
  for (const path of ["/dashboard", "/offline-test", "/pos", "/catalog/products"]) {
    void fetch(path, { credentials: "same-origin" }).catch(() => undefined);
  }
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function itemsText(count: number) {
  return `${count} unsynced item${count === 1 ? "" : "s"}`;
}

function breakdownText(queue: QueueSummary) {
  const parts = describeUnsynced(queue);
  return parts ? ` (${parts})` : "";
}

const METHODS: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank: "Bank",
};

function OnlineOfflineStatus({ onFinished }: { onFinished?: () => void }) {
  return <AutoSync onFinished={onFinished} />;
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<"checking" | "verified" | "offline" | "unreachable">("checking");
  const [unreachableReason, setUnreachableReason] = useState<string>("");
  const [offlineIdentity, setOfflineIdentity] = useState<SessionIdentity | null>(null);
  const [overview, setOverview] = useState<OfflineAccessOverview | null>(null);
  const [persistence, setPersistence] = useState<PersistenceResult | null>(null);
  const [offlineMessage, setOfflineMessage] = useState("");

  // Real dashboard metrics
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [lowStock, setLowStock] = useState<{ name: string; sku: string; branch: string; quantity: string; reorderLevel: string }[]>([]);
  const [todayData, setTodayData] = useState({
    todayStr: new Date().toLocaleDateString("en-IN", { dateStyle: "medium" }),
    bills: 0,
    netSalesPaise: 0,
    returnsPaise: 0,
    totalReceivedPaise: 0,
    netPaymentsPaise: 0,
    receivablesPaise: 0,
    payablesPaise: 0,
    methods: [] as { method: string; netPaise: number }[],
  });

  const applySessionCheck = useCallback((result: SessionCheckResult) => {
    if (result.status === "login") {
      router.replace("/login");
    } else if (result.status === "account") {
      router.replace("/account");
    } else if (result.status === "offline") {
      setSession("offline");
      setOfflineIdentity(result.identity);
      setOverview(result.overview);
    } else if (result.status === "unreachable") {
      setSession("unreachable");
      setUnreachableReason(result.reason);
      if (result.overview) setOverview(result.overview);
    } else {
      setSession("verified");
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    checkSession().then((result) => {
      if (!cancelled) applySessionCheck(result);
    });

    return () => {
      cancelled = true;
    };
  }, [applySessionCheck]);

  useEffect(() => {
    if (session !== "unreachable" && session !== "offline") return;

    const onOnline = () => {
      setSession("checking");
      void checkSession().then(applySessionCheck);
    };

    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [session, applySessionCheck]);

  const refreshOverview = useCallback(() => {
    void getOfflineAccessOverview().then(setOverview).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (session !== "verified" && session !== "offline") return;

    if (session === "verified") {
      refreshOverview();
    }
    warmOfflinePages();
    void requestPersistentStorage(typeof navigator !== "undefined" ? navigator.storage : undefined)
      .then(setPersistence);

    // Fetch existing catalog to populate low stock and metrics cleanly
    async function loadMetrics(tenantId?: string) {
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      if (!isNavOffline) {
        try {
          const prodRes = await fetch("/api/products", {
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
          }).catch(() => null);
          if (prodRes && prodRes.ok) {
            const pData = await prodRes.json().catch(() => null);
            if (pData?.products && Array.isArray(pData.products)) {
              // Find items with zero or low stock
              const low = pData.products
                .filter((p: { stock?: number }) => typeof p.stock === "number" && p.stock <= 5)
                .slice(0, 5)
                .map((p: { name: string; SKU: string; stock?: number }) => ({
                  name: p.name,
                  sku: p.SKU,
                  branch: "Main Store",
                  quantity: String(p.stock ?? 0),
                  reorderLevel: "5",
                }));
              setLowStock(low);
              return;
            }
          }
        } catch {
          // Fall through to offline cache
        }
      }

      try {
        // When offline or API unavailable: load cached products for this tenant
        const targetTenant = tenantId || overview?.identity?.tenantId;
        if (targetTenant) {
          const cached = await getCachedProductsForTenant(targetTenant);
          if (cached && cached.length > 0) {
            const low = cached
              .filter((p) => typeof p.stockQuantity === "number" && p.stockQuantity <= 5)
              .slice(0, 5)
              .map((p) => ({
                name: p.name,
                sku: p.SKU,
                branch: "Main Store",
                quantity: String(p.stockQuantity ?? 0),
                reorderLevel: "5",
              }));
            setLowStock(low);
          }
        }
      } finally {
        setLoadingMetrics(false);
      }
    }

    loadMetrics(offlineIdentity?.tenantId);
  }, [session, refreshOverview, offlineIdentity, overview?.identity?.tenantId]);

  async function handleOfflineSignOut() {
    if (
      !window.confirm(
        "Sign out on this device? You will need to sign in online again. Waiting operations are kept on " +
          "this device and can only be sent by this account after it signs in again."
      )
    )
      return;
    const unsynced = overview?.unsyncedItems ?? 0;
    await signOutOffline().catch(() => undefined);
    setOfflineMessage(
      `Signed out on this device. The server session has NOT been ended yet; it will be ended ` +
        `automatically when this device reconnects. Your ${itemsText(unsynced)} are safe on this device.`
    );
    refreshOverview();
  }

  if (session === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 text-sm text-muted-foreground">
        <p role="status">Checking your session...</p>
      </div>
    );
  }

  if (session === "unreachable") {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6">
        <div role="alert" className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
          <p className="font-medium text-destructive">Unable to contact the server to verify your session.</p>
          <p className="text-muted-foreground">{unreachableReason || "Unable to reach the server. Please check your connection and try again."}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setSession("checking");
                void checkSession().then(applySessionCheck);
              }}
              className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
            >
              Try again
            </button>
          </div>
        </div>

        {/* Offline panel */}
        {overview && (
          <section aria-label="Offline session" className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
            <h2 className="text-base font-semibold">Offline session</h2>
            {offlineMessage && <p role="status" className="text-sm font-medium text-primary">{offlineMessage}</p>}
            {overview.allowed && overview.state.status === "available" ? (
              <div className="flex flex-col gap-3">
                <p>
                  Offline mode{overview.state.displayName ? ` for ${overview.state.displayName}` : ""}: offline session
                  expires at {formatTime(overview.state.expiresAt)}. {itemsText(overview.unsyncedItems)} waiting to sync
                  {breakdownText(overview.queue)}. {attentionAdvice(overview.queue)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link href="/pos" className="action-primary">
                    Open till (New bill)
                  </Link>
                  <Link href="/offline-test" className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted">
                    Offline queue &amp; test
                  </Link>
                  <button
                    type="button"
                    onClick={handleOfflineSignOut}
                    className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted"
                  >
                    Sign out offline
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-destructive font-medium">Offline billing is blocked.</p>
                <p className="text-muted-foreground">{unreachableReason || "Offline access is not available. Please verify session online."}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link href="/login" className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted">
                    Go to Login
                  </Link>
                  {overview.unsyncedItems > 0 && (
                    <Link href="/offline-test" className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted">
                      Inspect offline queue ({itemsText(overview.unsyncedItems)})
                    </Link>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    );
  }

  const renewalProblem = renewalProblemText(getLastRenewalOutcome());

  return (
    <AppShell>
      <main className="flex max-w-5xl flex-col gap-4">
        {/* Working offline indicator banner */}
        {session === "offline" && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3.5 text-sm" role="status" aria-label="Offline status banner">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-amber-900 dark:text-amber-200">
                  Working offline{overview?.state?.status === "available" && overview.state.displayName ? ` as ${overview.state.displayName}` : ""}
                </p>
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Offline session valid until {overview?.state?.status === "available" ? formatTime(overview.state.expiresAt) : "—"}. Server connection is currently unavailable.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSession("checking");
                    void checkSession().then(applySessionCheck);
                  }}
                  className="inline-flex h-8 items-center rounded-lg border border-amber-600/40 bg-background px-3 text-xs font-medium hover:bg-muted"
                >
                  Retry server
                </button>
                <button
                  type="button"
                  onClick={handleOfflineSignOut}
                  className="inline-flex h-8 items-center rounded-lg border border-amber-600/40 bg-background px-3 text-xs font-medium hover:bg-muted"
                >
                  Sign out offline
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Offline & durability status bar */}
        {overview && (overview.unsyncedItems > 0 || renewalProblem || (persistence && persistence !== "persisted")) && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm" aria-label="Offline status banner">
            {overview.unsyncedItems > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {itemsText(overview.unsyncedItems)} waiting to sync{breakdownText(overview.queue)}.
                  {" "}{attentionAdvice(overview.queue)}
                </span>
                <SyncNowButton onDone={refreshOverview} />
              </div>
            )}
            {renewalProblem && <p role="alert" className="text-destructive font-medium">{renewalProblem}</p>}
            {persistence && persistence !== "persisted" && (
              <p className="text-xs text-amber-700 dark:text-amber-400">{persistenceText(persistence)}</p>
            )}
            <OnlineOfflineStatus onFinished={refreshOverview} />
          </div>
        )}

        {/* Dashboard Top Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Today, {todayData.todayStr}</h1>
          <div className="flex gap-2 text-sm">
            <Link href="/pos" className="action-primary">
              New bill
            </Link>
            <Link
              href="/reports"
              className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
            >
              Reports
            </Link>
          </div>
        </div>

        {/* Metric Cards Grid matching reference */}
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Today">
          <div className="rounded-lg border bg-card p-3">
            <p className="text-sm text-muted-foreground">Net sales</p>
            <p className="text-2xl font-semibold tabular-nums">{formatPaise(todayData.netSalesPaise)}</p>
            <p className="text-xs text-muted-foreground">
              {todayData.bills} bill{todayData.bills === 1 ? "" : "s"}
              {todayData.returnsPaise > 0 ? ` · returns ${formatPaise(todayData.returnsPaise)}` : ""}
            </p>
          </div>

          <div className="rounded-lg border bg-card p-3">
            <p className="text-sm text-muted-foreground">Money in today</p>
            <p className="text-2xl font-semibold tabular-nums">{formatPaise(todayData.totalReceivedPaise)}</p>
            <p className="text-xs text-muted-foreground">
              after refunds and expenses: {formatPaise(todayData.netPaymentsPaise)}
            </p>
          </div>

          <Link href="/reports" className="rounded-lg border bg-card p-3 hover:bg-muted/40 transition-colors">
            <p className="text-sm text-muted-foreground">Customers owe you</p>
            <p className="text-2xl font-semibold tabular-nums">{formatPaise(todayData.receivablesPaise)}</p>
          </Link>

          <Link href="/reports" className="rounded-lg border bg-card p-3 hover:bg-muted/40 transition-colors">
            <p className="text-sm text-muted-foreground">You owe suppliers</p>
            <p className="text-2xl font-semibold tabular-nums">{formatPaise(todayData.payablesPaise)}</p>
          </Link>
        </section>

        {/* 2-Column Split: Payments by Method and Low Stock */}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="flex flex-col gap-2 rounded-lg border bg-card p-4" aria-label="Payments by method">
            <h2 className="font-medium">Payments by method</h2>
            {todayData.methods.length === 0 ? (
              <p className="text-sm text-muted-foreground">No money in or out yet today.</p>
            ) : (
              todayData.methods.map((m) => (
                <p key={m.method} className="flex justify-between text-sm">
                  <span>{METHODS[m.method] ?? m.method}</span>
                  <span className="tabular-nums">{formatPaise(m.netPaise)}</span>
                </p>
              ))
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-lg border bg-card p-4" aria-label="Low stock">
            <h2 className="font-medium">Low stock</h2>
            {loadingMetrics ? (
              <p className="text-sm text-muted-foreground">Checking stock levels...</p>
            ) : lowStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing at or below its reorder level.</p>
            ) : (
              lowStock.map((r) => (
                <p key={`${r.sku}-${r.branch}`} className="flex justify-between text-sm">
                  <span>
                    {r.name} <span className="text-muted-foreground">({r.branch})</span>
                  </span>
                  <span className="tabular-nums">
                    {formatQuantity(r.quantity)} / {formatQuantity(r.reorderLevel)}
                  </span>
                </p>
              ))
            )}
            {lowStock.length > 0 && (
              <Link href="/inventory" className="text-sm underline">
                All stock
              </Link>
            )}
          </section>
        </div>
      </main>
    </AppShell>
  );
}
