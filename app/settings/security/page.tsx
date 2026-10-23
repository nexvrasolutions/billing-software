"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SecuritySettingsPage() {
    const [enabled, setEnabled] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    function handleChangePassword(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setMessage(null);
        if (newPassword !== confirmPassword) {
            setError("New passwords do not match.");
            return;
        }
        if (newPassword.length < 8) {
            setError("Password must be at least 8 characters.");
            return;
        }
        setMessage("Password updated successfully.");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
    }

    return (
        <AppShell>
            <main className="flex max-w-2xl flex-col gap-6">
                <h1 className="text-2xl font-semibold tracking-tight">Security & Two-step login</h1>

                {error && <p className="text-sm text-destructive">{error}</p>}
                {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}

                <section className="flex flex-col gap-3 rounded-lg border p-4">
                    <h2 className="text-base font-semibold">Two-step verification</h2>
                    <p className="text-sm text-muted-foreground">
                        Protect your account from unauthorized access with TOTP authenticator apps (Google Authenticator, Microsoft Authenticator).
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                setEnabled(!enabled);
                                setMessage(enabled ? "Two-step verification turned off." : "Two-step verification setup enabled.");
                            }}
                        >
                            {enabled ? "Disable two-step verification" : "Set up authenticator app"}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            Status: <strong className={enabled ? "text-emerald-600 dark:text-emerald-400" : ""}>{enabled ? "Enabled" : "Disabled"}</strong>
                        </span>
                    </div>
                </section>

                <section className="flex flex-col gap-3 rounded-lg border p-4">
                    <h2 className="text-base font-semibold">Change password</h2>
                    <form onSubmit={handleChangePassword} className="flex flex-col gap-3 max-w-md">
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="curr-pass">Current password</Label>
                            <Input
                                id="curr-pass"
                                type="password"
                                value={currentPassword}
                                onChange={(e) => setCurrentPassword(e.target.value)}
                                required
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="new-pass">New password</Label>
                            <Input
                                id="new-pass"
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                required
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="confirm-pass">Confirm new password</Label>
                            <Input
                                id="confirm-pass"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                            />
                        </div>
                        <Button type="submit" variant="outline" size="sm" className="self-start mt-1">
                            Update password
                        </Button>
                    </form>
                </section>
            </main>
        </AppShell>
    );
}
