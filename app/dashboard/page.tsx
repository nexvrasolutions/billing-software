
"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    confirmServerSession,
    endOfflineAccess,
    isSessionRejected,
} from "@/lib/offline/sessionIdentity";
import {
    getOfflineAccessOverview,
    lockOfflineSession,
    settlePendingServerLogout,
    signOutOffline,
    unlockRememberedOfflineSession,
    type OfflineAccessOverview,
} from "@/lib/offline/offlineAccess";

type SessionCheck = "verified" | "unreachable" | "login" | "account";

// Ask the server whether the current session is valid (the same check the
// login and account pages use). Returns where the user should be.
async function checkSession(): Promise<SessionCheck> {
    try {
        // An offline sign-out must end the old server session first.
        const pending = await settlePendingServerLogout();
        if (pending === "unreachable") return "unreachable";
        if (pending === "done") return "login";

        const response = await fetch("/api/auth/me", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
        });
        const data = await response.json().catch(() => null);

        // The server definitively rejected the session (signed out,
        // expired, revoked or inactive): the remembered identity and its
        // offline PIN session must not outlive it. Queued offline work is kept.
        if (isSessionRejected(response.status)) {
            await endOfflineAccess().catch(() => undefined);
            return "login";
        }

        // A server error (5xx) says nothing about the session: report that it
        // could not be verified instead of treating the user as signed out.
        if (!response.ok) {
            return "unreachable";
        }

        if (!data?.authenticated) {
            return "login";
        }

        // Successful check: renew this account's offline session (or remove
        // it while a temporary password is pending).
        await confirmServerSession(data).catch(() => undefined);

        // A temporary password must be changed before anything else.
        return data?.user?.mustChangePassword ? "account" : "verified";
    } catch {
        return "unreachable";
    }
}

// Keep the pages needed offline in the service worker's page cache (it
// caches same-origin pages network-first). Best effort.
function warmOfflinePages() {
    for (const path of ["/dashboard", "/offline-test"]) {
        void fetch(path, { credentials: "same-origin" }).catch(() => undefined);
    }
}

function formatTime(iso: string) {
    return new Date(iso).toLocaleString();
}

function itemsText(count: number) {
    return `${count} unsynced item${count === 1 ? "" : "s"}`;
}

