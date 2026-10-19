"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    saveCachedCategories,
    saveCachedUnits,
    getCachedCategoriesForTenant,
    getCachedUnitsForTenant,
} from "@/lib/offline/categoryUnitCache";
import { readRememberedIdentity, restoreOfflineSession } from "@/lib/offline/offlineAccess";

interface Category {
    _id: string;
    name: string;
    description?: string;
    status: "active" | "inactive";
}

interface Unit {
    _id: string;
    name: string;
    code: string;
    status: "active" | "inactive";
}

export default function CatalogListsPage() {
    const [categories, setCategories] = useState<Category[]>([]);
    const [units, setUnits] = useState<Unit[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isOffline, setIsOffline] = useState(false);

    // New item inputs
    const [catName, setCatName] = useState("");
    const [unitName, setUnitName] = useState("");
    const [unitCode, setUnitCode] = useState("");
    const [addingCat, setAddingCat] = useState(false);
    const [addingUnit, setAddingUnit] = useState(false);

    async function loadLists() {
        setLoading(true);
        setError(null);

        // 1. Try online fetch
        try {
            const [catRes, unitRes] = await Promise.all([
                fetch("/api/categories", { credentials: "same-origin" }),
                fetch("/api/units", { credentials: "same-origin" }),
            ]);

            if (catRes.ok && unitRes.ok) {
                const catData = await catRes.json();
                const unitData = await unitRes.json();

                const fetchedCats: Category[] = catData.categories || [];
                const fetchedUnits: Unit[] = (unitData.units || []).map((u: any) => ({
                    _id: String(u._id || u.id),
                    name: u.name,
                    code: u.shortName || u.code || "pcs",
                    status: u.status === "inactive" ? "inactive" : "active",
                }));

                setCategories(fetchedCats);
                setUnits(fetchedUnits);
                setIsOffline(false);

                // Populate cache for the tenant
                const rawTenantId =
                    catData.categories?.[0]?.tenantId ||
                    unitData.units?.[0]?.tenantId;
                let tenantId = rawTenantId ? String(rawTenantId) : null;
                if (!tenantId) {
                    const remembered = await readRememberedIdentity().catch(() => null);
                    tenantId = remembered?.tenantId ?? null;
                }

                if (tenantId) {
                    await saveCachedCategories(tenantId, catData.categories || []).catch(() => undefined);
                    await saveCachedUnits(tenantId, unitData.units || []).catch(() => undefined);
                }

                setLoading(false);
                return;
            }
        } catch {
            // Network failure: proceed to offline fallback
        }

        // 2. Offline fallback: load cached categories and units
        try {
            const restored = await restoreOfflineSession().catch(() => null);
            if (restored?.ok && restored.identity?.tenantId) {
                const tenantId = restored.identity.tenantId;
                const [cachedCats, cachedUnits] = await Promise.all([
                    getCachedCategoriesForTenant(tenantId, { includeInactive: true }),
                    getCachedUnitsForTenant(tenantId, { includeInactive: true }),
                ]);

                if (cachedCats.length > 0 || cachedUnits.length > 0) {
                    setCategories(
                        cachedCats.map((c) => ({
                            _id: c._id,
                            name: c.name,
                            description: c.description,
                            status: c.status,
                        }))
                    );
                    setUnits(
                        cachedUnits.map((u) => ({
                            _id: u._id,
                            name: u.name,
                            code: u.shortName,
                            status: u.status,
                        }))
                    );
                    setIsOffline(true);
                    setLoading(false);
                    return;
                }
            }

            // No cached data available
            setIsOffline(true);
            setError("No cached categories or units available. Please connect to the internet once to load reference data.");
        } catch {
            setIsOffline(true);
            setError("Unable to load catalog lists while offline.");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadLists();
    }, []);

    async function handleAddCategory(e: React.FormEvent) {
        e.preventDefault();
        if (isOffline) {
            setError("Category creation is only available when online.");
            return;
        }
        if (!catName.trim()) return;
        setAddingCat(true);
        setError(null);
        try {
            const res = await fetch("/api/categories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: catName.trim() }),
            });
            const data = await res.json();
            if (data.success) {
                setCatName("");
                loadLists();
            } else {
                setError(data.message || "Failed to add category");
            }
        } catch (err: any) {
            setError(err.message || "Network error");
        } finally {
            setAddingCat(false);
        }
    }

    async function handleAddUnit(e: React.FormEvent) {
        e.preventDefault();
        if (isOffline) {
            setError("Unit creation is only available when online.");
            return;
        }
        if (!unitName.trim() || !unitCode.trim()) return;
        setAddingUnit(true);
        setError(null);
        try {
            const res = await fetch("/api/units", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: unitName.trim(), code: unitCode.trim() }),
            });
            const data = await res.json();
            if (data.success) {
                setUnitName("");
                setUnitCode("");
                loadLists();
            } else {
                setError(data.message || "Failed to add unit");
            }
        } catch (err: any) {
            setError(err.message || "Network error");
        } finally {
            setAddingUnit(false);
        }
    }

    return (
        <AppShell>
            <main className="flex max-w-3xl flex-col gap-8">
                <h1 className="text-2xl font-semibold tracking-tight">Catalog lists</h1>

                {isOffline && (
                    <div
                        role="status"
                        className="flex flex-col gap-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-foreground"
                    >
                        <p className="font-semibold text-amber-800 dark:text-amber-200">
                            Working offline — showing cached data
                        </p>
                        <p className="text-muted-foreground">
                            Categories and units are loaded from local cache. Adding or modifying categories and units is only available when online.
                        </p>
                    </div>
                )}

                {error && <p className="text-sm text-destructive">{error}</p>}

                {/* Categories Section */}
                <section className="flex flex-col gap-3">
                    <h2 className="text-lg font-semibold">Categories</h2>
                    <form onSubmit={handleAddCategory} className="flex flex-wrap items-end gap-2" aria-label="Add category">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="new-cat-name">Name</Label>
                            <Input
                                id="new-cat-name"
                                value={catName}
                                onChange={(e) => setCatName(e.target.value)}
                                maxLength={100}
                                placeholder="Category name"
                                required
                                disabled={addingCat || isOffline}
                                className="w-48"
                            />
                        </div>
                        <Button type="submit" disabled={addingCat || isOffline}>
                            {addingCat ? "Adding..." : isOffline ? "Offline" : "Add"}
                        </Button>
                    </form>
                    <ul className="flex flex-col divide-y rounded-lg border" aria-label="Categories">
                        {categories.length === 0 ? (
                            <li className="p-3 text-sm text-muted-foreground">No categories yet.</li>
                        ) : (
                            categories.map((c) => (
                                <li key={c._id} className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm" aria-label={c.name}>
                                    <span className="font-medium">{c.name}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {c.status === "inactive" ? "(archived)" : "active"}
                                    </span>
                                </li>
                            ))
                        )}
                    </ul>
                </section>

                {/* Units Section */}
                <section className="flex flex-col gap-3">
                    <h2 className="text-lg font-semibold">Units</h2>
                    <form onSubmit={handleAddUnit} className="flex flex-wrap items-end gap-2" aria-label="Add unit">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="new-unit-name">Name</Label>
                            <Input
                                id="new-unit-name"
                                value={unitName}
                                onChange={(e) => setUnitName(e.target.value)}
                                maxLength={100}
                                placeholder="e.g. Piece"
                                required
                                disabled={addingUnit || isOffline}
                                className="w-36"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="new-unit-code">Code</Label>
                            <Input
                                id="new-unit-code"
                                value={unitCode}
                                onChange={(e) => setUnitCode(e.target.value)}
                                maxLength={10}
                                placeholder="e.g. PCS"
                                required
                                disabled={addingUnit || isOffline}
                                className="w-24"
                            />
                        </div>
                        <Button type="submit" disabled={addingUnit || isOffline}>
                            {addingUnit ? "Adding..." : isOffline ? "Offline" : "Add"}
                        </Button>
                    </form>
                    <ul className="flex flex-col divide-y rounded-lg border" aria-label="Units">
                        {units.length === 0 ? (
                            <li className="p-3 text-sm text-muted-foreground">No units yet.</li>
                        ) : (
                            units.map((u) => (
                                <li key={u._id} className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm" aria-label={u.name}>
                                    <span>
                                        <span className="font-medium">{u.name}</span>{" "}
                                        <span className="text-muted-foreground">({u.code})</span>
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {u.status === "inactive" ? "(archived)" : "active"}
                                    </span>
                                </li>
                            ))
                        )}
                    </ul>
                </section>
            </main>
        </AppShell>
    );
}
