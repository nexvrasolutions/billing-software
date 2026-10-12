"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
    confirmServerSession,
    endOfflineAccess,
    identityFromMe,
    isSessionRejected,
    rememberSessionIdentity,
} from "@/lib/offline/sessionIdentity";
import {
    getOfflineStateFor,
    removeOfflineAccess,
    settlePendingServerLogout,
    setUpOfflinePin,
} from "@/lib/offline/offlineAccess";
import {
    OFFLINE_WORK_PERMISSION,
    validatePin,
    type OfflineSessionState,
} from "@/lib/offline/offlineSession";

/*
 * "My account": change password, offline PIN, log out, log out everywhere.
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
 * Offline PIN (online only). Before saving, the server session is checked
 * live: same account and device, no temporary password pending, and the
 * sales.create permission. The PIN never leaves this device.
 */
function OfflinePinSection({ me }: { me: Me }) {
    const [state, setState] = useState<OfflineSessionState | null>(null);
    const [pin, setPin] = useState("");
    const [confirmPin, setConfirmPin] = useState("");
    const [result, setResult] = useState<Notice>(null);
    const [busy, setBusy] = useState(false);
    const identity = identityFromMe(me);
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

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setResult(null);

        const problem = validatePin(pin);
        if (problem) {
            setResult({ kind: "error", text: problem });
            return;
        }
        if (pin !== confirmPin) {
            setResult({ kind: "error", text: "The PINs do not match." });
            return;
        }

        setBusy(true);
        try {
            // Live server check right before saving (never a cached answer).
            const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
            const data = response.ok ? await response.json().catch(() => null) : null;
            const live = identityFromMe(data);

            if (
                !data?.authenticated ||
                data.user?.mustChangePassword === true ||
                !live || !identity ||
                live.tenantId !== identity.tenantId || live.userId !== identity.userId || live.deviceId !== identity.deviceId
            ) {
                setResult({ kind: "error", text: "Your session could not be confirmed. Sign in again and retry." });
                return;
            }
            const permissions: string[] = Array.isArray(data.permissions) ? data.permissions : [];
            if (!permissions.includes(OFFLINE_WORK_PERMISSION)) {
                setResult({ kind: "error", text: "Your role is not allowed to record sales offline." });
                return;
            }

            await rememberSessionIdentity(live);
            const record = await setUpOfflinePin({ identity: live, pin, permissions, displayName: data.user?.name });
            setResult({ kind: "success", text: `Offline PIN saved. Offline access is ready until ${new Date(record.expiresAt).toLocaleString()}.` });
        } catch {
            setResult({ kind: "error", text: "Unable to contact the server. The offline PIN can only be set while online." });
        } finally {
            setPin("");
            setConfirmPin("");
            setBusy(false);
            refresh();
        }
    }

    async function remove() {
        if (!identity) return;
        await removeOfflineAccess(identity).catch(() => undefined);
        setResult({ kind: "success", text: "Offline access removed from this device. Queued work is kept." });
        refresh();
    }

    const inputClass = "h-8 rounded-lg border border-border bg-background px-2 text-sm";

    return (
        <section aria-label="Offline PIN" className="mt-6 grid gap-3 rounded-lg border border-border p-4">
            <h2 className="text-lg font-medium">Offline access</h2>
            <p className="text-sm">
                {state?.status === "available"
                    ? `Offline access is ready on this device until ${new Date(state.expiresAt).toLocaleString()}.`
                    : state?.status === "expired"
                        ? "The offline session on this device has expired. It is renewed when you are signed in online."
                        : "Offline access is not set up on this device."}
            </p>
            <p className="text-xs text-muted-foreground">
                The PIN unlocks offline work on this device for up to 24 hours after your last online
                check. It is not sent to the server, it does not sign you in to the server, and it is
                not proof of payment. Five incorrect PINs remove offline access from this device;
                queued work is always kept.
            </p>

            {result && (
                <p role={result.kind === "error" ? "alert" : "status"} className="text-sm">
                    {result.text}
                </p>
            )}

            {!allowed ? (
                <p className="text-sm">Your role is not allowed to record sales offline.</p>
            ) : (
                <form onSubmit={save} className="grid gap-3" noValidate>
                    <label className="flex flex-col gap-1 text-sm">
                        New offline PIN (at least 6 digits)
                        <input className={inputClass} type="password" inputMode="numeric" autoComplete="off"
                            value={pin} onChange={(e) => setPin(e.target.value)} maxLength={12} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Confirm offline PIN
                        <input className={inputClass} type="password" inputMode="numeric" autoComplete="off"
                            value={confirmPin} onChange={(e) => setConfirmPin(e.target.value)} maxLength={12} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <Button type="submit" disabled={busy}>
                            {busy ? "Saving…" : state?.status === "none" || !state ? "Set offline PIN" : "Change offline PIN"}
                        </Button>
                        {state && state.status !== "none" && (
                            <Button type="button" variant="outline" disabled={busy} onClick={remove}>
                                Remove offline access
                            </Button>
                        )}
                    </div>
                </form>
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
                    // its offline PIN session (queued offline work is kept).
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
                await confirmServerSession(data).catch(() => undefined);
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

        setBusy(all ? "logout-all" : "logout");
        const result = await postJson(all ? "/api/auth/logout-all" : "/api/auth/logout");
        setBusy(null);

        if (!result.ok && result.status !== 401) {
            setNotice({ kind: "error", text: result.data.message || "Unable to sign out." });
            return;
        }

        // Offline work can no longer be queued for this account and its
        // offline PIN session is removed. Queued but unsynced items are kept
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

                    {!me.user.mustChangePassword && <OfflinePinSection me={me} />}

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
