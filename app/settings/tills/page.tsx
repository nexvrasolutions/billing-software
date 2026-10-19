"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function TillsSettingsPage() {
    const [tillName, setTillName] = useState("Counter 1");
    const [prefix, setPrefix] = useState("C1");
    const [offlineHours, setOfflineHours] = useState("72");
    const [registeredTills, setRegisteredTills] = useState<any[]>([
        {
            id: "till-1",
            name: "Main POS Till",
            prefix: "POS1",
            branchName: "Main Store",
            lastSeenAt: new Date().toISOString(),
            status: "active",
        },
    ]);
    const [message, setMessage] = useState<string | null>(null);

    const when = (iso: string): string =>
        new Date(iso).toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "Asia/Kolkata",
        });

    function handleRegister(e: React.FormEvent) {
        e.preventDefault();
        const newTill = {
            id: `till-${Date.now()}`,
            name: tillName.trim(),
            prefix: prefix.trim().toUpperCase(),
            branchName: "Main Store",
            lastSeenAt: new Date().toISOString(),
            status: "active",
        };
        setRegisteredTills([...registeredTills, newTill]);
        setMessage(`Workstation "${tillName}" registered successfully.`);
    }

    return (
        <AppShell>
            <main className="flex max-w-3xl flex-col gap-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h1 className="text-2xl font-semibold tracking-tight">Tills</h1>
                    <Link href="/sync" className="text-sm underline">
                        Sync status
                    </Link>
                </div>

                <p className="text-sm text-muted-foreground">
                    A registered till can keep billing when the internet stops. Its offline bills are sent when the connection is back; anything that no longer fits (price, stock, IMEI…) is kept and listed for you to check.
                </p>

                {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}

                {/* Register computer section */}
                <section className="flex flex-col gap-3 rounded-lg border p-4">
                    <h2 className="text-base font-semibold">Register this computer as a till</h2>
                    <form onSubmit={handleRegister} className="flex flex-wrap items-end gap-3 text-sm">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="till-name">Till name</Label>
                            <Input
                                id="till-name"
                                value={tillName}
                                onChange={(e) => setTillName(e.target.value)}
                                required
                                className="w-48"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="till-prefix">Prefix</Label>
                            <Input
                                id="till-prefix"
                                value={prefix}
                                onChange={(e) => setPrefix(e.target.value)}
                                required
                                className="w-24 uppercase"
                            />
                        </div>
                        <Button type="submit" variant="outline" size="sm">
                            Register till
                        </Button>
                    </form>
                </section>

                {/* Registered tills list */}
                <section aria-label="Registered tills" className="flex flex-col gap-2">
                    <h2 className="font-medium">Registered tills</h2>
                    <ul className="flex flex-col divide-y rounded-lg border">
                        {registeredTills.map((t) => (
                            <li
                                key={t.id}
                                className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                                aria-label={t.name}
                            >
                                <span>
                                    <strong>{t.name}</strong> ({t.prefix}) · {t.branchName} · last seen{" "}
                                    {when(t.lastSeenAt)}
                                </span>
                                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium capitalize">
                                    {t.status}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>

                <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm bg-muted/20">
                    <h2 className="font-semibold">Offline lease window</h2>
                    <p className="text-muted-foreground">
                        Tills may bill offline for {offlineHours} hours after their last online contact.
                    </p>
                </div>
            </main>
        </AppShell>
    );
}
