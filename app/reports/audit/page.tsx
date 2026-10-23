"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";

export default function AuditLogPage() {
    const today = new Date().toISOString().slice(0, 10);
    const [from, setFrom] = useState(today);
    const [to, setTo] = useState(today);
    const [actionQuery, setActionQuery] = useState("");
    const [page, setPage] = useState(1);
    const [entries, setEntries] = useState<any[]>([]);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    async function loadLogs(p = page) {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: String(p),
                limit: "25",
            });
            if (actionQuery.trim()) params.set("action", actionQuery.trim());

            const res = await fetch(`/api/audit-logs?${params.toString()}`);
            const data = await res.json();
            if (data.success) {
                setEntries(data.auditLogs || []);
                setTotalPages(data.totalPages || 1);
            } else {
                setError(data.message || "Failed to load audit logs");
            }
        } catch (err: any) {
            setError(err.message || "Failed to load audit logs");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadLogs(1);
    }, []);

    const at = (iso: string) =>
        new Date(iso).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            dateStyle: "medium",
            timeStyle: "medium",
        });

    return (
        <AppShell>
            <main className="flex max-w-5xl flex-col gap-4">
                <Link href="/reports" className="text-sm underline">
                    ← Reports
                </Link>
                <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>

                <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-sm">
                        From
                        <input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        To
                        <input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Action (e.g. sale, user)
                        <input
                            value={actionQuery}
                            onChange={(e) => setActionQuery(e.target.value)}
                            maxLength={60}
                            placeholder="action name"
                            className="h-8 w-64 rounded-lg border border-input bg-transparent px-2 text-sm"
                        />
                    </label>
                    <button
                        type="button"
                        onClick={() => {
                            setPage(1);
                            loadLogs(1);
                        }}
                        className="h-8 rounded-lg border px-3 text-sm"
                    >
                        Show
                    </button>
                </div>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading audit log...</p>
                ) : error ? (
                    <p className="text-sm text-destructive">{error}</p>
                ) : entries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing recorded for these filters.</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-lg border text-sm" aria-label="Audit entries">
                        {entries.map((e) => (
                            <li key={e.id || e._id} className="flex flex-col gap-1 p-2.5">
                                <p>
                                    <span className="tabular-nums text-muted-foreground">
                                        {at(e.createdAt || e.occurredAt || new Date().toISOString())}
                                    </span>{" "}
                                    · <strong>{e.actorName || e.userId || "System"}</strong> ·{" "}
                                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                                        {e.action}
                                    </code>
                                </p>
                                {e.changes && (
                                    <details className="mt-1">
                                        <summary className="cursor-pointer text-xs text-muted-foreground">
                                            Details
                                        </summary>
                                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">
                                            {JSON.stringify(e.changes, null, 2)}
                                        </pre>
                                    </details>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                <div className="flex gap-3 text-sm">
                    {page > 1 && (
                        <button
                            type="button"
                            onClick={() => {
                                const prev = page - 1;
                                setPage(prev);
                                loadLogs(prev);
                            }}
                            className="underline"
                        >
                            Newer
                        </button>
                    )}
                    {page < totalPages && (
                        <button
                            type="button"
                            onClick={() => {
                                const next = page + 1;
                                setPage(next);
                                loadLogs(next);
                            }}
                            className="underline"
                        >
                            Older
                        </button>
                    )}
                </div>
            </main>
        </AppShell>
    );
}
