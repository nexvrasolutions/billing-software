"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { confirmServerSession, endOfflineAccess, isSessionRejected } from "@/lib/offline/sessionIdentity";

/*
 * User Management screen.
 *
 * Buttons are hidden or disabled using hints returned by the API, but this
 * is only for convenience: every action is authorized again on the server.
 */

type UserStatus = "active" | "inactive";

interface UserRow {
    id: string;
    name: string;
    email: string;
    roleId: string | null;
    roleName: string | null;
    status: UserStatus;
    isOwner: boolean;
    canEdit?: boolean;
    createdAt: string;
}

interface RoleOption {
    id: string;
    name: string;
    description: string | null;
    isAdministrator: boolean;
    assignable: boolean;
}

interface Capabilities {
    currentUserId: string;
    isOwner: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canChangeStatus: boolean;
    ownerDesignated: boolean;
}

interface Pagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

type FieldErrors = Record<string, string[] | undefined>;

interface ApiResult {
    ok: boolean;
    status: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
}

async function api(path: string, init?: RequestInit): Promise<ApiResult> {
    try {
        const response = await fetch(path, {
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            ...init,
        });
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, data };
    } catch {
        return {
            ok: false,
            status: 0,
            data: { message: "Unable to connect to the server." },
        };
    }
}

type FormState =
    | { mode: "create" }
    | { mode: "edit"; user: UserRow }
    | null;

const PAGE_SIZE = 10;

