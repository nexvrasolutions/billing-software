"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getCachedCategoriesForTenant,
  getCachedUnitsForTenant,
  saveCachedCategories,
  saveCachedUnits,
} from "@/lib/offline/categoryUnitCache";
import {
  checkOfflineProductCreation,
  readRememberedIdentity,
} from "@/lib/offline/offlineAccess";
import { savePendingOfflineProduct } from "@/lib/offline/productCatalogueCache";
import { addToSyncQueue } from "@/lib/offline/SyncQueueService";
import { newOperationId } from "@/lib/offline/syncPolicy";
import {
  getProductSubmissionFingerprint,
  resolveProductOperationId,
  type ProductSubmissionRecord,
} from "@/lib/catalog/productOperationId";

interface CategoryOption {
  _id: string;
  name: string;
}

interface UnitOption {
  _id: string;
  name: string;
  shortName: string;
}

export default function NewProductPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [taxRate, setTaxRate] = useState("18");
  const [hsnCode, setHsnCode] = useState("");
  const [openingStock, setOpeningStock] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [canCost, setCanCost] = useState(true);
  const [offlineAllowed, setOfflineAllowed] = useState(true);
  const [offlineReason, setOfflineReason] = useState<string | null>(null);
  const [offlineTenantId, setOfflineTenantId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submittingRef = useRef(false);
  const lastSubmissionRef = useRef<ProductSubmissionRecord | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      // 1. Try online fetch
      try {
        const [catRes, unitRes] = await Promise.all([
          fetch("/api/categories", { credentials: "same-origin" }),
          fetch("/api/units", { credentials: "same-origin" }),
        ]);

        let cList: CategoryOption[] = [];
        let uList: UnitOption[] = [];

        if (catRes.ok) {
          const cData = await catRes.json();
          if (cData?.categories && Array.isArray(cData.categories)) {
            // Filter active categories for dropdown
            cList = cData.categories.filter((c: any) => c.status !== "inactive");
            if (!cancelled) {
              setCategories(cList);
              if (cList[0]?._id) setCategoryId((prev) => prev || cList[0]._id);
            }
          }
        }

        if (unitRes.ok) {
          const uData = await unitRes.json();
          if (uData?.units && Array.isArray(uData.units)) {
            // Filter active units for dropdown
            uList = (uData.units as any[])
              .filter((u: any) => u.status !== "inactive")
              .map((u: any) => ({
                _id: String(u._id || u.id),
                name: u.name,
                shortName: u.shortName || u.code || "pcs",
              }));
            if (!cancelled) {
              setUnits(uList);
              if (uList[0]?._id) setUnitId((prev) => prev || uList[0]._id);
            }
          }
        }

        if (catRes.ok && unitRes.ok) {
          if (!cancelled) {
            setIsOffline(false);
            setOfflineAllowed(true);
            setOfflineReason(null);
          }

          // Refresh offline cache with authenticated tenant
          const rawTenantId = catDataTenant(catRes, unitRes);
          const remembered = await readRememberedIdentity().catch(() => null);
          const tenantId = rawTenantId || remembered?.tenantId;
          if (tenantId) {
            if (cList.length > 0) void saveCachedCategories(tenantId, cList).catch(() => undefined);
            if (uList.length > 0) void saveCachedUnits(tenantId, uList).catch(() => undefined);
          }
          return;
        }
      } catch {
        // Network error or offline: proceed to offline cache fallback
      }

      // 2. Offline Fallback: check offline product creation permission & load cached reference data
      try {
        const authCheck = await checkOfflineProductCreation();

        if (!authCheck.ok) {
          if (!cancelled) {
            setIsOffline(true);
            setOfflineAllowed(false);
            setOfflineReason(authCheck.reason);
            setCategories([]);
            setUnits([]);
          }
          return;
        }

        const tenantId = authCheck.identity.tenantId;
        if (!cancelled) {
          setOfflineTenantId(tenantId);
          setCanCost(authCheck.canCost);
          setOfflineAllowed(true);
          setOfflineReason(null);
        }

        const [cachedCats, cachedUnits] = await Promise.all([
          getCachedCategoriesForTenant(tenantId),
          getCachedUnitsForTenant(tenantId),
        ]);

        if (!cancelled) {
          if (cachedCats.length > 0) {
            setCategories(cachedCats);
            if (cachedCats[0]?._id) setCategoryId((prev) => prev || cachedCats[0]._id);
          } else {
            setCategories([]);
          }

          if (cachedUnits.length > 0) {
            setUnits(cachedUnits);
            if (cachedUnits[0]?._id) setUnitId((prev) => prev || cachedUnits[0]._id);
          } else {
            setUnits([]);
          }

          setIsOffline(true);
        }
      } catch {
        if (!cancelled) {
          setIsOffline(true);
          setOfflineAllowed(false);
          setOfflineReason("Unable to verify offline authorization.");
        }
      }
    }

    void loadOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  function catDataTenant(catRes: any, unitRes: any): string | null {
    try {
      return null;
    } catch {
      return null;
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (submittingRef.current) return;

    const sPrice = Number(sellingPrice);
    const pPrice = canCost && purchasePrice.trim() !== "" ? Number(purchasePrice) : 0;

    if (isNaN(sPrice) || sPrice < 0) {
      setError("Please enter a valid selling price.");
      return;
    }

    if (canCost && (isNaN(pPrice) || pPrice < 0)) {
      setError("Please enter a valid cost price.");
      return;
    }

    if (!categoryId || !unitId) {
      setError("Category and Unit are required.");
      return;
    }

    const tRate = taxRate.trim() !== "" ? Number(taxRate) : undefined;
    if (tRate !== undefined && (isNaN(tRate) || tRate < 0 || tRate > 100)) {
      setError("Please enter a valid GST rate between 0 and 100%.");
      return;
    }

    const initStock = openingStock.trim() !== "" ? Number(openingStock) : 0;
    if (isNaN(initStock) || initStock < 0) {
      setError("Please enter a valid non-negative opening stock quantity.");
      return;
    }

    // OFFLINE CREATION WORKFLOW
    if (isOffline || (typeof navigator !== "undefined" && !navigator.onLine)) {
      if (!offlineAllowed) {
        setError(offlineReason || "Offline product creation is not permitted.");
        return;
      }

      if (!offlineTenantId) {
        setError("Offline tenant identity missing. Please sign in online first.");
        return;
      }

      if (categories.length === 0 || units.length === 0) {
        setError("Reference categories and units must be synchronized before creating products offline. Please connect online to synchronize.");
        return;
      }

      submittingRef.current = true;
      startTransition(async () => {
        try {
          const localId = "prod_" + crypto.randomUUID();
          const operationId = newOperationId();

          // 1. Save locally with PENDING status in Dexie cachedProducts
          await savePendingOfflineProduct({
            tenantId: offlineTenantId,
            productId: localId,
            name: name.trim(),
            SKU: sku.trim(),
            barcode: barcode.trim() ? barcode.trim().toUpperCase() : undefined,
            categoryId,
            unitId,
            sellingPrice: sPrice,
            stockQuantity: initStock,
            taxRate: tRate,
            hsnCode: hsnCode.trim() || undefined,
            operationId,
          });

          // 2. Enqueue creation operation into syncQueue
          await addToSyncQueue({
            entityType: "Product",
            operationType: "CREATE",
            operationId,
            payload: {
              localId,
              name: name.trim(),
              SKU: sku.trim(),
              ...(barcode.trim() ? { barcode: barcode.trim().toUpperCase() } : {}),
              categoryId,
              unitId,
              sellingPrice: sPrice,
              purchasePrice: canCost ? pPrice : 0,
              ...(tRate !== undefined ? { taxRate: tRate } : {}),
              ...(hsnCode.trim() ? { hsnCode: hsnCode.trim() } : {}),
              ...(initStock > 0 ? { initialStock: initStock } : {}),
              status: "active",
            },
          });

          router.push("/catalog/products");
        } catch (err: any) {
          setError(err?.message || "Failed to save product locally.");
        } finally {
          submittingRef.current = false;
        }
      });
      return;
    }

    // ONLINE CREATION WORKFLOW
    submittingRef.current = true;
    startTransition(async () => {
      try {
        const fingerprint = getProductSubmissionFingerprint({
          name,
          SKU: sku,
          barcode,
          categoryId,
          unitId,
          sellingPrice: sPrice,
          purchasePrice: canCost ? pPrice : 0,
          taxRate: tRate,
          hsnCode: hsnCode.trim() || undefined,
          openingStock: initStock,
        });

        const { operationId: opId } = resolveProductOperationId(
          lastSubmissionRef.current,
          fingerprint
        );
        lastSubmissionRef.current = {
          operationId: opId,
          fingerprint,
        };

        const res = await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            name: name.trim(),
            SKU: sku.trim(),
            barcode: barcode.trim() ? barcode.trim().toUpperCase() : undefined,
            categoryId,
            unitId,
            sellingPrice: sPrice,
            purchasePrice: canCost ? pPrice : 0,
            ...(tRate !== undefined ? { taxRate: tRate } : {}),
            ...(hsnCode.trim() ? { hsnCode: hsnCode.trim() } : {}),
            openingStock: initStock,
            operationId: opId,
            status: "active",
          }),
        });

        const data = await res.json().catch(() => null);

        if (!res.ok || !data?.success) {
          setError(data?.message || "Failed to create product.");
          return;
        }

        lastSubmissionRef.current = null;
        router.push("/catalog/products");
      } catch {
        setError("Network error. Could not connect to server.");
      } finally {
        submittingRef.current = false;
      }
    });
  };

  const missingReferenceData = isOffline && (categories.length === 0 || units.length === 0);
  const isSubmitDisabled = pending || (isOffline && (!offlineAllowed || missingReferenceData));

  return (
    <AppShell>
      <main className="flex max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link href="/catalog/products" className="text-sm underline">
            ← Products
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
        </div>

        {isOffline && (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-foreground"
          >
            <p className="font-semibold text-amber-800 dark:text-amber-200">
              Working offline
            </p>
            {offlineAllowed ? (
              <p className="text-muted-foreground">
                Products created offline are saved locally and will synchronize when connectivity returns. They are immediately available for POS sales.
              </p>
            ) : (
              <p className="text-destructive font-medium">
                {offlineReason || "Offline product creation is disabled for this session."}
              </p>
            )}
            {missingReferenceData && (
              <p className="text-amber-900 dark:text-amber-100 font-medium mt-1">
                Categories and units have not been cached yet. Please connect online once to synchronize reference data.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive font-medium">
            {error}
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="product-name">Product name</Label>
            <Input
              id="product-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cotton Casual Shirt"
              required
              maxLength={200}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-sku">SKU</Label>
              <Input
                id="product-sku"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. SHIRT-001"
                required
                maxLength={100}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-barcode">Barcode (optional)</Label>
              <Input
                id="product-barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="Scan or type barcode"
                maxLength={100}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-category">Category</Label>
              <select
                id="product-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                required
                disabled={categories.length === 0}
              >
                {categories.length === 0 ? (
                  <option value="">No categories available</option>
                ) : (
                  categories.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-unit">Unit</Label>
              <select
                id="product-unit"
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                required
                disabled={units.length === 0}
              >
                {units.length === 0 ? (
                  <option value="">No units available</option>
                ) : (
                  units.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name} ({u.shortName})
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="selling-price">Selling price (₹)</Label>
              <Input
                id="selling-price"
                value={sellingPrice}
                onChange={(e) => setSellingPrice(e.target.value)}
                type="number"
                step="0.01"
                placeholder="0.00"
                required
              />
            </div>

            {canCost ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="purchase-price">Cost / Purchase price (₹)</Label>
                <Input
                  id="purchase-price"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 opacity-60">
                <Label>Cost / Purchase price (₹)</Label>
                <p className="text-xs text-muted-foreground mt-2">
                  Cost pricing is restricted by role permissions.
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-tax-rate">GST Rate (%)</Label>
              <Input
                id="product-tax-rate"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="e.g. 18, 12, 5, 0"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-hsn">HSN / SAC Code</Label>
              <Input
                id="product-hsn"
                value={hsnCode}
                onChange={(e) => setHsnCode(e.target.value)}
                placeholder="e.g. 9983, 8471"
                maxLength={20}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="opening-stock">Opening stock</Label>
              <Input
                id="opening-stock"
                value={openingStock}
                onChange={(e) => setOpeningStock(e.target.value)}
                type="number"
                step="1"
                min="0"
                placeholder="0"
              />
            </div>
          </div>

          <Button type="submit" disabled={isSubmitDisabled} className="mt-2 action-primary self-start">
            {pending
              ? "Saving product..."
              : isOffline
              ? offlineAllowed
                ? "Save product (Queue offline)"
                : "Offline creation disabled"
              : "Save product"}
          </Button>
        </form>
      </main>
    </AppShell>
  );
}
