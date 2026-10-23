"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SetupPage() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [branchName, setBranchName] = useState("Main Store");
  const [tillName, setTillName] = useState("Counter 1");
  const [gstin, setGstin] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    async function loadCurrentContext() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        const data = await res.json().catch(() => null);

        if (!active) return;
        if (data?.authenticated) {
          const tenantName =
            data.tenant?.name || data.user?.businessName || "My Store";
          setBusinessName(tenantName);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadCurrentContext();
    return () => {
      active = false;
    };
  }, []);

  const handleCompleteSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim() || !branchName.trim()) {
      setError("Business name and branch name are required.");
      return;
    }

    setError(null);
    startTransition(async () => {
      // Store local setup flag and till name
      if (typeof window !== "undefined") {
        localStorage.setItem("setup_completed", "true");
        localStorage.setItem("pos_till_name", tillName);
      }
      router.replace("/dashboard");
    });
  };

  return (
    <AuthCard
      title="Store setup"
      description="Initialize your business workspace, branch, and primary till terminal."
    >
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground">Checking setup status...</p>
      ) : (
        <form onSubmit={handleCompleteSetup} className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-biz">Business / Store name *</Label>
            <Input
              id="setup-biz"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="e.g. Metro Supermarket"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-branch">Primary branch *</Label>
            <Input
              id="setup-branch"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="e.g. Main Store"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-till">Primary till terminal</Label>
            <Input
              id="setup-till"
              value={tillName}
              onChange={(e) => setTillName(e.target.value)}
              placeholder="e.g. Counter 1"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-gstin">GSTIN (Optional)</Label>
            <Input
              id="setup-gstin"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="15-character GST number"
              maxLength={15}
            />
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Configuring workspace..." : "Complete setup & open dashboard"}
          </Button>

          <Link href="/dashboard" className="text-center text-xs text-muted-foreground hover:underline">
            Skip to dashboard
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
