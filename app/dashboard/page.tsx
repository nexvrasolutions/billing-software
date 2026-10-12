
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DashboardPage() {
    const router = useRouter();

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

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

                <button
                    type="button"
                    onClick={handleLogout}
                    disabled={loading}
                    className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {loading ? "Logging out..." : "Logout"}
                </button>
            </header>

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
