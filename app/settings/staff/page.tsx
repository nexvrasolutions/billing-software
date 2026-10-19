"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Member {
    id: string;
    name: string;
    email: string;
    roleName: string | null;
    status: "active" | "inactive";
    isOwner: boolean;
}

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

export default function StaffPage() {
    const [members, setMembers] = useState<Member[]>([]);
    const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Invite form
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [roleId, setRoleId] = useState("");
    const [inviting, setInviting] = useState(false);
    const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

    async function loadStaff() {
        try {
            const res = await fetch("/api/users");
            const data = await res.json();
            if (data.success) {
                setMembers(data.users || []);
                setRoles(data.roles || []);
                if (data.roles?.length > 0 && !roleId) {
                    setRoleId(data.roles[0].id);
                }
            } else {
                setError(data.message || "Failed to load team");
            }
        } catch (err: any) {
            setError(err.message || "Failed to load team");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadStaff();
    }, []);

    async function handleInvite(e: React.FormEvent) {
        e.preventDefault();
        setInviting(true);
        setError(null);
        setInviteSuccess(null);

        try {
            const res = await fetch("/api/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name.trim(),
                    email: email.trim(),
                    password: password || "BillingPass123!",
                    roleId: roleId || undefined,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setInviteSuccess(`Added ${name} to team.`);
                setName("");
                setEmail("");
                setPassword("");
                loadStaff();
            } else {
                setError(data.message || "Failed to add member");
            }
        } catch (err: any) {
            setError(err.message || "Network error");
        } finally {
            setInviting(false);
        }
    }

    return (
        <AppShell>
            <main className="flex max-w-3xl flex-col gap-6">
                <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>

                {error && <p className="text-sm text-destructive">{error}</p>}
                {inviteSuccess && <p className="text-sm text-emerald-600 dark:text-emerald-400">{inviteSuccess}</p>}

                <section className="flex flex-col gap-2">
                    <h2 className="text-lg font-semibold">Invite someone</h2>
                    <p className="text-sm text-muted-foreground">
                        Add a new team member with their work email and assigned role.
                    </p>
                    <form onSubmit={handleInvite} className="flex flex-col gap-3 rounded-lg border p-4">
                        <div className="flex flex-wrap gap-3">
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="staff-name">Name</Label>
                                <Input
                                    id="staff-name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    required
                                    placeholder="Full name"
                                    className="w-48"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="staff-email">Email</Label>
                                <Input
                                    id="staff-email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    placeholder="colleague@example.com"
                                    className="w-56"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="staff-role">Role</Label>
                                <select
                                    id="staff-role"
                                    value={roleId}
                                    onChange={(e) => setRoleId(e.target.value)}
                                    className={selectClass}
                                >
                                    {roles.map((r) => (
                                        <option key={r.id} value={r.id}>
                                            {r.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <Button type="submit" disabled={inviting} className="self-start">
                            {inviting ? "Adding..." : "Add to team"}
                        </Button>
                    </form>
                </section>

                <section className="flex flex-col gap-2">
                    <h2 className="text-lg font-semibold">Team</h2>
                    {loading ? (
                        <p className="text-sm text-muted-foreground">Loading team...</p>
                    ) : members.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No team members found.</p>
                    ) : (
                        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Team">
                            {members.map((m) => (
                                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                                    <div className="flex flex-col">
                                        <span className="font-medium">
                                            {m.name} {m.isOwner ? "· (Owner)" : ""}
                                        </span>
                                        <span className="text-muted-foreground text-xs">{m.email}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
                                            {m.roleName || (m.isOwner ? "Owner" : "Cashier")}
                                        </span>
                                        <span className="text-xs text-muted-foreground capitalize">
                                            {m.status}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </main>
        </AppShell>
    );
}
