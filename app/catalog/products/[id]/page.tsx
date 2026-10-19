"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPaise, rupeesToPaise } from "@/lib/money";

interface ProductData {
    _id: string;
    name: string;
    SKU: string;
    barcode?: string;
    purchasePrice?: number;
    sellingPrice: number;
    taxRate?: number;
    hsnCode?: string;
    stockQuantity: number;
    status: "active" | "inactive";
    categoryId?: string;
    unitId?: string;
}

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);

    const [product, setProduct] = useState<ProductData | null>(null);
    const [categories, setCategories] = useState<{ _id: string; name: string }[]>([]);
    const [units, setUnits] = useState<{ _id: string; name: string; code: string }[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    // Form fields
    const [sellingPrice, setSellingPrice] = useState("");
    const [purchasePrice, setPurchasePrice] = useState("");
    const [barcode, setBarcode] = useState("");
    const [taxRate, setTaxRate] = useState("");
    const [hsnCode, setHsnCode] = useState("");

    const canViewCost = typeof product?.purchasePrice === "number";

    useEffect(() => {
        let cancelled = false;

        async function fetchProduct(productId: string) {
            let res = await fetch(`/api/products/${productId}?includeCost=true`);
            if (res.status === 403) {
                const errData = await res.clone().json().catch(() => null);
                if (errData?.message === "You do not have permission to view product purchase costs") {
                    res = await fetch(`/api/products/${productId}`);
                }
            }
            return res;
        }

        async function fetchDetails() {
            try {
                const [productRes, catRes, unitRes] = await Promise.all([
                    fetchProduct(id),
                    fetch("/api/categories", { credentials: "same-origin" }).catch(() => null),
                    fetch("/api/units", { credentials: "same-origin" }).catch(() => null),
                ]);

                if (cancelled) return;

                const data = await productRes.json();
                if (data.success && data.product) {
                    const hasCost = typeof data.product.purchasePrice === "number";
                    setProduct(data.product);
                    setSellingPrice(String(data.product.sellingPrice));
                    setPurchasePrice(hasCost ? String(data.product.purchasePrice) : "");
                    setBarcode(data.product.barcode || "");
                    setTaxRate(typeof data.product.taxRate === "number" ? String(data.product.taxRate) : "");
                    setHsnCode(data.product.hsnCode || "");
                } else {
                    setError(data.message || "Product not found.");
                }

                if (catRes && catRes.ok) {
                    const cData = await catRes.json().catch(() => null);
                    if (!cancelled && cData?.categories) {
                        setCategories(cData.categories);
                    }
                }

                if (unitRes && unitRes.ok) {
                    const uData = await unitRes.json().catch(() => null);
                    if (!cancelled && uData?.units) {
                        setUnits(uData.units);
                    }
                }
            } catch (err: any) {
                if (!cancelled) {
                    setError(err.message || "Failed to load product");
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        fetchDetails();

        return () => {
            cancelled = true;
        };
    }, [id]);

    async function handleSavePrices(e: React.FormEvent) {
        e.preventDefault();
        setSaving(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const hasCost = typeof product?.purchasePrice === "number";
            const payload: Record<string, unknown> = {
                sellingPrice: Number(sellingPrice),
                barcode: barcode.trim() ? barcode.trim().toUpperCase() : "",
            };

            if (hasCost && purchasePrice.trim() !== "") {
                payload.purchasePrice = Number(purchasePrice);
            }

            if (taxRate.trim() !== "") {
                const tRate = Number(taxRate);
                if (isNaN(tRate) || tRate < 0 || tRate > 100) {
                    setError("Please enter a valid GST rate between 0 and 100%.");
                    setSaving(false);
                    return;
                }
                payload.taxRate = tRate;
            } else {
                payload.taxRate = null;
            }

            payload.hsnCode = hsnCode.trim() || null;

            const res = await fetch(`/api/products/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (data.success) {
                setSuccessMessage("Product details saved.");
                setProduct((prev) => prev ? {
                    ...prev,
                    sellingPrice: Number(sellingPrice),
                    ...(hasCost && purchasePrice.trim() !== "" ? { purchasePrice: Number(purchasePrice) } : {}),
                    barcode: barcode.trim() ? barcode.trim().toUpperCase() : undefined,
                    taxRate: taxRate.trim() !== "" ? Number(taxRate) : undefined,
                    hsnCode: hsnCode.trim() || undefined,
                } : null);
            } else {
                setError(data.message || "Failed to save prices");
            }
        } catch (err: any) {
            setError(err.message || "Network error");
        } finally {
            setSaving(false);
        }
    }

    async function handleToggleStatus() {
        if (!product) return;
        const newStatus = product.status === "active" ? "inactive" : "active";
        setSaving(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const res = await fetch(`/api/products/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: newStatus }),
            });
            const data = await res.json();
            if (data.success) {
                setProduct((prev) => prev ? { ...prev, status: newStatus } : null);
                setSuccessMessage(newStatus === "inactive" ? "Product archived." : "Product restored.");
            } else {
                setError(data.message || "Failed to update status");
            }
        } catch (err: any) {
            setError(err.message || "Failed to update status");
        } finally {
            setSaving(false);
        }
    }

    async function handleRemoveBarcode() {
        if (!product) return;
        setSaving(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const res = await fetch(`/api/products/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ barcode: "" }),
            });
            const data = await res.json();
            if (data.success) {
                setBarcode("");
                setProduct((prev) => prev ? { ...prev, barcode: undefined } : null);
                setSuccessMessage("Barcode removed.");
            } else {
                setError(data.message || "Failed to remove barcode");
            }
        } catch (err: any) {
            setError(err.message || "Failed to remove barcode");
        } finally {
            setSaving(false);
        }
    }

    const categoryName = product?.categoryId ? categories.find((c) => c._id === product.categoryId)?.name : undefined;
    const unitName = product?.unitId ? units.find((u) => u._id === product.unitId)?.name : undefined;

    return (
        <AppShell>
            <main className="flex max-w-4xl flex-col gap-4">
                <Link href="/catalog/products" className="text-sm underline">
                    ← Products
                </Link>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading product...</p>
                ) : !product ? (
                    <p role="alert" className="text-sm text-destructive">{error || "Product not found."}</p>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h1 className="text-2xl font-semibold tracking-tight">
                                {product.name}
                                {product.status === "inactive" ? " (archived)" : ""}
                            </h1>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={saving}
                                onClick={handleToggleStatus}
                            >
                                {product.status === "active" ? "Archive" : "Restore"}
                            </Button>
                        </div>

                        <p className="text-sm text-muted-foreground">
                            SKU <span className="font-medium text-foreground">{product.SKU}</span>
                            {categoryName ? ` · category ${categoryName}` : ""}
                            {unitName ? ` · unit ${unitName}` : ""}
                            {` · in stock ${product.stockQuantity}`}
                            {product.barcode ? ` · barcode ${product.barcode}` : ""}
                        </p>

                        {error && (
                            <p role="alert" className="text-sm text-destructive">
                                {error}
                            </p>
                        )}
                        {successMessage && (
                            <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
                                {successMessage}
                            </p>
                        )}

                        <ul className="flex flex-col divide-y rounded-lg border bg-card" aria-label="Variants">
                            <li className="flex flex-col gap-2 p-3" aria-label={product.SKU}>
                                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                    <span>
                                        <span className="font-medium">{product.SKU}</span> · {formatPaise(rupeesToPaise(product.sellingPrice))}
                                        {product.purchasePrice !== undefined && product.purchasePrice !== null ? ` · cost ${formatPaise(rupeesToPaise(product.purchasePrice))}` : ""}
                                        {product.taxRate !== undefined && product.taxRate !== null ? ` · GST ${product.taxRate}%` : ""}
                                        {product.hsnCode ? ` · HSN ${product.hsnCode}` : ""}
                                        {product.status === "inactive" ? " · archived" : ""}
                                    </span>
                                </div>

                                {product.barcode ? (
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                        <div className="flex items-center gap-1 rounded border px-1">
                                            <span>{product.barcode}</span>
                                            <button
                                                type="button"
                                                aria-label={`Remove barcode ${product.barcode}`}
                                                disabled={saving}
                                                onClick={handleRemoveBarcode}
                                                className="px-1 text-muted-foreground hover:text-foreground"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground">No barcode assigned</p>
                                )}

                                <form onSubmit={handleSavePrices} className="flex flex-wrap items-end gap-2" aria-label={`Prices of ${product.SKU}`}>
                                    <label className="flex flex-col gap-1 text-xs">
                                        Price ₹
                                        <Input
                                            name="price"
                                            value={sellingPrice}
                                            onChange={(e) => setSellingPrice(e.target.value)}
                                            inputMode="decimal"
                                            required
                                            className="w-28"
                                        />
                                    </label>
                                    {canViewCost && (
                                        <label className="flex flex-col gap-1 text-xs">
                                            Cost ₹
                                            <Input
                                                name="cost"
                                                value={purchasePrice}
                                                onChange={(e) => setPurchasePrice(e.target.value)}
                                                inputMode="decimal"
                                                required
                                                className="w-28"
                                            />
                                        </label>
                                    )}
                                    <label className="flex flex-col gap-1 text-xs">
                                        GST %
                                        <Input
                                            name="taxRate"
                                            value={taxRate}
                                            onChange={(e) => setTaxRate(e.target.value)}
                                            placeholder="e.g. 18"
                                            inputMode="decimal"
                                            className="w-24"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-xs">
                                        HSN/SAC
                                        <Input
                                            name="hsnCode"
                                            value={hsnCode}
                                            onChange={(e) => setHsnCode(e.target.value)}
                                            placeholder="e.g. 9983"
                                            maxLength={20}
                                            className="w-28"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-xs">
                                        Barcode
                                        <Input
                                            name="barcode"
                                            value={barcode}
                                            onChange={(e) => setBarcode(e.target.value)}
                                            placeholder="Barcode"
                                            maxLength={64}
                                            className="w-40"
                                        />
                                    </label>
                                    <Button type="submit" variant="outline" size="sm" disabled={saving}>
                                        {saving ? "Saving..." : "Save details"}
                                    </Button>
                                </form>
                            </li>
                        </ul>
                    </>
                )}
            </main>
        </AppShell>
    );
}
