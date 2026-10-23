"use client";

import { useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";

interface FlagSetting {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  category: "offline" | "security" | "pricing";
}

export default function TillFlagsPage() {
  const [flags, setFlags] = useState<FlagSetting[]>([
    {
      id: "allow_offline_billing",
      title: "Allow offline billing without server connection",
      description: "Permits till operators to create and print bills during network interruptions. Bills queue in IndexedDB and sync when online.",
      enabled: true,
      category: "offline",
    },
    {
      id: "auto_sync_on_reconnect",
      title: "Automatic background sync on reconnect",
      description: "Automatically synchronizes pending offline queues as soon as internet connection is detected without requiring manual operator intervention.",
      enabled: true,
      category: "offline",
    },
    {
      id: "account_switch_guard",
      title: "Account switch protection guard",
      description: "Prevents a different user from signing in on this workstation until any waiting offline bills have been synchronized or exported to file.",
      enabled: true,
      category: "security",
    },
    {
      id: "enforce_72h_limit",
      title: "Enforce 72-hour offline session expiry",
      description: "Requires workstations to re-authenticate with the server at least once every 72 hours for cryptographic token renewal.",
      enabled: true,
      category: "security",
    },
    {
      id: "allow_negative_stock",
      title: "Allow billing items with zero or negative stock",
      description: "Allows till operators to complete sales even if local stock quantity is zero. Discrepancies are logged for inventory audit.",
      enabled: false,
      category: "pricing",
    },
    {
      id: "manager_price_override",
      title: "Require manager authorization for price overrides",
      description: "Requires administrator or manager approval whenever a cashier modifies the standard selling price on a bill line.",
      enabled: true,
      category: "pricing",
    },
  ]);

  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const toggleFlag = (id: string) => {
    setFlags((prev) =>
      prev.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f))
    );
  };

  const handleSave = () => {
    setSavedMessage("Till flag preferences saved for registered workstations.");
    setTimeout(() => setSavedMessage(null), 4000);
  };

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Offline till flags</h1>
            <p className="text-xs text-muted-foreground">
              Configure workstation behavioral flags, offline billing tolerance, and audit policies.
            </p>
          </div>
          <Link
            href="/settings/tills"
            className="inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium hover:bg-muted"
          >
            ← Registered tills
          </Link>
        </div>

        {savedMessage && (
          <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            {savedMessage}
          </p>
        )}

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border bg-card divide-y">
            {flags.map((flag) => (
              <div
                key={flag.id}
                className="flex items-start justify-between gap-4 p-4 hover:bg-muted/20 transition-colors"
              >
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-sm text-foreground">{flag.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
                    {flag.description}
                  </p>
                  <span className="mt-1 text-[10px] font-mono uppercase text-muted-foreground/80 tracking-wider">
                    Category: {flag.category}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={flag.enabled}
                  onClick={() => toggleFlag(flag.id)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    flag.enabled ? "bg-primary" : "bg-muted"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block size-5 transform rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out ${
                      flag.enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>

          <div>
            <Button type="button" onClick={handleSave}>
              Save flag configurations
            </Button>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
