import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PosScreen } from "@/components/pos/pos-screen";

export const metadata: Metadata = { title: "Billing" };

export default function PosPage() {
  return (
    <AppShell>
      <main className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">New bill</h1>
          <Link href="/sales" className="text-sm underline">
            Today&apos;s bills
          </Link>
        </div>
        <PosScreen />
      </main>
    </AppShell>
  );
}
