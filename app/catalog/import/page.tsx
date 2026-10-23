"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  parseProductCsv,
  getCsvRowOperationId,
  type ParsedProductRow as ParsedRow,
} from "@/lib/csv";
import { newOperationId } from "@/lib/offline/syncPolicy";

interface Category {
  _id: string;
  name: string;
}

interface Unit {
  _id: string;
  name: string;
  code: string;
}

export default function CatalogImportPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [selectedCatId, setSelectedCatId] = useState("");
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [csvText, setCsvText] = useState(
    "name,SKU,purchasePrice,sellingPrice,barcode,openingStock\nBasmati Rice 1kg,RICE-001,80,110,8901234567890,50\nSunflower Oil 1L,OIL-001,120,150,8901234567891,25"
  );
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const batchIdRef = useRef<string | null>(null);

  useEffect(() => {
    async function loadMetadata() {
      try {
        const [catRes, unitRes] = await Promise.all([
          fetch("/api/categories", { credentials: "same-origin" }),
          fetch("/api/units", { credentials: "same-origin" }),
        ]);

        const catData = await catRes.json().catch(() => null);
        const unitData = await unitRes.json().catch(() => null);

        if (catData?.success && Array.isArray(catData.categories)) {
          setCategories(catData.categories);
          if (catData.categories.length > 0) setSelectedCatId(catData.categories[0]._id);
        }
        if (unitData?.success && Array.isArray(unitData.units)) {
          setUnits(unitData.units);
          if (unitData.units.length > 0) setSelectedUnitId(unitData.units[0]._id);
        }
      } finally {
        setLoadingLists(false);
      }
    }
    loadMetadata();
  }, []);

  const handleParseCsv = () => {
    setImportError(null);
    setImportStatus(null);
    batchIdRef.current = newOperationId();

    const result = parseProductCsv(csvText);
    if (!result.success || result.errors.length > 0) {
      setImportError(result.errors.join("\n"));
      setParsedRows([]);
      return;
    }

    setParsedRows(result.rows);
    setImportStatus(`Parsed ${result.rows.length} product(s). Ready to import.`);
  };

  const handleExecuteImport = () => {
    if (!selectedCatId || !selectedUnitId) {
      setImportError("Please select a default Category and Unit for imported products.");
      return;
    }
    if (parsedRows.length === 0) {
      setImportError("Please parse your CSV lines first.");
      return;
    }

    if (!batchIdRef.current) {
      batchIdRef.current = newOperationId();
    }
    const batchId = batchIdRef.current;

    // Defense-in-depth: Verify no duplicate normalized SKUs exist in preview rows
    const seenSkus = new Map<string, number>();
    const duplicateErrors: string[] = [];
    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      const rowNum = row.rowNumber ?? i + 2;
      const norm = row.SKU.trim().toUpperCase();
      const prev = seenSkus.get(norm);
      if (prev !== undefined) {
        duplicateErrors.push(
          `Row ${rowNum}: Duplicate SKU "${norm}" already appears on row ${prev}. Duplicate SKUs within one CSV file are not permitted.`
        );
      } else {
        seenSkus.set(norm, rowNum);
      }
    }

    if (duplicateErrors.length > 0) {
      setImportError(duplicateErrors.join("\n"));
      return;
    }

    setImportError(null);
    setImportStatus(null);

    startTransition(async () => {
      let importedCount = 0;
      let failedCount = 0;
      const failureDetails: string[] = [];
      const succeededSkus = new Set<string>();

      for (let i = 0; i < parsedRows.length; i++) {
        const row = parsedRows[i];
        const rowNumber = row.rowNumber ?? i + 2;
        const normalizedSku = row.SKU.trim().toUpperCase();
        const operationId = getCsvRowOperationId(batchId, normalizedSku);

        try {
          const res = await fetch("/api/products", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              name: row.name,
              SKU: row.SKU,
              barcode: row.barcode && row.barcode.trim() ? row.barcode.trim().toUpperCase() : undefined,
              categoryId: selectedCatId,
              unitId: selectedUnitId,
              purchasePrice: row.purchasePrice,
              sellingPrice: row.sellingPrice,
              openingStock: row.openingStock ?? 0,
              operationId,
              status: "active",
            }),
          });

          const data = await res.json().catch(() => null);

          if (res.ok && data?.success) {
            importedCount++;
            succeededSkus.add(normalizedSku);
          } else {
            failedCount++;
            const reason =
              data?.message ||
              (Array.isArray(data?.errors)
                ? data.errors.map((e: any) => e.message || String(e)).join(", ")
                : null) ||
              `HTTP error ${res.status}`;
            failureDetails.push(`Row ${rowNumber} (${row.SKU}): ${reason}`);
          }
        } catch (err: any) {
          failedCount++;
          failureDetails.push(
            `Row ${rowNumber} (${row.SKU}): Network error (${err?.message || "connection failed"})`
          );
        }
      }

      setImportStatus(
        `Import finished: ${importedCount} product(s) added successfully${
          failedCount > 0 ? `, ${failedCount} failed.` : "."
        }`
      );

      if (failureDetails.length > 0) {
        setImportError(`Failed items:\n${failureDetails.join("\n")}`);
      } else {
        setImportError(null);
      }

      const remainingRows = parsedRows.filter(
        (r) => !succeededSkus.has(r.SKU.trim().toUpperCase())
      );
      setParsedRows(remainingRows);

      if (remainingRows.length === 0) {
        batchIdRef.current = null;
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Import products</h1>
            <p className="text-xs text-muted-foreground">
              Bulk upload inventory items from CSV or spreadsheet format.
            </p>
          </div>
          <Link href="/catalog/products" className="text-sm underline">
            View all products →
          </Link>
        </div>

        {importError && <p role="alert" className="text-xs font-medium text-destructive whitespace-pre-line">{importError}</p>}
        {importStatus && <p role="status" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{importStatus}</p>}

        <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm">
          <h2 className="font-semibold">Import configuration</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-cat">Assign default category *</Label>
              {loadingLists ? (
                <p className="text-xs text-muted-foreground">Loading categories...</p>
              ) : categories.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No categories found.{" "}
                  <Link href="/catalog/lists" className="underline">
                    Create categories first
                  </Link>
                </p>
              ) : (
                <select
                  id="import-cat"
                  value={selectedCatId}
                  onChange={(e) => setSelectedCatId(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                >
                  {categories.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-unit">Assign default unit *</Label>
              {loadingLists ? (
                <p className="text-xs text-muted-foreground">Loading units...</p>
              ) : units.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No units found.{" "}
                  <Link href="/catalog/lists" className="underline">
                    Create units first
                  </Link>
                </p>
              ) : (
                <select
                  id="import-unit"
                  value={selectedUnitId}
                  onChange={(e) => setSelectedUnitId(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                >
                  {units.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name} ({u.code})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-csv">Paste CSV text</Label>
            <textarea
              id="import-csv"
              rows={6}
              value={csvText}
              onChange={(e) => {
                setCsvText(e.target.value);
                batchIdRef.current = null;
                setParsedRows([]);
                setImportStatus(null);
              }}
              className="w-full rounded-lg border border-input bg-transparent p-2.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="name,SKU,purchasePrice,sellingPrice,barcode,openingStock"
            />
            <p className="text-xs text-muted-foreground">
              Columns required: <code>name</code>, <code>SKU</code>, <code>sellingPrice</code>. Optional: <code>purchasePrice</code>, <code>barcode</code>, <code>openingStock</code>.
            </p>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={handleParseCsv}>
              Parse &amp; Preview
            </Button>
            {parsedRows.length > 0 && (
              <Button
                type="button"
                disabled={isPending || !selectedCatId || !selectedUnitId}
                onClick={handleExecuteImport}
              >
                {isPending ? "Importing items..." : `Import ${parsedRows.length} product(s)`}
              </Button>
            )}
          </div>
        </div>

        {/* Parsed items preview table */}
        {parsedRows.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Preview parsed rows ({parsedRows.length})</h2>
            <div className="table-scroll">
              <table className="w-full text-sm" aria-label="Import preview">
                <thead className="border-b bg-muted/40 text-left">
                  <tr>
                    <th className="p-2.5 font-medium">Name</th>
                    <th className="p-2.5 font-medium">SKU</th>
                    <th className="p-2.5 text-right font-medium">Cost (₹)</th>
                    <th className="p-2.5 text-right font-medium">Selling (₹)</th>
                    <th className="p-2.5 text-right font-medium">Opening Stock</th>
                    <th className="p-2.5 font-medium">Barcode</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {parsedRows.map((r, i) => (
                    <tr key={i} className="hover:bg-muted/30">
                      <td className="p-2.5 font-medium">{r.name}</td>
                      <td className="p-2.5 text-muted-foreground font-mono text-xs">{r.SKU}</td>
                      <td className="p-2.5 text-right tabular-nums">{r.purchasePrice.toFixed(2)}</td>
                      <td className="p-2.5 text-right tabular-nums font-semibold">{r.sellingPrice.toFixed(2)}</td>
                      <td className="p-2.5 text-right tabular-nums">{r.openingStock ?? 0}</td>
                      <td className="p-2.5 text-muted-foreground font-mono text-xs">{r.barcode || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </AppShell>
  );
}