export default function UsersPage() {
    const [users, setUsers] = useState<UserRow[]>([]);
    const [pagination, setPagination] = useState<Pagination | null>(null);
    const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
    const [roles, setRoles] = useState<RoleOption[]>([]);

    const [page, setPage] = useState(1);
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<"" | UserStatus>("");

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [authRequired, setAuthRequired] = useState(false);
    const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
    const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    const [form, setForm] = useState<FormState>(null);

    const reload = useCallback(() => setReloadKey((key) => key + 1), []);

    useEffect(() => {
        let cancelled = false;

        const params = new URLSearchParams({
            page: String(page),
            limit: String(PAGE_SIZE),
        });

        if (search) params.set("search", search);
        if (statusFilter) params.set("status", statusFilter);

        Promise.all([
            api(`/api/users?${params}`),
            api("/api/users/roles"),
        ]).then(([usersResult, rolesResult]) => {
            if (cancelled) return;

            setLoading(false);

            if (usersResult.status === 401) {
                setAuthRequired(true);
                // Distinguish "signed out" from "must change temporary password".
                api("/api/auth/me").then((meResult) => {
                    if (!cancelled && meResult.ok && meResult.data.user?.mustChangePassword) {
                        setPasswordChangeRequired(true);
                        // Temporary password: remove that account's offline
                        // session (queued offline work is kept).
                        void confirmServerSession(meResult.data).catch(() => undefined);
                    }
                    // Session definitively rejected: forget the remembered
                    // identity and its offline session (queued offline
                    // work is kept).
                    if (isSessionRejected(meResult.status)) {
                        void endOfflineAccess().catch(() => undefined);
                    }
                });
                return;
            }

            if (!usersResult.ok) {
                setLoadError(usersResult.data.message || "Unable to load users.");
                return;
            }

            setLoadError("");
            setUsers(usersResult.data.users);
            setPagination(usersResult.data.pagination);
            setCapabilities(usersResult.data.capabilities);
            setRoles(rolesResult.ok ? rolesResult.data.roles : []);
        });

        return () => {
            cancelled = true;
        };
    }, [page, search, statusFilter, reloadKey]);

    function applySearch(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setLoading(true);
        setPage(1);
        setSearch(searchInput.trim());
    }

    function changeStatusFilter(value: "" | UserStatus) {
        setLoading(true);
        setPage(1);
        setStatusFilter(value);
    }

    function goToPage(nextPage: number) {
        setLoading(true);
        setPage(nextPage);
    }

    async function toggleStatus(user: UserRow) {
        const nextStatus: UserStatus = user.status === "active" ? "inactive" : "active";

        if (
            nextStatus === "inactive" &&
            !window.confirm(`Deactivate ${user.name}? They will lose access immediately.`)
        ) {
            return;
        }

        setBusyUserId(user.id);
        setNotice(null);

        const result = await api(`/api/users/${user.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: nextStatus }),
        });

        setBusyUserId(null);

        if (!result.ok) {
            setNotice({ kind: "error", text: result.data.message || "Unable to update user." });
            return;
        }

        setNotice({
            kind: "success",
            text: `${user.name} was ${nextStatus === "active" ? "activated" : "deactivated"}.`,
        });
        reload();
    }

    if (authRequired) {
        return (
            <main className="mx-auto w-full max-w-5xl px-4 py-10">
                <h1 className="text-2xl font-semibold">User Management</h1>
                {passwordChangeRequired ? (
                    <p className="mt-4" role="alert">
                        You must change your temporary password before using this page.{" "}
                        <Link className="underline" href="/account">
                            Change password
                        </Link>
                    </p>
                ) : (
                    <p className="mt-4">
                        Your session has expired or you are not logged in.{" "}
                        <Link className="underline" href="/login">
                            Log in
                        </Link>
                    </p>
                )}
            </main>
        );
    }

    return (
        <main className="mx-auto w-full max-w-5xl px-4 py-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold">User Management</h1>
                <div className="flex items-center gap-3">
                    <Link className="text-sm underline" href="/account">My account</Link>
                    {capabilities?.canCreate && (
                        <Button onClick={() => { setNotice(null); setForm({ mode: "create" }); }}>
                            Add user
                        </Button>
                    )}
                </div>
            </div>

            {capabilities && !capabilities.ownerDesignated && (
                <p className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                    No business owner has been designated yet, so administrator roles cannot
                    be granted from this screen. Ask your system administrator to run the
                    owner designation step.
                </p>
            )}

            {notice && (
                <p
                    role={notice.kind === "error" ? "alert" : "status"}
                    className={`mt-4 rounded-lg px-3 py-2 text-sm ${notice.kind === "error"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted"
                        }`}
                >
                    {notice.text}
                </p>
            )}

            {form && (
                <UserForm
                    key={form.mode === "edit" ? form.user.id : "create"}
                    form={form}
                    roles={roles}
                    isOwner={capabilities?.isOwner ?? false}
                    isSelf={form.mode === "edit" && form.user.id === capabilities?.currentUserId}
                    onCancel={() => setForm(null)}
                    onSaved={(message) => {
                        setForm(null);
                        setNotice({ kind: "success", text: message });
                        reload();
                    }}
                />
            )}

            <div className="mt-6 flex flex-wrap items-end gap-3">
                <form onSubmit={applySearch} className="flex gap-2">
                    <input
                        type="search"
                        aria-label="Search by name or email"
                        placeholder="Search name or email"
                        value={searchInput}
                        maxLength={100}
                        onChange={(event) => setSearchInput(event.target.value)}
                        className="h-8 w-64 rounded-lg border border-border bg-background px-2 text-sm"
                    />
                    <Button type="submit" variant="outline">Search</Button>
                </form>

                <label className="flex items-center gap-2 text-sm">
                    Status
                    <select
                        value={statusFilter}
                        onChange={(event) => changeStatusFilter(event.target.value as "" | UserStatus)}
                        className="h-8 rounded-lg border border-border bg-background px-2"
                    >
                        <option value="">All</option>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                    </select>
                </label>
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                    <thead className="bg-muted">
                        <tr>
                            <th className="px-3 py-2 font-medium">Name</th>
                            <th className="px-3 py-2 font-medium">Email</th>
                            <th className="px-3 py-2 font-medium">Role</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2 font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr>
                                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                                    Loading users…
                                </td>
                            </tr>
                        )}

                        {!loading && loadError && (
                            <tr>
                                <td colSpan={5} className="px-3 py-6 text-center text-destructive" role="alert">
                                    {loadError}{" "}
                                    <Button variant="link" onClick={() => { setLoading(true); reload(); }}>
                                        Try again
                                    </Button>
                                </td>
                            </tr>
                        )}

                        {!loading && !loadError && users.length === 0 && (
                            <tr>
                                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                                    {search || statusFilter ? "No users match your filters." : "No users yet."}
                                </td>
                            </tr>
                        )}

                        {!loading && !loadError && users.map((user) => {
                            const isSelf = user.id === capabilities?.currentUserId;
                            const canToggle =
                                capabilities?.canChangeStatus && user.canEdit && !isSelf && !user.isOwner;

                            return (
                                <tr key={user.id} className="border-t border-border">
                                    <td className="px-3 py-2">
                                        {user.name}
                                        {user.isOwner && <span className="ml-2 text-xs text-muted-foreground">(Owner)</span>}
                                        {isSelf && <span className="ml-2 text-xs text-muted-foreground">(You)</span>}
                                    </td>
                                    <td className="px-3 py-2">{user.email}</td>
                                    <td className="px-3 py-2">{user.roleName ?? "No role"}</td>
                                    <td className="px-3 py-2">
                                        <span
                                            className={`rounded px-2 py-0.5 text-xs ${user.status === "active"
                                                ? "bg-muted"
                                                : "bg-destructive/10 text-destructive"
                                                }`}
                                        >
                                            {user.status === "active" ? "Active" : "Inactive"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex gap-2">
                                            {user.canEdit && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => { setNotice(null); setForm({ mode: "edit", user }); }}
                                                >
                                                    Edit
                                                </Button>
                                            )}
                                            {canToggle && (
                                                <Button
                                                    size="sm"
                                                    variant={user.status === "active" ? "destructive" : "secondary"}
                                                    disabled={busyUserId === user.id}
                                                    onClick={() => toggleStatus(user)}
                                                >
                                                    {busyUserId === user.id
                                                        ? "Saving…"
                                                        : user.status === "active" ? "Deactivate" : "Activate"}
                                                </Button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {pagination && pagination.totalPages > 1 && (
                <div className="mt-4 flex items-center gap-3 text-sm">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={loading || pagination.page <= 1}
                        onClick={() => goToPage(pagination.page - 1)}
                    >
                        Previous
                    </Button>
                    <span>
                        Page {pagination.page} of {pagination.totalPages} ({pagination.total} users)
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={loading || pagination.page >= pagination.totalPages}
                        onClick={() => goToPage(pagination.page + 1)}
                    >
                        Next
                    </Button>
                </div>
            )}
        </main>
    );
}

function UserForm({
    form,
    roles,
    isOwner,
    isSelf,
    onCancel,
    onSaved,
}: {
    form: NonNullable<FormState>;
    roles: RoleOption[];
    isOwner: boolean;
    isSelf: boolean;
    onCancel: () => void;
    onSaved: (message: string) => void;
}) {
    const editing = form.mode === "edit" ? form.user : null;

    const [name, setName] = useState(editing?.name ?? "");
    const [email, setEmail] = useState(editing?.email ?? "");
    const [password, setPassword] = useState("");
    const [roleId, setRoleId] = useState(editing?.roleId ?? "");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

    // Only offer roles the server says this user may assign. The current
    // role of an edited user is kept visible even if it is not assignable.
    const roleOptions = roles.filter(
        (role) => role.assignable || role.id === editing?.roleId
    );
    const hiddenAdminRoles = !isOwner && roles.some((role) => role.isAdministrator);
    const roleLocked = Boolean(editing?.isOwner);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setSubmitting(true);
        setError("");
        setFieldErrors({});

        let body: Record<string, unknown>;

        if (editing) {
            body = {};
            if (name.trim() !== editing.name) body.name = name;
            if (email.trim().toLowerCase() !== editing.email) body.email = email;
            if (!roleLocked && roleId && roleId !== editing.roleId) body.roleId = roleId;

            if (Object.keys(body).length === 0) {
                setSubmitting(false);
                setError("Nothing has changed.");
                return;
            }
        } else {
            body = { name, email, password, roleId };
        }

        const result = await api(editing ? `/api/users/${editing.id}` : "/api/users", {
            method: editing ? "PATCH" : "POST",
            body: JSON.stringify(body),
        });

        setSubmitting(false);

        if (!result.ok) {
            setError(result.data.message || "Unable to save user.");
            setFieldErrors(result.data.errors?.fieldErrors ?? {});
            return;
        }

        onSaved(editing ? `${name.trim()} was updated.` : `${name.trim()} was created.`);
    }

    const fieldError = (field: string) =>
        fieldErrors[field]?.length ? (
            <span className="text-xs text-destructive">{fieldErrors[field]?.join(" ")}</span>
        ) : null;

    const inputClass = "h-8 rounded-lg border border-border bg-background px-2 text-sm";

    return (
        <>
        <form
            onSubmit={submit}
            className="mt-6 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2"
            noValidate
        >
            <h2 className="text-lg font-medium sm:col-span-2">
                {editing ? `Edit ${editing.name}` : "Add user"}
            </h2>

            <label className="flex flex-col gap-1 text-sm">
                Name
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
                {fieldError("name")}
            </label>

            <label className="flex flex-col gap-1 text-sm">
                Email
                <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
                {fieldError("email")}
            </label>

            {!editing && (
                <label className="flex flex-col gap-1 text-sm">
                    Password (at least 12 characters)
                    <input
                        className={inputClass}
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={12}
                        maxLength={128}
                    />
                    {fieldError("password")}
                </label>
            )}

            <label className="flex flex-col gap-1 text-sm">
                Role
                <select
                    className={inputClass}
                    value={roleId}
                    onChange={(e) => setRoleId(e.target.value)}
                    disabled={roleLocked}
                    required
                >
                    <option value="" disabled>Select a role</option>
                    {roleOptions.map((role) => (
                        <option key={role.id} value={role.id} disabled={!role.assignable}>
                            {role.name}
                            {role.isAdministrator ? " (Administrator)" : ""}
                            {!role.assignable ? " — current" : ""}
                        </option>
                    ))}
                </select>
                {roleLocked && (
                    <span className="text-xs text-muted-foreground">The business owner&apos;s role cannot be changed.</span>
                )}
                {hiddenAdminRoles && !roleLocked && (
                    <span className="text-xs text-muted-foreground">
                        Only the business owner can assign administrator roles.
                    </span>
                )}
                {fieldError("roleId")}
            </label>

            {error && (
                <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>
            )}

            <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={submitting}>
                    {submitting ? "Saving…" : editing ? "Save changes" : "Create user"}
                </Button>
                <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
                    Cancel
                </Button>
            </div>
        </form>

        {editing && !editing.isOwner && !isSelf && editing.canEdit && (
            <ResetPasswordForm user={editing} />
        )}
        </>
    );
}

// Admin-initiated password reset. The admin types the temporary password;
// the server enforces who may reset whom and never returns passwords.
function ResetPasswordForm({ user }: { user: UserRow }) {
    const [newPassword, setNewPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!window.confirm(`Reset the password of ${user.name}? They will be signed out everywhere.`)) {
            return;
        }

        setSubmitting(true);
        setNotice(null);

        const result = await api(`/api/users/${user.id}/password`, {
            method: "POST",
            body: JSON.stringify({ newPassword }),
        });

        setSubmitting(false);

        if (!result.ok) {
            const fieldText = result.data.errors?.fieldErrors?.newPassword?.join(" ");
            setNotice({ kind: "error", text: fieldText || result.data.message || "Unable to reset password." });
            return;
        }

        setNewPassword("");
        setNotice({ kind: "success", text: result.data.message });
    }

    return (
        <form onSubmit={submit} className="mt-3 grid gap-3 rounded-lg border border-border p-4" noValidate>
            <h2 className="text-lg font-medium">Reset password for {user.name}</h2>
            <label className="flex flex-col gap-1 text-sm">
                New temporary password (at least 12 characters)
                <input
                    className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={12}
                    maxLength={128}
                />
            </label>
            <p className="text-xs text-muted-foreground">
                Share it with the user privately and ask them to change it from &quot;My account&quot;.
            </p>
            {notice && (
                <p role={notice.kind === "error" ? "alert" : "status"} className={`text-sm ${notice.kind === "error" ? "text-destructive" : ""}`}>
                    {notice.text}
                </p>
            )}
            <div>
                <Button type="submit" variant="outline" disabled={submitting}>
                    {submitting ? "Resetting…" : "Reset password"}
                </Button>
            </div>
        </form>
    );
}