/** Offline session controls shown when the server cannot be reached. */
function OfflinePanel() {
    const [overview, setOverview] = useState<OfflineAccessOverview | null>(null);
    const [pin, setPin] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(() => {
        void getOfflineAccessOverview().then(setOverview).catch(() => undefined);
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function unlock(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        const unsynced = overview?.unsyncedItems ?? 0;
        const result = await unlockRememberedOfflineSession(pin).catch(() => null);
        setPin("");
        setBusy(false);

        if (!result) {
            setMessage("Unable to unlock the offline session.");
        } else if (result.ok) {
            setMessage("");
        } else if (result.reason === "wrong-pin") {
            setMessage(`Incorrect PIN. ${result.remainingAttempts} attempt(s) left before the offline session is removed.`);
        } else if (result.reason === "locked-out") {
            setMessage(
                `Too many incorrect PINs. The offline session was removed from this device. ` +
                `Your ${itemsText(unsynced)} are safe and will sync after you sign in online.`
            );
        } else {
            setMessage("The offline session cannot be unlocked. Sign in online to continue.");
        }
        refresh();
    }

    function lock() {
        lockOfflineSession();
        setMessage("Offline session locked. Enter your PIN to continue.");
        refresh();
    }

    async function signOut() {
        if (!window.confirm("Sign out on this device? You will need to sign in online again.")) return;
        const unsynced = overview?.unsyncedItems ?? 0;
        await signOutOffline().catch(() => undefined);
        setMessage(
            `Signed out on this device. The server session has NOT been ended yet; it will be ended ` +
            `automatically when this device reconnects. Your ${itemsText(unsynced)} are kept.`
        );
        refresh();
    }

    if (!overview) return null;

    const { identity, state, unlocked, unsyncedItems, pendingServerLogout } = overview;
    const safeNote = `Your ${itemsText(unsyncedItems)} are safe on this device and will sync after you sign in online.`;

    return (
        <section aria-label="Offline session" className="mt-6 space-y-3 rounded-md border border-gray-300 bg-white p-4">
            <h2 className="text-base font-semibold text-gray-900">Offline session</h2>

            {message && <p role="status">{message}</p>}

            {pendingServerLogout && (
                <p>
                    You signed out on this device while offline. Your server session will be ended
                    when this device reconnects.
                </p>
            )}

            {!identity ? (
                <p>Offline access is not available. Sign in online on this device first.</p>
            ) : state.status === "none" ? (
                <p>
                    Offline access has not been set up for this account on this device. Set up an
                    offline PIN in My account while online. {unsyncedItems > 0 && safeNote}
                </p>
            ) : state.status === "invalid" ? (
                <p>The offline session on this device was invalid and has been removed. {safeNote}</p>
            ) : state.status === "clock-rollback" ? (
                <p>The device clock appears to have moved backwards, so offline access is blocked. {safeNote}</p>
            ) : state.status === "expired" ? (
                <p>
                    Your offline session expired at {formatTime(state.expiresAt)}. New offline work is
                    blocked. {safeNote}
                </p>
            ) : unlocked ? (
                <div className="space-y-3">
                    <p>
                        Offline mode{state.displayName ? ` for ${state.displayName}` : ""}: available
                        until {formatTime(state.expiresAt)}. {itemsText(unsyncedItems)} waiting to sync.
                    </p>
                    <p className="text-xs text-gray-600">
                        Work recorded offline is checked again by the server when it syncs. The PIN is
                        not a server sign-in and is not proof of payment.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Link href="/offline-test" className="rounded-md border border-gray-300 px-4 py-2">
                            Record offline work
                        </Link>
                        <button type="button" onClick={lock} className="rounded-md border border-gray-300 px-4 py-2">
                            Lock
                        </button>
                        <button type="button" onClick={signOut} className="rounded-md border border-gray-300 px-4 py-2">
                            Sign out offline
                        </button>
                    </div>
                </div>
            ) : (
                <form onSubmit={unlock} className="space-y-2">
                    <p>
                        Offline session available until {formatTime(state.expiresAt)}.{" "}
                        {itemsText(unsyncedItems)} waiting to sync.
                    </p>
                    <label className="flex flex-col gap-1">
                        Offline PIN
                        <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            value={pin}
                            onChange={(event) => setPin(event.target.value)}
                            className="w-48 rounded-md border border-gray-300 px-3 py-2"
                        />
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busy || !pin} className="rounded-md border border-gray-300 px-4 py-2 disabled:opacity-60">
                            Unlock
                        </button>
                        <button type="button" onClick={signOut} className="rounded-md border border-gray-300 px-4 py-2">
                            Sign out offline
                        </button>
                    </div>
                </form>
            )}
        </section>
    );
}

/** Offline access status while the session is verified online. */
function OnlineOfflineStatus() {
    const [overview, setOverview] = useState<OfflineAccessOverview | null>(null);

    useEffect(() => {
        void getOfflineAccessOverview().then(setOverview).catch(() => undefined);
        warmOfflinePages();
    }, []);

    if (!overview?.identity) return null;
    const { state, unsyncedItems } = overview;

    return (
        <p className="mx-auto mt-6 max-w-7xl text-sm text-gray-600" aria-label="Offline access status">
            {state.status === "available"
                ? `Offline access ready until ${formatTime(state.expiresAt)}.`
                : "Offline access is not set up on this device (set an offline PIN in My account)."}{" "}
            {itemsText(unsyncedItems)} waiting to sync.
        </p>
    );
}

export default function DashboardPage() {
    const router = useRouter();

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // The dashboard is shown only after the server confirms the session
    // (same check as /login and /account: GET /api/auth/me). All data APIs
    // still enforce authentication and permissions on the server.
    const [session, setSession] = useState<"checking" | "verified" | "unreachable">("checking");

    const applySessionCheck = useCallback((result: SessionCheck) => {
        if (result === "login") {
            router.replace("/login");
        } else if (result === "account") {
            router.replace("/account");
        } else {
            setSession(result);
        }
    }, [router]);

    useEffect(() => {
        let cancelled = false;

        checkSession().then((result) => {
            if (!cancelled) applySessionCheck(result);
        });

        return () => {
            cancelled = true;
        };
    }, [applySessionCheck]);

    async function handleLogout() {
        setLoading(true);
        setError("");

        try {
            const response = await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
            });

            const data = await response.json().catch(() => null);

            if (!response.ok || !data?.success) {
                setError(
                    data?.message ||
                    "Unable to log out safely. Please try again."
                );
                return;
            }

            // Offline work can no longer be queued for this account and its
            // offline PIN session is removed. Its unsynced items are kept and
            // sync when it signs in again.
            await endOfflineAccess().catch(() => undefined);

            router.replace("/login");
            router.refresh();
        } catch {
            setError(
                "Unable to contact the server. Please try again."
            );
        } finally {
            setLoading(false);
        }
    }

    // Nothing of the dashboard is shown until the session is confirmed.
    if (session !== "verified") {
        return (
            <main className="min-h-screen bg-gray-50 p-6">
                <div className="mx-auto max-w-7xl text-sm text-gray-600">
                    {session === "checking" ? (
                        <p role="status">Checking your session...</p>
                    ) : (
                        <>
                            <div role="alert" className="space-y-3">
                                <p>Unable to contact the server to verify your session.</p>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSession("checking");
                                        void checkSession().then(applySessionCheck);
                                    }}
                                    className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
                                >
                                    Try again
                                </button>
                            </div>
                            <OfflinePanel />
                        </>
                    )}
                </div>
            </main>
        );
    }

    const navLinkClass =
        "rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100";

    return (
        <main className="min-h-screen bg-gray-50 p-6">
            <header className="mx-auto flex max-w-7xl items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-gray-900">
                        Dashboard
                    </h1>

                    <p className="mt-2 text-sm text-gray-600">
                        Welcome to your billing and inventory system.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {/* Links only; /users and /account enforce their own
                        access rules through the server APIs. */}
                    <nav aria-label="Main" className="flex flex-wrap gap-2">
                        <Link href="/users" className={navLinkClass}>
                            User Management
                        </Link>
                        <Link href="/account" className={navLinkClass}>
                            My account
                        </Link>
                    </nav>

                    <button
                        type="button"
                        onClick={handleLogout}
                        disabled={loading}
                        className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading ? "Logging out..." : "Logout"}
                    </button>
                </div>
            </header>

            <OnlineOfflineStatus />

            {error && (
                <div
                    role="alert"
                    className="mx-auto mt-6 max-w-7xl rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                >
                    {error}
                </div>
            )}
        </main>
    );
}
