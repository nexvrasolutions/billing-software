"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/layout/AppShell";
import {
    confirmServerSession,
    endOfflineAccess,
    getLastRenewalOutcome,
    identityFromMe,
    isSessionRejected,
    renewalProblemText,
} from "@/lib/offline/sessionIdentity";
import { countAllUnsyncedItems } from "@/lib/offline/pendingQueue";
import { ExportPendingButton } from "@/components/offline/ExportPendingButton";
import { SyncNowButton } from "@/components/offline/SyncNowButton";
import {
    getOfflineStateFor,
    removeOfflineAccess,
    settlePendingServerLogout,
} from "@/lib/offline/offlineAccess";
import {
    OFFLINE_WORK_PERMISSION,
    type OfflineSessionState,
} from "@/lib/offline/offlineSession";

/*
 * "My account": change password, offline access, log out, log out everywhere.
 * All rules are enforced by the API; this page only reports results.
 */

interface Me {
    user: { id: string; tenantId: string; name: string; email: string; mustChangePassword?: boolean };
    tenant: { name: string };
    device: { id: string; deviceName: string };
    permissions?: string[];
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

/**
 * Offline access status. The offline session is created or renewed
 * automatically (72 hours) whenever the server confirms this session while
 * online; nothing is set up or entered here.
 */
function OfflineAccessSection({ me }: { me: Me }) {
    const [state, setState] = useState<OfflineSessionState | null>(null);
    const [result, setResult] = useState<Notice>(null);
    const identity = identityFromMe(me);
    const renewalProblem = renewalProblemText(getLastRenewalOutcome());
    const allowed = (me.permissions ?? []).includes(OFFLINE_WORK_PERMISSION);
    const tenantId = me.user.tenantId;
    const userId = me.user.id;
    const deviceId = me.device.id;

    const refresh = useCallback(() => {
        const current = identityFromMe({ user: { tenantId, id: userId }, device: { id: deviceId } });
        if (current) void getOfflineStateFor(current).then(setState).catch(() => undefined);
    }, [tenantId, userId, deviceId]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function remove() {
        if (!identity) return;
        await removeOfflineAccess(identity).catch(() => undefined);
        setResult({ kind: "success", text: "Offline access removed from this device. Queued work is kept." });
        refresh();
    }

    return (
        <section aria-label="Offline access" className="mt-6 grid gap-3 rounded-lg border border-border p-4">
            <h2 className="text-lg font-medium">Offline access</h2>
            <p className="text-sm">
                {state?.status === "available"
                    ? `Offline session expires at ${new Date(state.expiresAt).toLocaleString()}.`
                    : state?.status === "expired"
                        ? `The offline session expired at ${new Date(state.expiresAt).toLocaleString()}. It is renewed when your session is verified online.`
                        : "Offline access is not available on this device. It is enabled when your session is verified online."}
            </p>
            <p className="text-xs text-muted-foreground">
                Offline access lasts 72 hours after the last time the server verified your session on
                this device. It is renewed only when you are online. It does not sign you in to the
                server, and work recorded offline is checked again by the server when it syncs.
            </p>

            {!allowed && <p className="text-sm">Your role is not allowed to record sales offline.</p>}

            {renewalProblem && <p role="alert" className="text-sm text-destructive">{renewalProblem}</p>}

            <p className="text-xs text-muted-foreground">
                Sending waiting operations does not extend the offline session; only signing in or
                opening the dashboard or this page while online does. Waiting operations can be
                saved to a file; that file is a record only, not an import, and the operations stay
                on this device owned by their original account.
            </p>

            <div className="flex flex-wrap items-start gap-3">
                <SyncNowButton />
                <ExportPendingButton />
            </div>

            {result && (
                <p role={result.kind === "error" ? "alert" : "status"} className="text-sm">
                    {result.text}
                </p>
            )}

            {state && state.status !== "none" && (
                <div>
                    <Button type="button" variant="outline" onClick={remove}>
                        Remove offline access
                    </Button>
                </div>
            )}
        </section>
    );
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

        settlePendingServerLogout()
            .then(async (pending) => {
                if (cancelled) return;
                // An offline sign-out must end the old server session first.
                if (pending === "done") {
                    setSignedOut(true);
                    return;
                }
                if (pending === "unreachable") {
                    setNotice({ kind: "error", text: "Unable to contact the server to verify your session." });
                    return;
                }

                const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
                if (cancelled) return;
                if (isSessionRejected(response.status)) {
                    // A definitive rejection ends the remembered identity and
                    // its offline session (queued offline work is kept).
                    await endOfflineAccess().catch(() => undefined);
                    setSignedOut(true);
                    return;
                }
                if (!response.ok) {
                    // A server error says nothing about the session.
                    setNotice({ kind: "error", text: "Unable to contact the server to verify your session." });
                    return;
                }
                const data = await response.json();
                // The account page is one of the three places (with login and
                // the dashboard) that may renew the 72-hour offline authorization.
                await confirmServerSession(data, { renew: true }).catch(() => undefined);
                if (!cancelled) setMe(data);
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
                await endOfflineAccess().catch(() => undefined);
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
            await endOfflineAccess().catch(() => undefined);
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

        // Waiting operations stay on this device after logging out. Warn first.
        const waiting = await countAllUnsyncedItems().catch(() => 0);
        if (
            waiting > 0 &&
            !window.confirm(
                `${waiting} operation(s) are still waiting to be sent on this device. They will NOT be deleted, ` +
                "but only the account that made them can send them, after signing in again. " +
                "Another account cannot sign in here until they are sent or saved to a file. Log out now?"
            )
        ) {
            return;
        }

        setBusy(all ? "logout-all" : "logout");
        const result = await postJson(all ? "/api/auth/logout-all" : "/api/auth/logout");
        setBusy(null);

        if (!result.ok && result.status !== 401) {
            setNotice({ kind: "error", text: result.data.message || "Unable to sign out." });
            return;
        }

        // Offline work can no longer be queued for this account and its
        // offline session is removed. Queued but unsynced items are kept
        // and sync again when this account signs in.
        await endOfflineAccess().catch(() => undefined);
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
        <AppShell>
            <main className="max-w-2xl flex flex-col gap-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h1 className="text-2xl font-semibold tracking-tight">My account</h1>
                    <Link className="text-sm underline" href="/settings/staff">Staff & Team</Link>
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

                    {!me.user.mustChangePassword && <OfflineAccessSection me={me} />}

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
        </AppShell>
    );
}
