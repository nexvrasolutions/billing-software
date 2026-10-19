"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";

interface DeviceItem {
    _id: string;
    deviceId: string;
    name?: string;
    type?: string;
    status: string;
    lastActiveAt?: string;
    createdAt?: string;
}

export default function DevicesSettingsPage() {
    const [devices, setDevices] = useState<DeviceItem[]>([]);
    const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Read local current device id
        if (typeof window !== "undefined") {
            setCurrentDeviceId(localStorage.getItem("pos_device_id") || localStorage.getItem("device_id"));
        }

        async function fetchDevices() {
            try {
                const res = await fetch("/api/devices");
                const data = await res.json();
                if (data.success) {
                    setDevices(data.devices || []);
                } else {
                    setError(data.message || "Failed to load devices");
                }
            } catch (err: any) {
                setError(err.message || "Failed to load devices");
            } finally {
                setLoading(false);
            }
        }
        fetchDevices();
    }, []);

    const when = (iso?: string): string =>
        iso
            ? new Date(iso).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "Asia/Kolkata",
              })
            : "Never";

    async function handleLogout() {
        try {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
        } catch (err) {
            window.location.href = "/login";
        }
    }

    return (
        <AppShell>
            <main className="flex max-w-2xl flex-col gap-6">
                <h1 className="text-2xl font-semibold tracking-tight">Your devices</h1>
                <p className="text-sm text-muted-foreground">
                    Where you are logged in now. End any device you do not recognise, then change your password.
                </p>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading devices...</p>
                ) : error ? (
                    <p className="text-sm text-destructive">{error}</p>
                ) : devices.length === 0 ? (
                    <ul className="flex flex-col divide-y rounded-lg border" aria-label="Logged-in devices">
                        <li className="flex items-center justify-between gap-4 p-3">
                            <div className="flex min-w-0 flex-col text-sm">
                                <span className="truncate font-medium">This device</span>
                                <span className="text-muted-foreground">Current active session</span>
                            </div>
                            <Button variant="outline" size="sm" onClick={handleLogout}>
                                Log out
                            </Button>
                        </li>
                    </ul>
                ) : (
                    <ul className="flex flex-col divide-y rounded-lg border" aria-label="Logged-in devices">
                        {devices.map((d) => {
                            const isCurrent = d.deviceId === currentDeviceId;
                            return (
                                <li key={d._id} className="flex items-center justify-between gap-4 p-3">
                                    <div className="flex min-w-0 flex-col text-sm">
                                        <span className="truncate font-medium">
                                            {isCurrent ? "This device" : d.name || "Workstation"} · {d.type || "browser"}
                                        </span>
                                        <span className="text-muted-foreground">
                                            Registered {when(d.createdAt)} · last active {when(d.lastActiveAt)}
                                        </span>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={isCurrent ? handleLogout : undefined}
                                    >
                                        {isCurrent ? "Log out" : "End"}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}

                <Button variant="destructive" className="self-start" onClick={handleLogout}>
                    Log out everywhere
                </Button>
            </main>
        </AppShell>
    );
}
