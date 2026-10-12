"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { forgetSessionIdentity } from "@/lib/offline/sessionIdentity";

/*
 * "My account": change password, log out, log out everywhere.
 * All rules are enforced by the API; this page only reports results.
 */

interface Me {
    user: { name: string; email: string; mustChangePassword?: boolean };
    tenant: { name: string };
    device: { deviceName: string };
}

type Notice = { kind: "success" | "error"; text: string } | null;

async function postJson(path: string, body?: unknown) {
    try {
        const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, data };
    } catch {
        return { ok: false, status: 0, data: { message: "Unable to connect to the server." } };
    }
}

export default function AccountPage() {
    const [me, setMe] = useState<Me | null>(null);
    const [loading, setLoading] = useState(true);
    const [signedOut, setSignedOut] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
    const [busy, setBusy] = useState<"password" | "logout" | "logout-all" | null>(null);

    useEffect(() => {
        let cancelled = false;

        fetch("/api/auth/me", { credentials: "include" })
            .then(async (response) => {
                if (cancelled) return;
                if (!response.ok) {
                    setSignedOut(true);
                    return;
                }
                setMe(await response.json());
            })
            .catch(() => !cancelled && setNotice({ kind: "error", text: "Unable to connect to the server." }))
            .finally(() => !cancelled && setLoading(false));

        return () => {
            cancelled = true;
        };
    }, []);

    async function changePassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setNotice(null);
        setFieldErrors({});

        if (newPassword !== confirmPassword) {
            setFieldErrors({ confirmPassword: ["The new passwords do not match."] });
            return;
        }

        setBusy("password");
        const result = await postJson("/api/auth/change-password", { currentPassword, newPassword });
        setBusy(null);

        if (!result.ok) {
            if (result.status === 401) {
                setSignedOut(true);
                return;
            }
            setNotice({ kind: "error", text: result.data.message || "Unable to change password." });
            setFieldErrors(result.data.errors?.fieldErrors ?? {});
            return;
        }

        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");

        if (result.data.requireLogin) {
            setSignedOut(true);
            return;
        }

        setNotice({ kind: "success", text: result.data.message });
        // The server lifted the temporary-password restriction.
        setMe((current) =>
            current ? { ...current, user: { ...current.user, mustChangePassword: false } } : current
        );
    }

    async function logout(all: boolean) {
        if (all && !window.confirm("Sign out of every device, including this one?")) {
            return;
        }

        setBusy(all ? "logout-all" : "logout");
        const result = await postJson(all ? "/api/auth/logout-all" : "/api/auth/logout");
        setBusy(null);

        if (!result.ok && result.status !== 401) {
            setNotice({ kind: "error", text: result.data.message || "Unable to sign out." });
            return;
        }

        // Offline work can no longer be queued for this account. Queued but
        // unsynced items are kept and sync again when this account signs in.
        await forgetSessionIdentity().catch(() => undefined);
        setSignedOut(true);
    }

    const inputClass = "h-8 rounded-lg border border-border bg-background px-2 text-sm";
    const fieldError = (field: string) =>
        fieldErrors[field]?.length ? (
            <span className="text-xs text-destructive">{fieldErrors[field]?.join(" ")}</span>
        ) : null;

    if (signedOut) {
        return (
            <main className="mx-auto w-full max-w-xl px-4 py-10">
                <h1 className="text-2xl font-semibold">My account</h1>
                <p className="mt-4" role="status">
                    You are signed out.{" "}
                    <Link className="underline" href="/login">Log in</Link>
                </p>
            </main>
        );
    }

    return (
        <main className="mx-auto w-full max-w-xl px-4 py-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold">My account</h1>
                <Link className="text-sm underline" href="/users">User Management</Link>
            </div>

            {loading && <p className="mt-4 text-muted-foreground">Loading…</p>}

            {me && (
                <p className="mt-4 text-sm">
                    Signed in as <strong>{me.user.name}</strong> ({me.user.email}) at {me.tenant.name},
                    on device {me.device.deviceName}.
                </p>
            )}

            {me?.user.mustChangePassword && (
                <p role="alert" className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    An administrator reset your password. You must choose a new password
                    before you can use the rest of the application.
                </p>
            )}

            {notice && (
                <p
                    role={notice.kind === "error" ? "alert" : "status"}
                    className={`mt-4 rounded-lg px-3 py-2 text-sm ${notice.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-muted"}`}
                >
                    {notice.text}
                </p>
            )}

            {me && (
                <>
                    <form onSubmit={changePassword} className="mt-6 grid gap-3 rounded-lg border border-border p-4" noValidate>
                        <h2 className="text-lg font-medium">Change password</h2>
                        <label className="flex flex-col gap-1 text-sm">
                            Current password
                            <input className={inputClass} type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required maxLength={128} />
                            {fieldError("currentPassword")}
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            New password (at least 12 characters)
                            <input className={inputClass} type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={12} maxLength={128} />
                            {fieldError("newPassword")}
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Confirm new password
                            <input className={inputClass} type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required maxLength={128} />
                            {fieldError("confirmPassword")}
                        </label>
                        <p className="text-xs text-muted-foreground">
                            Changing your password signs you out on all other devices.
                        </p>
                        <div>
                            <Button type="submit" disabled={busy !== null}>
                                {busy === "password" ? "Saving…" : "Change password"}
                            </Button>
                        </div>
                    </form>

                    <div className="mt-6 flex flex-wrap gap-2">
                        <Button variant="outline" disabled={busy !== null} onClick={() => logout(false)}>
                            {busy === "logout" ? "Signing out…" : "Log out"}
                        </Button>
                        <Button variant="destructive" disabled={busy !== null} onClick={() => logout(true)}>
                            {busy === "logout-all" ? "Signing out…" : "Log out of all devices"}
                        </Button>
                    </div>
                </>
            )}
        </main>
    );
}
