"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { restoreOfflineSession, readRememberedIdentity } from "@/lib/offline/offlineAccess";
import { getCachedSuppliersForTenant, saveCachedSuppliers, isTemporarySupplierCode } from "@/lib/offline/supplierCache";
import { getCachedProductsForTenant } from "@/lib/offline/productCatalogueCache";
import { savePendingOfflinePurchase, generateTemporaryPurchaseId, saveCachedPurchases } from "@/lib/offline/purchaseCache";
import {
    calculatePurchaseTotals,
    isTemporarySupplierId,
    isTemporaryProductId,
} from "@/lib/validations/purchase";
import { syncPendingOperations } from "@/lib/offline/SyncManager";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

interface PurchaseLine {
    productId: string;
    quantity: string;
    unitPrice: string;
    taxRate: string;
}

interface SupplierOption {
    _id: string;
    supplierCode?: string;
    name: string;
    phone?: string;
    gstin?: string;
}

interface ProductOption {
    _id: string;
    name: string;
    SKU: string;
    unit?: string;
    purchasePrice?: number;
    taxRate?: number;
}

function NewPurchaseForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const preselectedSupplier = searchParams.get("supplier") || "";

    const operationIdRef = useRef<string | null>(null);
    const localPurchaseIdRef = useRef<string | null>(null);
    const purchaseNoRef = useRef<string | null>(null);

    const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
    const [products, setProducts] = useState<ProductOption[]>([]);
    const [supplierId, setSupplierId] = useState(preselectedSupplier);
    const [billNumber, setBillNumber] = useState("");
    const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [warehouseName, setWarehouseName] = useState("Main Store");
    const [paidAmount, setPaidAmount] = useState("");
    const [lines, setLines] = useState<PurchaseLine[]>([
        { productId: "", quantity: "1", unitPrice: "", taxRate: "0" },
    ]);

    const [loading, setLoading] = useState(false);
    const [dataLoading, setDataLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [infoMessage, setInfoMessage] = useState<string | null>(null);
    const [isOffline, setIsOffline] = useState(false);
    const [tenantId, setTenantId] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        setDataLoading(true);
        const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

        // 1. If online, try fetching from API
        if (!isNavOffline) {
            try {
                const timeoutController = new AbortController();
                const timeoutId = setTimeout(() => timeoutController.abort(), SESSION_CHECK_TIMEOUT_MS);

                const [supRes, prodRes] = await Promise.all([
                    fetch("/api/suppliers", { signal: timeoutController.signal, credentials: "same-origin" }),
                    fetch("/api/products", { signal: timeoutController.signal, credentials: "same-origin" }),
                ]);
                clearTimeout(timeoutId);

                const supData = await supRes.json().catch(() => null);
                const prodData = await prodRes.json().catch(() => null);

                let resolvedTenant: string | null = null;
                if (supData?.success && Array.isArray(supData.suppliers)) {
                    if (supData.suppliers.length > 0 && supData.suppliers[0]?.tenantId) {
                        resolvedTenant = String(supData.suppliers[0].tenantId);
                    }
                    const mappedSuppliers: SupplierOption[] = supData.suppliers.map((s: {
                        _id?: string;
                        id?: string;
                        supplierCode?: string;
                        name: string;
                        contact?: { phone?: string };
                        phone?: string;
                        tax?: { gstin?: string };
                        gstin?: string;
                    }) => ({
                        _id: String(s._id || s.id || ""),
                        supplierCode: s.supplierCode,
                        name: s.name,
                        phone: s.contact?.phone || s.phone,
                        gstin: s.tax?.gstin || s.gstin,
                    }));
                    setSuppliers(mappedSuppliers);
                    if (!supplierId && mappedSuppliers.length > 0) {
                        setSupplierId(mappedSuppliers[0]._id);
                    }
                }

                if (prodData?.success && Array.isArray(prodData.products)) {
                    if (!resolvedTenant && prodData.products.length > 0 && prodData.products[0]?.tenantId) {
                        resolvedTenant = String(prodData.products[0].tenantId);
                    }
                    const mappedProducts: ProductOption[] = prodData.products.map((p: {
                        _id?: string;
                        id?: string;
                        name: string;
                        SKU?: string;
                        unit?: string;
                        purchasePrice?: number;
                        taxRate?: number;
                    }) => ({
                        _id: String(p._id || p.id || ""),
                        name: p.name,
                        SKU: p.SKU || "",
                        unit: p.unit,
                        purchasePrice: p.purchasePrice,
                        taxRate: p.taxRate,
                    }));
                    setProducts(mappedProducts);
                }

                if (resolvedTenant) {
                    setTenantId(resolvedTenant);
                    if (supData?.success && Array.isArray(supData.suppliers)) {
                        await saveCachedSuppliers(supData.suppliers, resolvedTenant).catch(() => undefined);
                    }
                }

                setIsOffline(false);
                setDataLoading(false);
                return;
            } catch {
                // Network error or timeout; fallback to offline cache
            }
        }

        // 2. Offline fallback: restore session and query local IndexedDB
        try {
            const restored = await restoreOfflineSession().catch(() => null);
            if (!restored || !restored.ok || !restored.identity?.tenantId) {
                setError(restored?.reason || "Offline access is not available. Please sign in online first.");
                setDataLoading(false);
                return;
            }

            const activeTenant = restored.identity.tenantId;
            setTenantId(activeTenant);
            setIsOffline(true);

            const [cachedSuppliers, cachedProducts] = await Promise.all([
                getCachedSuppliersForTenant(activeTenant, { includeInactive: false, includeBlocked: false }),
                getCachedProductsForTenant(activeTenant),
            ]);

            const mappedSuppliers: SupplierOption[] = cachedSuppliers.map((s) => ({
                _id: s.supplierId,
                supplierCode: s.supplierCode,
                name: s.name,
                phone: s.phone,
                gstin: s.gstin,
            }));
            setSuppliers(mappedSuppliers);
            if (!supplierId && mappedSuppliers.length > 0) {
                setSupplierId(mappedSuppliers[0]._id);
            }

            const mappedProducts: ProductOption[] = cachedProducts.map((p) => ({
                _id: p.productId,
                name: p.name,
                SKU: p.SKU || "",
                taxRate: p.taxRate,
            }));
            setProducts(mappedProducts);

            setDataLoading(false);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to load cached form data";
            setError(msg);
            setDataLoading(false);
        }
    }, [supplierId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadData();
    }, [loadData]);

    function handleAddLine() {
        setLines([...lines, { productId: "", quantity: "1", unitPrice: "", taxRate: "0" }]);
    }

    function handleRemoveLine(index: number) {
        if (lines.length <= 1) return;
        setLines(lines.filter((_, i) => i !== index));
    }

    function updateLine(index: number, field: keyof PurchaseLine, value: string) {
        const copy = [...lines];
        copy[index] = { ...copy[index], [field]: value };

        // Auto-fill price or tax if product is changed
        if (field === "productId") {
            const selProd = products.find((p) => p._id === value);
            if (selProd) {
                if (selProd.purchasePrice !== undefined && selProd.purchasePrice > 0) {
                    copy[index].unitPrice = String(selProd.purchasePrice);
                }
                if (selProd.taxRate !== undefined && selProd.taxRate >= 0) {
                    copy[index].taxRate = String(selProd.taxRate);
                }
            }
        }

        setLines(copy);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (loading) return;
        setError(null);
        setInfoMessage(null);

        if (!supplierId) {
            setError("Please select a supplier.");
            return;
        }
        if (!billNumber.trim()) {
            setError("Supplier bill number is required.");
            return;
        }

        const validItems = lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            taxRate: Number(l.taxRate) || 0,
        }));

        for (let i = 0; i < validItems.length; i++) {
            const item = validItems[i];
            if (!item.productId) {
                setError(`Line ${i + 1}: Please select a product.`);
                return;
            }
            if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
                setError(`Line ${i + 1}: Quantity must be greater than zero.`);
                return;
            }
            if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
                setError(`Line ${i + 1}: Price cannot be negative.`);
                return;
            }
        }

        setLoading(true);

        // Retain stable operation ID, local ID, and purchase number across repeated submissions/retries
        if (!operationIdRef.current) {
            operationIdRef.current =
                typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `op-pur-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        }
        if (!localPurchaseIdRef.current) {
            localPurchaseIdRef.current = generateTemporaryPurchaseId();
        }
        if (!purchaseNoRef.current) {
            purchaseNoRef.current = `PO-${Date.now().toString().slice(-6)}`;
        }

        const stableOpId = operationIdRef.current;
        const localPurchaseId = localPurchaseIdRef.current;
        const purchaseNo = purchaseNoRef.current;
        const paidNum = Number(paidAmount) || 0;

        const selectedSupplier = suppliers.find((s) => s._id === supplierId);
        const supplierSnapshot = selectedSupplier
            ? {
                  name: selectedSupplier.name,
                  supplierCode: selectedSupplier.supplierCode,
                  phone: selectedSupplier.phone,
                  gstin: selectedSupplier.gstin,
              }
            : undefined;

        const itemsWithSnapshots = validItems.map((item) => {
            const prod = products.find((p) => p._id === item.productId);
            return {
                ...item,
                productSnapshot: prod
                    ? {
                          name: prod.name,
                          SKU: prod.SKU,
                          unit: prod.unit,
                      }
                    : undefined,
            };
        });

        const totals = calculatePurchaseTotals(validItems);
        const purchasePayload = {
            operationId: stableOpId,
            purchaseNo,
            supplierId,
            supplierInvoiceNo: billNumber.trim(),
            purchaseDate: new Date(billDate),
            warehouse: { name: warehouseName },
            items: itemsWithSnapshots,
            paidAmount: paidNum,
            subtotal: totals.subtotal,
            discountTotal: totals.discountTotal,
            taxTotal: totals.taxTotal,
            grandTotal: totals.grandTotal,
            supplierSnapshot,
        };

        // Detect unresolved temporary supplier or product IDs
        const hasTemporarySupplier =
            isTemporarySupplierId(supplierId) ||
            (selectedSupplier?.supplierCode ? isTemporarySupplierCode(selectedSupplier.supplierCode) : false);
        const hasTemporaryProducts = validItems.some((item) => isTemporaryProductId(item.productId));
        const hasUnresolvedPrerequisites = hasTemporarySupplier || hasTemporaryProducts;

        const isNavOnline = typeof navigator !== "undefined" && navigator.onLine;

        // Try direct online submission ONLY if navigator reports online AND there are NO unresolved prerequisites
        if (isNavOnline && !hasUnresolvedPrerequisites) {
            try {
                const res = await fetch("/api/purchases", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(purchasePayload),
                });

                const data = await res.json().catch(() => null);

                if (res.ok && data?.success) {
                    if (tenantId && data.purchase) {
                        await saveCachedPurchases([data.purchase], tenantId).catch(() => undefined);
                    }
                    // Reset refs only after definitive server success, immediately before redirecting
                    operationIdRef.current = null;
                    localPurchaseIdRef.current = null;
                    purchaseNoRef.current = null;
                    router.push(`/purchases/${data.purchase._id || ""}`);
                    return;
                }

                // If write-pause is active (HTTP 503 MAINTENANCE_PAUSED), fall through to offline dual-write
                if (res.status === 503 || data?.code === "MAINTENANCE_PAUSED") {
                    // Fall through to offline queueing below
                } else if (res.status === 400 || res.status === 422) {
                    // Normal server validation failure: display error and do NOT queue
                    setError(data?.message || "Validation error from server");
                    setLoading(false);
                    return;
                } else {
                    // Other server errors; attempt offline fallback if tenant session is available
                }
            } catch {
                // Network failure during POST; fall through to offline save
            }
        }

        // Offline save (or prerequisite queueing, or write-pause fallback)
        try {
            if (hasUnresolvedPrerequisites) {
                setInfoMessage("Purchase queued locally. Waiting for pending supplier or product synchronization before uploading.");
            }

            let activeTenant = tenantId;
            if (!activeTenant) {
                const restored = await restoreOfflineSession().catch(() => null);
                activeTenant = restored?.identity?.tenantId || null;
            }

            if (!activeTenant) {
                const remembered = await readRememberedIdentity().catch(() => null);
                activeTenant = remembered?.tenantId || null;
            }

            if (!activeTenant) {
                setError("Unable to identify current business session for offline storage.");
                setLoading(false);
                return;
            }

            await savePendingOfflinePurchase(purchasePayload, activeTenant, {
                operationId: stableOpId,
                localId: localPurchaseId,
            });

            // Trigger sync if online
            if (typeof navigator !== "undefined" && navigator.onLine) {
                syncPendingOperations().catch(() => undefined);
            }

            // Reset refs only after definitive offline save/queue success, immediately before redirecting
            operationIdRef.current = null;
            localPurchaseIdRef.current = null;
            purchaseNoRef.current = null;

            router.push(`/purchases/${localPurchaseId}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to save purchase offline";
            setError(msg);
            setLoading(false);
        }
    }

    return (
        <main className="flex max-w-4xl flex-col gap-4">
            <Link href="/purchases" className="text-sm underline">
                ← Purchases
            </Link>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">New purchase</h1>
                {isOffline && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                        Working offline
                    </span>
                )}
            </div>

            {dataLoading ? (
                <p className="text-sm text-muted-foreground">Loading suppliers and catalog...</p>
            ) : suppliers.length === 0 ? (
                <section className="flex max-w-md flex-col items-start gap-3 rounded-lg border p-4 text-sm">
                    <p>A purchase needs a supplier. Add a supplier first on the Suppliers page, then come back here.</p>
                    <Link
                        href="/suppliers"
                        className="inline-flex h-9 items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground"
                    >
                        Go to Suppliers
                    </Link>
                </section>
            ) : (
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    {error && (
                        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                            {error}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-3">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="supplierId">Supplier</Label>
                            <select
                                id="supplierId"
                                value={supplierId}
                                onChange={(e) => setSupplierId(e.target.value)}
                                required
                                className={selectClass}
                            >
                                {suppliers.map((s) => {
                                    const isTemp = isTemporarySupplierCode(s.supplierCode) || isTemporarySupplierId(s._id);
                                    return (
                                        <option key={s._id} value={s._id}>
                                            {s.name} {isTemp ? "(Pending sync)" : s.supplierCode ? `(${s.supplierCode})` : ""}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="warehouse">Warehouse</Label>
                            <Input
                                id="warehouse"
                                value={warehouseName}
                                onChange={(e) => setWarehouseName(e.target.value)}
                                required
                                className="w-36"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="billNumber">Supplier bill number</Label>
                            <Input
                                id="billNumber"
                                value={billNumber}
                                onChange={(e) => setBillNumber(e.target.value)}
                                required
                                placeholder="e.g. INV-9021"
                                maxLength={40}
                                className="w-44"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label htmlFor="billDate">Bill date</Label>
                            <Input
                                id="billDate"
                                type="date"
                                value={billDate}
                                onChange={(e) => setBillDate(e.target.value)}
                                required
                                className="w-40"
                            />
                        </div>
                    </div>

                    <p className="text-sm text-muted-foreground">
                        Enter the prices exactly as on the supplier&apos;s bill, before GST. After saving, check the totals
                        against the bill; a wrong bill is voided and entered again.
                    </p>

                    {lines.map((line, index) => (
                        <fieldset
                            key={index}
                            className="flex flex-col gap-2 rounded-lg border p-3"
                            aria-label={`Line ${index + 1}`}
                        >
                            <legend className="px-1 text-sm font-medium">Line {index + 1}</legend>
                            <div className="flex flex-wrap gap-3">
                                <div className="flex flex-col gap-1">
                                    <Label htmlFor={`prod-${index}`}>Product</Label>
                                    <select
                                        id={`prod-${index}`}
                                        value={line.productId}
                                        onChange={(e) => updateLine(index, "productId", e.target.value)}
                                        required
                                        className={selectClass}
                                    >
                                        <option value="">Select product</option>
                                        {products.map((p) => {
                                            const isTemp = isTemporaryProductId(p._id);
                                            return (
                                                <option key={p._id} value={p._id}>
                                                    {p.name} {isTemp ? "(Pending sync)" : p.SKU ? `(${p.SKU})` : ""}
                                                </option>
                                            );
                                        })}
                                    </select>
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor={`qty-${index}`}>Quantity</Label>
                                    <Input
                                        id={`qty-${index}`}
                                        value={line.quantity}
                                        onChange={(e) => updateLine(index, "quantity", e.target.value)}
                                        required
                                        inputMode="decimal"
                                        className="w-24"
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor={`price-${index}`}>Price before GST (₹)</Label>
                                    <Input
                                        id={`price-${index}`}
                                        value={line.unitPrice}
                                        onChange={(e) => updateLine(index, "unitPrice", e.target.value)}
                                        required
                                        inputMode="decimal"
                                        placeholder="0.00"
                                        className="w-36"
                                    />
                                </div>

                                <div className="flex flex-col gap-1">
                                    <Label htmlFor={`rate-${index}`}>GST %</Label>
                                    <Input
                                        id={`rate-${index}`}
                                        value={line.taxRate}
                                        onChange={(e) => updateLine(index, "taxRate", e.target.value)}
                                        inputMode="decimal"
                                        placeholder="0"
                                        className="w-20"
                                    />
                                </div>
                            </div>

                            {lines.length > 1 && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="self-start mt-2"
                                    onClick={() => handleRemoveLine(index)}
                                >
                                    Remove line
                                </Button>
                            )}
                        </fieldset>
                    ))}

                    <Button type="button" variant="outline" className="self-start" onClick={handleAddLine}>
                        Add a line
                    </Button>

                    <fieldset className="flex flex-col gap-2 rounded-lg border p-3" aria-label="Paid now">
                        <legend className="px-1 text-sm font-medium">Paid now (optional)</legend>
                        <div className="flex flex-wrap gap-3">
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="payAmount">Amount (₹)</Label>
                                <Input
                                    id="payAmount"
                                    value={paidAmount}
                                    onChange={(e) => setPaidAmount(e.target.value)}
                                    inputMode="decimal"
                                    placeholder="0.00"
                                    className="w-36"
                                />
                            </div>
                        </div>
                    </fieldset>

                    {(() => {
                        const selectedSupplier = suppliers.find((s) => s._id === supplierId);
                        const isSupplierPending =
                            isTemporarySupplierId(supplierId) ||
                            (selectedSupplier?.supplierCode ? isTemporarySupplierCode(selectedSupplier.supplierCode) : false);
                        const hasPendingProductLines = lines.some((l) => isTemporaryProductId(l.productId));
                        const hasPendingPrerequisites = isSupplierPending || hasPendingProductLines;

                        return (
                            <>
                                {hasPendingPrerequisites && (
                                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                                        <strong>Prerequisites pending sync:</strong> One or more selected suppliers or products are pending synchronization. This purchase will be safely queued locally and uploaded once prerequisites sync.
                                    </div>
                                )}

                                {infoMessage && (
                                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
                                        {infoMessage}
                                    </div>
                                )}

                                <Button type="submit" disabled={loading} className="self-start">
                                    {loading
                                        ? hasPendingPrerequisites
                                            ? "Queueing purchase..."
                                            : "Saving..."
                                        : hasPendingPrerequisites
                                        ? "Queue purchase (pending sync)"
                                        : "Save purchase"}
                                </Button>
                            </>
                        );
                    })()}
                </form>
            )}
        </main>
    );
}

export default function NewPurchasePage() {
    return (
        <AppShell>
            <Suspense
                fallback={
                    <main className="flex max-w-4xl flex-col gap-4">
                        <Link href="/purchases" className="text-sm underline">
                            ← Purchases
                        </Link>
                        <h1 className="text-2xl font-semibold tracking-tight">New purchase</h1>
                        <p className="text-sm text-muted-foreground">Loading purchase form...</p>
                    </main>
                }
            >
                <NewPurchaseForm />
            </Suspense>
        </AppShell>
    );
}
