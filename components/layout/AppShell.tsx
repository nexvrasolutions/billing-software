"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import { AppNav, type NavGroup } from "@/components/app-nav";
import { NotAllowed } from "@/components/not-allowed";
import { getOfflineAccessOverview, restoreOfflineSession } from "@/lib/offline/offlineAccess";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";

export type AuthMeResponse = {
    authenticated?: boolean;
    user?: {
        name?: string;
        roleName?: string;
        role?: { name?: string };
        businessName?: string;
        tenant?: { name?: string };
        permissions?: string[];
        mustChangePassword?: boolean;
        isOwner?: boolean;
    };
    tenant?: { name?: string };
    permissions?: string[];
};

export const NAV_GROUPS: (NavGroup & { permission?: string })[] = [
    {
        title: "Sell",
        links: [
            { href: "/dashboard", label: "Dashboard" },
            { href: "/pos", label: "New bill" },
            { href: "/sales", label: "Sales" },
        ],
    },
    {
        title: "Stock",
        links: [
            { href: "/catalog/products", label: "Products" },
            { href: "/catalog/lists", label: "Categories & units" },
            { href: "/inventory", label: "Inventory" },
            { href: "/inventory/opening", label: "Opening stock" },
            { href: "/purchases", label: "Purchases", icon: ShoppingBag },
            { href: "/suppliers", label: "Suppliers" },
            { href: "/catalog/import", label: "Import products" },
        ],
    },
    {
        title: "Money",
        links: [
            { href: "/customers", label: "Customers" },
            { href: "/reports", label: "Reports" },
        ],
    },
    {
        title: "Settings",
        links: [
            { href: "/settings", label: "Business settings" },
            { href: "/settings/branches", label: "Branches" },
            { href: "/settings/tills/flags", label: "Offline till flags" },
            { href: "/users", label: "Staff" },
        ],
    },
];

/**
 * Strict permission requirements for each sidebar navigation item.
 * Users must hold at least one of the listed permissions (or be the business owner)
 * for the link to be visible in the sidebar.
 */
export const NAV_PERMISSION_MAP: Record<string, string | string[]> = {
    "/dashboard": [], // Accessible to all authenticated users
    "/pos": "sales.create",
    "/sales": ["sales.read", "sales.create"],
    "/catalog/products": ["products.read", "products.create", "products.update"],
    "/catalog/lists": [
        "categories.read",
        "categories.create",
        "units.read",
        "units.create",
        "products.create",
        "products.update",
    ],
    "/inventory": ["stock.adjust", "products.update"],
    "/inventory/opening": "stock.adjust",
    "/purchases": ["purchases.create", "purchases.read"],
    "/suppliers": ["purchases.create", "purchases.read"],
    "/catalog/import": "products.create",
    "/customers": ["sales.create", "sales.read", "customers.read"],
    "/reports": ["reports.read", "sales.read"],
    "/settings": ["settings.read", "settings.update", "users.update"],
    "/settings/branches": ["branches.read", "settings.read", "users.update"],
    "/settings/tills/flags": ["settings.read", "branches.read", "users.update"],
    "/users": ["users.read", "users.create", "users.update"],
};

/**
 * Route protection rules for direct URL navigation.
 * Evaluated top-to-bottom: longer and exact prefixes take precedence.
 */
export const ROUTE_PERMISSION_RULES: {
    prefix: string;
    exact?: boolean;
    permissions: string[] | null;
}[] = [
    { prefix: "/dashboard", permissions: null },
    { prefix: "/account", permissions: null },
    { prefix: "/sync", permissions: null },
    { prefix: "/pos", permissions: ["sales.create"] },
    { prefix: "/sales", permissions: ["sales.read", "sales.create"] },
    { prefix: "/credit-notes", permissions: ["sales.read", "sales.create"] },
    { prefix: "/customers", permissions: ["sales.create", "sales.read", "customers.read"] },
    { prefix: "/catalog/products/new", exact: true, permissions: ["products.create"] },
    { prefix: "/catalog/import", exact: true, permissions: ["products.create"] },
    {
        prefix: "/catalog/lists",
        exact: true,
        permissions: [
            "categories.read",
            "categories.create",
            "units.read",
            "units.create",
            "products.create",
            "products.update",
        ],
    },
    {
        prefix: "/catalog/products",
        permissions: ["products.read", "products.create", "products.update", "products.delete"],
    },
    { prefix: "/inventory/opening", exact: true, permissions: ["stock.adjust"] },
    { prefix: "/inventory/adjust", exact: true, permissions: ["stock.adjust"] },
    { prefix: "/inventory", permissions: ["stock.adjust", "products.update"] },
    { prefix: "/purchases/new", exact: true, permissions: ["purchases.create"] },
    { prefix: "/purchases", permissions: ["purchases.create", "purchases.read"] },
    { prefix: "/suppliers", permissions: ["purchases.create", "purchases.read"] },
    { prefix: "/reports/audit", exact: true, permissions: ["auditLogs.read"] },
    { prefix: "/reports", permissions: ["reports.read", "sales.read"] },
    { prefix: "/settings/branches", exact: true, permissions: ["branches.read", "settings.read", "users.update"] },
    { prefix: "/settings/devices", exact: true, permissions: ["devices.read", "settings.read", "users.update"] },
    { prefix: "/settings/security", exact: true, permissions: ["settings.read", "users.update"] },
    { prefix: "/settings/staff", exact: true, permissions: ["users.read", "users.create", "users.update"] },
    { prefix: "/settings/tills", permissions: ["settings.read", "branches.read", "users.update"] },
    { prefix: "/settings", permissions: ["settings.read", "settings.update", "users.update"] },
    { prefix: "/users", permissions: ["users.read", "users.create", "users.update", "users.delete"] },
];

