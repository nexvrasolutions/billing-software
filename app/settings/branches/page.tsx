"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Branch {
  id: string;
  name: string;
  code: string;
  type: "store" | "warehouse";
  address: string;
  status: "active" | "inactive";
  isDefault: boolean;
}

export default function BranchesSettingsPage() {
  const [branches, setBranches] = useState<Branch[]>([
    {
      id: "main",
      name: "Main Store",
      code: "BR-01",
      type: "store",
      address: "Primary Business Premises",
      status: "active",
      isDefault: true,
    },
  ]);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<"store" | "warehouse">("store");
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const handleAddBranch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newBranch: Branch = {
      id: `branch-${Date.now()}`,
      name: name.trim(),
      code: code.trim().toUpperCase() || `BR-0${branches.length + 1}`,
      type,
      address: address.trim() || "Local Location",
      status: "active",
      isDefault: false,
    };

    setBranches([...branches, newBranch]);
    setName("");
    setCode("");
    setAddress("");
    setShowAdd(false);
    setMessage(`Branch "${newBranch.name}" created.`);
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Branches &amp; Locations</h1>
            <p className="text-xs text-muted-foreground">
              Manage store branches, retail outlets, and inventory locations.
            </p>
          </div>
          <Button type="button" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? "Cancel" : "Add branch"}
          </Button>
        </div>

        {message && <p role="status" className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{message}</p>}

        {showAdd && (
          <form
            onSubmit={handleAddBranch}
            className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
          >
            <h2 className="font-semibold">New branch location</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="branch-name">Branch name *</Label>
                <Input
                  id="branch-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. South Counter, Warehouse 2"
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="branch-code">Branch code</Label>
                <Input
                  id="branch-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. BR-02"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="branch-type">Location type</Label>
                <select
                  id="branch-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as "store" | "warehouse")}
                  className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                >
                  <option value="store">Retail Store / Counter</option>
                  <option value="warehouse">Storage Warehouse</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="branch-address">Address / Location</Label>
                <Input
                  id="branch-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street / City location"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit">Create branch</Button>
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        <div className="table-scroll">
          <table className="w-full text-sm" aria-label="Branches">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2.5 font-medium">Branch name</th>
                <th className="p-2.5 font-medium">Code</th>
                <th className="p-2.5 font-medium">Type</th>
                <th className="p-2.5 font-medium">Address</th>
                <th className="p-2.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {branches.map((b) => (
                <tr key={b.id} className="hover:bg-muted/30">
                  <td className="p-2.5 font-medium">
                    {b.name}{" "}
                    {b.isDefault && (
                      <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Default
                      </span>
                    )}
                  </td>
                  <td className="p-2.5 text-muted-foreground font-mono text-xs">{b.code}</td>
                  <td className="p-2.5 capitalize text-muted-foreground">{b.type}</td>
                  <td className="p-2.5 text-muted-foreground">{b.address}</td>
                  <td className="p-2.5 text-right">
                    <span className="inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 capitalize">
                      {b.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </AppShell>
  );
}
