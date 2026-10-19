"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function BusinessSettingsPage() {
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState("Retail Store");
  const [pricingMode, setPricingMode] = useState<"tax_inclusive" | "tax_exclusive">("tax_inclusive");
  const [gstin, setGstin] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [invoiceFooter, setInvoiceFooter] = useState("Thank you for your business!");
  const currency = "INR (₹)";
  const [loading, setLoading] = useState(true);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    async function loadBusinessData() {
      try {
        const res = await fetch("/api/settings/business", { credentials: "same-origin" });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (!active) return;
          if (data?.success && data.settings) {
            setBusinessName(data.settings.name || "");
            if (data.settings.businessType) setBusinessType(data.settings.businessType);
            if (data.settings.pricingMode) setPricingMode(data.settings.pricingMode);
            return;
          }
        }

        // Fallback to /api/auth/me if settings route is not available
        const meRes = await fetch("/api/auth/me", { credentials: "same-origin" });
        const meData = await meRes.json().catch(() => null);
        if (!active) return;
        if (meData?.authenticated) {
          const tenantName =
            meData.tenant?.name || meData.user?.businessName || "My Business";
          setBusinessName(tenantName);
          if (meData.tenant?.businessType) setBusinessType(meData.tenant.businessType);
          if (meData.tenant?.pricingMode) setPricingMode(meData.tenant.pricingMode);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadBusinessData();
    return () => {
      active = false;
    };
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSavedMessage(null);
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/settings/business", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            name: businessName.trim(),
            businessType: businessType.trim() || undefined,
            pricingMode,
          }),
        });

        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          setSavedMessage("Business profile settings updated.");
          if (data.settings?.pricingMode) setPricingMode(data.settings.pricingMode);
        } else {
          setErrorMessage(data?.message || "Failed to update business settings");
        }
      } catch (err: any) {
        setErrorMessage(err.message || "Failed to connect to server");
      }
    });
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Business profile</h1>
            <p className="text-xs text-muted-foreground">
              Configure your registered company name, tax details, and invoice branding.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/settings/branches"
              className="inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium hover:bg-muted"
            >
              Branches
            </Link>
            <Link
              href="/settings/tills/flags"
              className="inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium hover:bg-muted"
            >
              Till flags
            </Link>
          </div>
        </div>

        {savedMessage && (
          <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            {savedMessage}
          </p>
        )}

        {errorMessage && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs font-medium text-destructive">
            {errorMessage}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading business profile...</p>
        ) : (
          <form
            onSubmit={handleSave}
            className="flex flex-col gap-6 rounded-lg border bg-card p-5 text-sm"
          >
            <section className="flex flex-col gap-4">
              <h2 className="text-base font-semibold">General information</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="biz-name">Trade / Company name *</Label>
                  <Input
                    id="biz-name"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="biz-type">Business type</Label>
                  <Input
                    id="biz-type"
                    value={businessType}
                    onChange={(e) => setBusinessType(e.target.value)}
                    placeholder="e.g. Retail POS & Supermarket"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="biz-phone">Business phone</Label>
                  <Input
                    id="biz-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 9876543210"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="biz-email">Support email</Label>
                  <Input
                    id="biz-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="contact@business.com"
                  />
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-4 border-t pt-4">
              <h2 className="text-base font-semibold">Taxation &amp; Invoicing</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <Label>Pricing &amp; GST Calculation Mode *</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label
                      htmlFor="pricing-mode-inclusive"
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-xs transition-colors ${
                        pricingMode === "tax_inclusive"
                          ? "border-primary bg-primary/5 font-medium"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <input
                        type="radio"
                        id="pricing-mode-inclusive"
                        name="pricingMode"
                        value="tax_inclusive"
                        checked={pricingMode === "tax_inclusive"}
                        onChange={() => setPricingMode("tax_inclusive")}
                        className="mt-0.5"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-foreground">Tax-inclusive</span>
                        <span className="text-muted-foreground">
                          Product selling prices already include GST. Best for retail stores and POS counters.
                        </span>
                      </div>
                    </label>

                    <label
                      htmlFor="pricing-mode-exclusive"
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-xs transition-colors ${
                        pricingMode === "tax_exclusive"
                          ? "border-primary bg-primary/5 font-medium"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <input
                        type="radio"
                        id="pricing-mode-exclusive"
                        name="pricingMode"
                        value="tax_exclusive"
                        checked={pricingMode === "tax_exclusive"}
                        onChange={() => setPricingMode("tax_exclusive")}
                        className="mt-0.5"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-foreground">Tax-exclusive</span>
                        <span className="text-muted-foreground">
                          GST is calculated and added on top of product selling prices.
                        </span>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="biz-gstin">GSTIN / Tax identification</Label>
                  <Input
                    id="biz-gstin"
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    placeholder="15-character GSTIN code"
                    maxLength={15}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="biz-currency">Base currency</Label>
                  <Input
                    id="biz-currency"
                    value={currency}
                    disabled
                    className="bg-muted/50"
                  />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="biz-address">Physical address</Label>
                  <Input
                    id="biz-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Registered business address printed on receipts"
                  />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="biz-footer">Invoice footer note</Label>
                  <Input
                    id="biz-footer"
                    value={invoiceFooter}
                    onChange={(e) => setInvoiceFooter(e.target.value)}
                    placeholder="Terms or thank-you note shown at bottom of receipts"
                  />
                </div>
              </div>
            </section>

            <div>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving changes..." : "Save business settings"}
              </Button>
            </div>
          </form>
        )}
      </main>
    </AppShell>
  );
}