/**
 * Check whether a user with the given permissions is authorized to access a pathname.
 * The business owner is always authorized to manage all tenant modules.
 */
export function isRouteAuthorized(
    pathname: string,
    permissions: string[] | undefined | null,
    isOwner = false
): boolean {
    if (isOwner) return true;

    const normalizedPath = pathname.split("?")[0].replace(/\/+$/, "") || "/";

    // Sort rules so more specific prefixes match first
    const sortedRules = [...ROUTE_PERMISSION_RULES].sort((a, b) => b.prefix.length - a.prefix.length);

    for (const rule of sortedRules) {
        const matches = rule.exact
            ? normalizedPath === rule.prefix
            : normalizedPath === rule.prefix || normalizedPath.startsWith(`${rule.prefix}/`);

        if (matches) {
            if (rule.permissions === null || rule.permissions.length === 0) {
                return true;
            }
            if (!Array.isArray(permissions) || permissions.length === 0) {
                return false;
            }
            return rule.permissions.some((p) => permissions.includes(p));
        }
    }

    // Default to allowed for unmapped authenticated routes (e.g. /account, /dashboard)
    return true;
}

/**
 * Filter navigation groups so unauthorized links are omitted and parent menu groups
 * with no accessible child items are completely hidden.
 */
export function filterNavGroups(
    groups: NavGroup[],
    permissions: string[] | undefined | null,
    isOwner = false
): NavGroup[] {
    return groups
        .map((group) => ({
            title: group.title,
            links: group.links.filter((link) => {
                if (isOwner) return true;

                const required = NAV_PERMISSION_MAP[link.href];
                if (!required || (Array.isArray(required) && required.length === 0)) {
                    return true;
                }

                if (!Array.isArray(permissions) || permissions.length === 0) {
                    return false;
                }

                if (Array.isArray(required)) {
                    return required.some((req) => permissions.includes(req));
                }
                return permissions.includes(required);
            }),
        }))
        .filter((group) => group.links.length > 0);
}

export function AppShell({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const [auth, setAuth] = useState<AuthMeResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [offlineAvailable, setOfflineAvailable] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function loadShellContext() {
            // 1. Immediately populate from local offline session if available so the sidebar
            // renders on the first paint without waiting for network timeout or requiring extra clicks.
            const restored = await restoreOfflineSession().catch(() => null);
            const overviewState = restored?.overview?.state;
            if (!cancelled && overviewState && overviewState.status === "available") {
                const displayName = overviewState.displayName || "Staff";
                const permissions = Array.isArray(overviewState.permissions)
                    ? overviewState.permissions
                    : [];
                setAuth({
                    authenticated: true,
                    user: {
                        roleName: displayName,
                        permissions,
                    },
                    permissions,
                    tenant: { name: "Billing" },
                });
                if (restored.overview?.allowed) {
                    setOfflineAvailable(true);
                }
                setLoading(false);
            }

            // When offline, local restoration is sufficient
            if (typeof navigator !== "undefined" && !navigator.onLine) {
                if (!cancelled) setLoading(false);
                return;
            }

            // 2. When online, verify session with the server and refresh permissions
            try {
                const response = await fetch("/api/auth/me", {
                    method: "GET",
                    credentials: "same-origin",
                    cache: "no-store",
                    signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
                });

                const data: AuthMeResponse | null = await response
                    .json()
                    .catch(() => null);

                if (cancelled) return;

                if (response.status === 401 || response.status === 403) {
                    if (!cancelled) setLoading(false);
                    router.replace("/login");
                    return;
                }

                if (!response.ok || !data?.authenticated) {
                    // Server returned error (500, 502, 503)
                    if (!cancelled) setLoading(false);
                    return;
                }

                if (data.user?.mustChangePassword) {
                    router.replace("/account");
                    return;
                }

                setAuth(data);
                setLoading(false);

                // Read-only display information. Do not renew or alter the session here.
                const overview = await getOfflineAccessOverview().catch(() => null);
                if (!cancelled && overview?.state.status === "available" && overview.allowed) {
                    setOfflineAvailable(true);
                }
            } catch {
                // Server unreachable / network timeout
                if (!cancelled) setLoading(false);
            }
        }

        void loadShellContext();

        return () => {
            cancelled = true;
        };
    }, [pathname, router]);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
                <p role="status">Loading application...</p>
            </div>
        );
    }

    const user = auth?.user;
    const roleName = user?.roleName ?? user?.role?.name ?? user?.name ?? "User";
    const businessName =
        user?.businessName ?? user?.tenant?.name ?? auth?.tenant?.name ?? "Billing";
    const isOwner = Boolean(user?.isOwner);
    const permissions = auth?.permissions ?? user?.permissions ?? [];

    const groups = filterNavGroups(NAV_GROUPS, permissions, isOwner);
    const isAllowed = isRouteAuthorized(pathname, permissions, isOwner);

    return (
        <div className="flex min-h-screen flex-col bg-muted/40 lg:flex-row">
            <AppNav
                groups={groups}
                roleName={roleName}
                businessName={businessName}
                footer={
                    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                        {offlineAvailable && <span>Offline access available</span>}
                        <span>Signed in as {roleName}</span>
                    </div>
                }
            />
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8 print:max-w-none print:p-0">
                    {isAllowed ? children : <NotAllowed />}
                </div>
            </div>
        </div>
    );
}