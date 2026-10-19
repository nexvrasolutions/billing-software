"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

interface PurchaseLine {
    productId: string;
    quantity: string;
    unitPrice: string;
    taxRate: string;
}

function NewPurchaseForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const preselectedSupplier = searchParams.get("supplier") || "";

    const [suppliers, setSuppliers] = useState<any[]>([]);
    const [products, setProducts] = useState<any[]>([]);
    const [supplierId, setSupplierId] = useState(preselectedSupplier);
    const [billNumber, setBillNumber] = useState("");
    const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [warehouseName, setWarehouseName] = useState("Main Store");
    const [paidAmount, setPaidAmount] = useState("");
    const [lines, setLines] = useState<PurchaseLine[]>([
        { productId: "", quantity: "1", unitPrice: "", taxRate: "0" },
    ]);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function loadData() {
            try {
                const [supRes, prodRes] = await Promise.all([
                    fetch("/api/suppliers"),
                    fetch("/api/products"),
                ]);
                const supData = await supRes.json();
                const prodData = await prodRes.json();

                if (supData.success) {
                    setSuppliers(supData.suppliers || []);
                    if (!supplierId && supData.suppliers?.length > 0) {
                        setSupplierId(supData.suppliers[0]._id);
                    }
                }
                if (prodData.success) setProducts(prodData.products || []);
            } catch (err: any) {
                setError(err.message || "Failed to load suppliers or products");
            }
        }
        loadData();
    }, []);

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
        setLines(copy);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);

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
            if (item.quantity <= 0) {
                setError(`Line ${i + 1}: Quantity must be greater than zero.`);
                return;
            }
            if (item.unitPrice < 0) {
                setError(`Line ${i + 1}: Price cannot be negative.`);
                return;
            }
        }

        setLoading(true);
        const purchaseNo = `PO-${Date.now()}`;
        const paidNum = Number(paidAmount) || 0;

        try {
            const res = await fetch("/api/purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    purchaseNo,
                    supplierId,
                    supplierInvoiceNo: billNumber.trim(),
                    purchaseDate: new Date(billDate),
                    warehouse: { name: warehouseName },
                    items: validItems,
                    paidAmount: paidNum,
                }),
            });

            const data = await res.json();
            if (data.success) {
                router.push(`/purchases/${data.purchase._id || ""}`);
            } else {
                setError(data.message || "Failed to create purchase");
            }
        } catch (err: any) {
            setError(err.message || "Network error");
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="flex max-w-4xl flex-col gap-4">
                <Link href="/purchases" className="text-sm underline">
                    ← Purchases
                </Link>
                <h1 className="text-2xl font-semibold tracking-tight">New purchase</h1>

                {suppliers.length === 0 ? (
                    <section className="flex max-w-md flex-col items-start gap-3 rounded-lg border p-4 text-sm">
                        <p>A purchase needs a supplier. Add a supplier first on the Suppliers page, then come back here.</p>
                        <Link href="/suppliers" className="inline-flex h-9 items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground">
                            Go to Suppliers
                        </Link>
                    </section>
                ) : (
                    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                        {error && <p className="text-sm text-destructive">{error}</p>}

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
                                    {suppliers.map((s) => (
                                        <option key={s._id} value={s._id}>
                                            {s.name}
                                        </option>
                                    ))}
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
                            Enter the prices exactly as on the supplier&apos;s bill, before GST. After saving, check the totals against the bill; a wrong bill is voided and entered again.
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
                                            {products.map((p) => (
                                                <option key={p._id} value={p._id}>
                                                    {p.name} ({p.SKU})
                                                </option>
                                            ))}
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

                        <Button type="submit" disabled={loading} className="self-start">
                            {loading ? "Saving..." : "Save purchase"}
                        </Button>
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
