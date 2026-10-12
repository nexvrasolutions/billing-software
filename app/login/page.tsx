
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
    confirmServerSession,
    forgetSessionIdentity,
    identityFromMe,
    rememberSessionIdentity,
} from "@/lib/offline/sessionIdentity";
import {
    clearPendingServerLogout,
    settlePendingServerLogout,
} from "@/lib/offline/offlineAccess";

export default function LoginPage() {
    const router = useRouter();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [deviceId, setDeviceId] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        setError("");
        setLoading(true);

        try {
            // Step 0: an earlier offline sign-out must end the old server
            // session (with its cookie) before a new sign-in replaces it.
            await settlePendingServerLogout().catch(() => "unreachable" as const);

            // Step 1: Authenticate using email, password, and registered device ID.
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "same-origin",
                body: JSON.stringify({
                    email: email.trim(),
                    password,
                    deviceId: deviceId.trim(),
                }),
            });

            const data = await response.json().catch(() => null);

            // The server answered this sign-in attempt, so it ends the previous
            // account's offline identity: a failed or different login can never
            // queue work under it. Without an answer (offline, network error)
            // or with a server error (5xx), the identity is kept.
            if (response.status < 500) {
                await forgetSessionIdentity().catch(() => undefined);
            }

            if (!response.ok || !data?.success) {
                setError(
                    data?.message ||
                    "Unable to sign in. Check your credentials and registered device ID."
                );
                return;
            }

            // Step 2: Verify the authenticated session with the server.
            const meResponse = await fetch("/api/auth/me", {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
            });

            const meData = await meResponse.json().catch(() => null);

            if (!meResponse.ok || !meData?.authenticated) {
                setError(
                    meData?.message ||
                    "Login could not be verified. Please try again."
                );
                return;
            }

            // The new session cookie replaced the old one: no earlier offline
            // sign-out is left to complete from this device.
            await clearPendingServerLogout().catch(() => undefined);

            // Step 2b: Record the server-confirmed identity (tenant, user,
            // device) so offline work is attributed to this account only.
            // Not for a temporary password: no offline work may be queued
            // until it has been changed online, and that account's offline
            // PIN session is removed. Otherwise an existing offline PIN
            // session of this same account is renewed for 24 hours.
            const identity = identityFromMe(meData);

            if (meData?.user?.mustChangePassword !== true && identity) {
                // If this fails, no identity is remembered (safe default):
                // offline queueing then requires an online check first.
                await rememberSessionIdentity(identity).catch(() => undefined);
            }

            await confirmServerSession(meData).catch(() => undefined);

            // Step 3: Preserve the temporary-password workflow.
            const user = meData?.user ?? meData?.data?.user ?? meData;

            if (user?.mustChangePassword) {
                router.replace("/account");
                return;
            }

            // Step 4: Navigate after successful server verification.
            router.replace("/dashboard");
            router.refresh();
        } catch {
            setError(
                "Unable to connect to the server. Please check your connection and try again."
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="flex min-h-screen items-center justify-center bg-white px-4">
            <section className="w-full max-w-sm">
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    Sign in
                </h1>

                <p className="mt-2 text-sm text-gray-600">
                    Enter your account credentials to continue.
                </p>

                <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                    <div>
                        <label
                            htmlFor="email"
                            className="mb-1.5 block text-sm font-medium text-gray-700"
                        >
                            Email
                        </label>

                        <input
                            id="email"
                            name="email"
                            type="email"
                            autoComplete="username"
                            required
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                            placeholder="Enter your mail id"
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="password"
                            className="mb-1.5 block text-sm font-medium text-gray-700"
                        >
                            Password
                        </label>

                        <input
                            id="password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            required
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                            placeholder="Enter your password"
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="deviceId"
                            className="mb-1.5 block text-sm font-medium text-gray-700"
                        >
                            Device ID
                        </label>

                        <input
                            id="deviceId"
                            name="deviceId"
                            type="text"
                            autoComplete="off"
                            required
                            value={deviceId}
                            onChange={(event) => setDeviceId(event.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                            placeholder="Enter your registered Device ID"
                        />
                    </div>

                    {error && (
                        <p role="alert" className="text-sm text-red-600">
                            {error}
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {loading ? "Signing in..." : "Sign in"}
                    </button>
                </form>
            </section>
        </main>
    );
}
