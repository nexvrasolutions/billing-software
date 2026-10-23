"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { formatPaise } from "@/lib/money";
import {
  saveCachedProducts,
  getCachedProductsForTenant,
} from "@/lib/offline/productCatalogueCache";
import {
  getCachedCategoriesForTenant,
  saveCachedCategories,
} from "@/lib/offline/categoryUnitCache";
import { restoreOfflineSession } from "@/lib/offline/offlineAccess";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import {
  filterProducts,
  formatStockBadge,
  type ProductItem,
  type ProductStatusFilter,
  type ProductStockFilter,
} from "@/lib/catalog/productFilter";

interface CategoryDto {
  id: string;
  name: string;
}

export default function ProductsPage() {
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>("all");
  const [stockFilter, setStockFilter] = useState<ProductStockFilter>("all");

  const [products, setProducts] = useState<ProductItem[]>([]);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [emptyCacheNotice, setEmptyCacheNotice] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      let fetchedCategories: unknown[] = [];
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // 1. If online, attempt to fetch categories and products
      if (!isNavOffline) {
        // 1a. Fetch categories
        try {
          const catRes = await fetch("/api/categories", {
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
          });
          if (catRes.ok) {
            const catData = await catRes.json();
            if (!cancelled && catData?.categories && Array.isArray(catData.categories)) {
              fetchedCategories = catData.categories;
              setCategories(
                catData.categories.map((c: { _id?: string; id?: string; name: string }) => ({
                  id: String(c._id || c.id),
                  name: c.name,
                }))
              );
            }
          }
        } catch {
          // Categories fetch failed or offline; continue
        }

        // 1b. Fetch products online
        try {
          const res = await fetch("/api/products", {
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
          });

          // Definitively unauthenticated: do not expose offline cache
          if (res.status === 401 || res.status === 403) {
            setProducts([]);
            setIsOffline(false);
            setLoading(false);
            return;
          }

          if (res.ok) {
            const data = await res.json();
            if (!cancelled && data?.products && Array.isArray(data.products)) {
              // Safely update offline cache if tenantId is available
              const tenantId = data.products[0]?.tenantId ? String(data.products[0].tenantId) : null;
              if (tenantId) {
                await saveCachedProducts(tenantId, data.products).catch(() => undefined);
                if (fetchedCategories.length > 0) {
                  await saveCachedCategories(tenantId, fetchedCategories).catch(() => undefined);
                }
              }

              const mapped: ProductItem[] = data.products.map((p: {
                _id?: string;
                id?: string;
                name: string;
                SKU: string;
                barcode?: string;
                categoryId?: string;
                sellingPrice: number;
                stockQuantity?: number;
                stock?: number;
                status?: string;
              }) => ({
                id: p._id || p.id || p.SKU,
                name: p.name,
                sku: p.SKU,
                barcode: p.barcode ? String(p.barcode).trim() : undefined,
                categoryId: p.categoryId ? String(p.categoryId) : undefined,
                pricePaise: Math.round((p.sellingPrice ?? 0) * 100),
                stockQuantity: typeof p.stockQuantity === "number" ? p.stockQuantity : typeof p.stock === "number" ? p.stock : 0,
                active: p.status !== "inactive",
                syncStatus: "SYNCED",
              }));

              setProducts(mapped);
              setIsOffline(false);
              setEmptyCacheNotice(false);
              setLoading(false);
              return;
            }
          }
        } catch {
          // Offline, timeout, or server error: proceed to offline cache fallback
        }
      }

      // 2. Offline fallback: load cached catalogue from verified offline session
      try {
        const restored = await restoreOfflineSession().catch(() => null);
        if (restored?.ok && restored.identity?.tenantId) {
          const [cached, cachedCats] = await Promise.all([
            getCachedProductsForTenant(restored.identity.tenantId),
            getCachedCategoriesForTenant(restored.identity.tenantId, { includeInactive: true }),
          ]);
          if (!cancelled && cachedCats.length > 0) {
            setCategories(
              cachedCats.map((c) => ({
                id: c._id,
                name: c.name,
              }))
            );
          }
          if (!cancelled) {
            if (cached.length === 0) {
              setProducts([]);
              setIsOffline(true);
              setEmptyCacheNotice(true);
            } else {
              const mapped: ProductItem[] = cached.map((p) => ({
                id: p.productId,
                name: p.name,
                sku: p.SKU,
                barcode: p.barcode,
                categoryId: p.categoryId,
                pricePaise: Math.round((p.sellingPrice ?? 0) * 100),
                stockQuantity: p.stockQuantity ?? 0,
                active: p.status !== "inactive",
                syncStatus: p.syncStatus ?? "SYNCED",
                errorMessage: p.errorMessage,
              }));
              setProducts(mapped);
              setIsOffline(true);
              setEmptyCacheNotice(false);
            }
          }
        }
      } catch {
        // Cache read failed
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadData();

    const onOnline = () => { void loadData(); };
    const onOffline = () => { void loadData(); };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) {
      map.set(c.id, c.name);
    }
    return map;
  }, [categories]);

  const filtered = useMemo(() => {
    return filterProducts(products, {
      query: q,
      categoryId: categoryFilter,
      status: statusFilter,
      stockLevel: stockFilter,
    });
  }, [products, q, categoryFilter, statusFilter, stockFilter]);

  const hasActiveFilters =
    q.trim() !== "" ||
    categoryFilter !== "all" ||
    statusFilter !== "all" ||
    stockFilter !== "all";

  const resetFilters = () => {
    setQ("");
    setCategoryFilter("all");
    setStatusFilter("all");
    setStockFilter("all");
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        {/* Header matching reference repo */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link href="/catalog/lists" className="underline">
              Categories, brands, units
            </Link>
            <Link href="/catalog/products/new" className="action-primary">
              New product
            </Link>
          </div>
        </div>

        {isOffline && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
          >
            Offline catalogue: showing cached products. Changes made online will refresh when reconnected.
          </div>
        )}

        {/* Filter controls */}
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => e.preventDefault()}
            className="flex-1 min-w-[200px]"
            role="search"
          >
            <input
              name="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, SKU, or barcode"
              aria-label="Search products"
              autoFocus
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
          </form>

          {categories.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filter by category"
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProductStatusFilter)}
            aria-label="Filter by status"
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>

          <select
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value as ProductStockFilter)}
            aria-label="Filter by stock"
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            <option value="all">All stock</option>
            <option value="in-stock">In stock (&gt; 0)</option>
            <option value="low-stock">Low stock (&le; 10)</option>
            <option value="out-of-stock">Out of stock (0)</option>
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetFilters}
              className="text-xs text-muted-foreground underline hover:text-foreground ml-1"
            >
              Reset
            </button>
          )}
        </div>

        {/* Content & List */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading products...</p>
        ) : emptyCacheNotice ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">No cached products available offline</p>
            <p className="mt-1 text-xs">
              Product catalogue for this business is cached automatically when you connect online.
            </p>
          </div>
        ) : products.length === 0 ? (
          <p className="text-sm text-muted-foreground">No products yet.</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col gap-2 py-4">
            <p className="text-sm text-muted-foreground">Nothing matches your search or filters.</p>
            <button
              type="button"
              onClick={resetFilters}
              className="self-start text-xs underline text-muted-foreground hover:text-foreground"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border bg-card" aria-label="Products">
            {filtered.map((p) => {
              const stock = formatStockBadge(p.stockQuantity);
              const categoryName = p.categoryId ? categoryMap.get(p.categoryId) : undefined;

              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 p-3 text-sm"
                  aria-label={p.name}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <Link
                      href={`/catalog/products/${p.id}`}
                      className="font-medium underline hover:text-primary transition-colors truncate"
                    >
                      {p.name}
                    </Link>
                    <div className="text-xs text-muted-foreground truncate">
                      <span>{p.sku}</span>
                      {p.barcode && <span> · barcode {p.barcode}</span>}
                      {categoryName && <span> · {categoryName}</span>}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-right">
                    <span className="font-medium text-foreground">
                      {formatPaise(p.pricePaise)}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span
                      className={
                        stock.tone === "out"
                          ? "text-destructive font-medium"
                          : stock.tone === "low"
                          ? "text-amber-700 dark:text-amber-400 font-medium"
                          : "text-muted-foreground"
                      }
                    >
                      {stock.label}
                    </span>
                    {p.syncStatus === "PENDING" && (
                      <span className="rounded bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        Pending sync
                      </span>
                    )}
                    {p.syncStatus === "NEEDS_ATTENTION" && (
                      <span
                        title={p.errorMessage || "Sync conflict requires attention"}
                        className="rounded bg-destructive/10 border border-destructive/30 px-1.5 py-0.5 text-xs font-medium text-destructive"
                      >
                        Needs attention
                      </span>
                    )}
                    {isOffline && p.syncStatus === "SYNCED" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        Synced
                      </span>
                    )}
                    {!p.active && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        archived
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </AppShell>
  );
}
