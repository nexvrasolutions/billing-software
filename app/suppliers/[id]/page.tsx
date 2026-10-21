"use client";

import { use, useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { parseSupplierValidationErrors, getSupplierDisplayBadge } from "@/lib/validations/supplier";
import { restoreOfflineSession } from "@/lib/offline/offlineAccess";
import {
  makeCachedSupplierId,
  savePendingOfflineSupplierUpdate,
  isTemporarySupplierCode,
  ensurePendingSuppliersQueued,
} from "@/lib/offline/supplierCache";
import { offlineDB } from "@/lib/offline/db";
import { SESSION_CHECK_TIMEOUT_MS } from "@/lib/offline/sessionIdentity";
import { syncPendingOperations } from "@/lib/offline/SyncManager";

interface SupplierDetail {
  _id: string;
  supplierCode?: string;
  name: string;
  contact?: {
    contactPerson?: string;
    phone?: string;
    email?: string;
  };
  address?: {
    line1?: string;
    state?: string;
  };
  tax?: {
    gstin?: string;
    taxRegistrationType?: string;
  };
  paymentTerms?: {
    type?: string;
    creditDays?: number;
  };
  creditLimit?: number;
  status?: "active" | "inactive" | "blocked";
  isDeleted?: boolean;
  syncStatus?: "PENDING" | "SYNCED" | "NEEDS_ATTENTION";
  errorMessage?: string;
}

interface SupplierPurchase {
  _id: string;
  purchaseNo?: string;
  supplierInvoiceNo?: string;
  purchaseDate?: string;
  grandTotal?: number;
  paidAmount?: number;
  dueAmount?: number;
  status?: string;
}

type LifecycleActionType = "deactivate" | "reactivate" | "block" | "unblock" | "delete";

interface PendingLifecycleModal {
  action: LifecycleActionType;
  title: string;
}

export default function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [supplier, setSupplier] = useState<SupplierDetail | null>(null);
  const [purchases, setPurchases] = useState<SupplierPurchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  // Edit state
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [state, setState] = useState("");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  // Lifecycle action state
  const [pendingModal, setPendingModal] = useState<PendingLifecycleModal | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
  const [isPendingLifecycle, setIsPendingLifecycle] = useState(false);

  const isSyncingRef = useRef(false);

  const clearFieldError = (fieldName: string) => {
    setFieldErrors((prev) => {
      if (!prev[fieldName]) return prev;
      const next = { ...prev };
      delete next[fieldName];
      return next;
    });
  };

  const resetFormToSupplier = (s?: SupplierDetail | null) => {
    const target = s !== undefined ? s : supplier;
    if (target) {
      setName(target.name || "");
      setContactPerson(target.contact?.contactPerson || "");
      setPhone(target.contact?.phone || "");
      setEmail(target.contact?.email || "");
      setGstin(target.tax?.gstin || "");
      setAddress(target.address?.line1 || "");
      setState(target.address?.state || "");
    }
    setFieldErrors({});
    setUpdateError(null);
  };

  const triggerSync = useCallback(async () => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      const restored = await restoreOfflineSession().catch(() => null);
      if (restored?.ok && restored.identity?.tenantId) {
        await ensurePendingSuppliersQueued(restored.identity.tenantId).catch(() => 0);
      }
      const syncResult = await syncPendingOperations().catch(() => undefined);
      if (syncResult?.results && syncResult.results.some((r) => r.status === "SYNCED")) {
        void loadSupplier();
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  const loadSupplier = useCallback(async () => {
    const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

    // 1. Check local Dexie cache first for pending local edits or needs attention
    let cachedRecord: any = null;
    let tenantId: string | undefined;
    try {
      const restored = await restoreOfflineSession().catch(() => null);
      if (restored?.ok && restored.identity?.tenantId) {
        tenantId = restored.identity.tenantId;
        const cachedKey = makeCachedSupplierId(tenantId, id);
        cachedRecord = await offlineDB.cachedSuppliers.get(cachedKey);
      }
    } catch {}

    // If local cache has a pending edit or needs attention, NEVER overwrite it with stale server data!
    if (cachedRecord && (cachedRecord.syncStatus === "PENDING" || cachedRecord.syncStatus === "NEEDS_ATTENTION")) {
      const detail: SupplierDetail = {
        _id: cachedRecord.supplierId,
        supplierCode: cachedRecord.supplierCode,
        name: cachedRecord.name,
        contact: {
          contactPerson: cachedRecord.contactPerson,
          phone: cachedRecord.phone,
          email: cachedRecord.email,
        },
        address: {
          line1: cachedRecord.address || cachedRecord.line1,
          state: cachedRecord.state,
        },
        tax: {
          gstin: cachedRecord.gstin,
        },
        paymentTerms: {
          type: cachedRecord.paymentType,
          creditDays: cachedRecord.creditDays,
        },
        status: cachedRecord.status,
        syncStatus: cachedRecord.syncStatus,
        errorMessage: cachedRecord.errorMessage,
      };
      setSupplier(detail);
      resetFormToSupplier(detail);
      setPurchases([]);
      setIsOffline(isNavOffline);
      setError(null);
      setLoading(false);

      if (!isNavOffline && cachedRecord.syncStatus === "PENDING") {
        void triggerSync();
      }
      return;
    }

    // 2. If online and no pending local edit, attempt to fetch from server
    if (!isNavOffline) {
      try {
        const res = await fetch(`/api/suppliers/${id}`, {
          credentials: "same-origin",
          signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
        });

        if (res.status === 401 || res.status === 403) {
          setError(
            res.status === 401
              ? "Please sign in to access this supplier."
              : "You do not have permission to view this supplier."
          );
          setLoading(false);
          return;
        }

        const data = await res.json().catch(() => null);

        if (res.ok && data?.success && data.supplier) {
          const detail: SupplierDetail = {
            ...data.supplier,
            syncStatus: "SYNCED",
          };
          setSupplier(detail);
          setPurchases(data.purchases || []);
          resetFormToSupplier(detail);
          setIsOffline(false);
          setError(null);
          setLoading(false);
          return;
        } else if (res.status === 404) {
          setError(data?.message || "Supplier not found");
          setLoading(false);
          return;
        }
      } catch {
        // Network timeout or fetch failure: proceed to offline fallback
      }
    }

    // 3. Offline fallback from local cache
    if (cachedRecord) {
      const detail: SupplierDetail = {
        _id: cachedRecord.supplierId,
        supplierCode: cachedRecord.supplierCode,
        name: cachedRecord.name,
        contact: {
          contactPerson: cachedRecord.contactPerson,
          phone: cachedRecord.phone,
          email: cachedRecord.email,
        },
        address: {
          line1: cachedRecord.address || cachedRecord.line1,
          state: cachedRecord.state,
        },
        tax: {
          gstin: cachedRecord.gstin,
        },
        paymentTerms: {
          type: cachedRecord.paymentType,
          creditDays: cachedRecord.creditDays,
        },
        status: cachedRecord.status,
        syncStatus: cachedRecord.syncStatus || "SYNCED",
        errorMessage: cachedRecord.errorMessage,
      };
      setSupplier(detail);
      resetFormToSupplier(detail);
      setPurchases([]);
      setIsOffline(true);
      setError(null);
    } else {
      setIsOffline(isNavOffline);
      setError(isNavOffline ? "Supplier record not cached for offline use." : "Supplier not found.");
    }
    setLoading(false);
  }, [id, triggerSync]);

  useEffect(() => {
    void loadSupplier();

    const onOnline = () => {
      void triggerSync();
    };
    const onOffline = () => {
      setIsOffline(true);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [loadSupplier, triggerSync]);

  const handleExecuteLifecycleAction = async () => {
    if (!pendingModal || isPendingLifecycle) return;

    // Safety boundary: lifecycle actions are strictly online-only
    const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;
    if (isNavOffline || isOffline) {
      setLifecycleError("Lifecycle actions (deactivate, block, reactivate, unblock, delete) require an active online connection.");
      return;
    }

    setIsPendingLifecycle(true);
    setLifecycleError(null);

    try {
      if (pendingModal.action === "delete") {
        const res = await fetch(`/api/suppliers/${id}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          if (data.deactivated && data.supplier) {
            setSupplier(data.supplier);
            setLifecycleNotice(
              data.message || "Supplier has transaction history and was deactivated instead of deleted."
            );
          } else {
            setSupplier((prev) => (prev ? { ...prev, isDeleted: true } : null));
            setLifecycleNotice(data.message || "Supplier deleted successfully.");
          }
          setPendingModal(null);
          setLifecycleReason("");
          setLifecycleError(null);
        } else {
          setLifecycleError(data?.message || "Failed to delete supplier.");
        }
      } else {
        const res = await fetch(`/api/suppliers/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            action: pendingModal.action,
            reason: lifecycleReason.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success && data.supplier) {
          setSupplier(data.supplier);
          setLifecycleNotice(`Supplier ${pendingModal.action}d successfully.`);
          setPendingModal(null);
          setLifecycleReason("");
          setLifecycleError(null);
        } else {
          setLifecycleError(data?.message || `Failed to ${pendingModal.action} supplier.`);
        }
      }
    } catch {
      setLifecycleError("Unable to connect to the server. Please try again.");
    } finally {
      setIsPendingLifecycle(false);
    }
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();

    setFieldErrors({});
    setUpdateError(null);

    const cleanName = name.trim();
    if (!cleanName) {
      setFieldErrors({ name: "Name cannot be empty." });
      return;
    }

    startTransition(async () => {
      const isNavOffline = typeof navigator !== "undefined" && !navigator.onLine;

      // 1. Online update attempt
      if (!isNavOffline) {
        try {
          const res = await fetch(`/api/suppliers/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
            body: JSON.stringify({
              name: cleanName,
              contactPerson: contactPerson.trim() || undefined,
              phone: phone.trim() || undefined,
              email: email.trim() || undefined,
              gstin: gstin.trim() || undefined,
              address: address.trim() || undefined,
              state: state.trim() || undefined,
            }),
          });

          const data = await res.json().catch(() => null);

          if (res.ok && data?.success) {
            setSupplier(data.supplier);
            setIsEditing(false);
            setFieldErrors({});
            setUpdateError(null);
            return;
          }

          if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
            const parsed = parseSupplierValidationErrors(data);
            setFieldErrors(parsed.fieldErrors);
            setUpdateError(parsed.generalError);
            return;
          }
        } catch {
          // Network failed: proceed to offline update
        }
      }

      // 2. Offline update fallback via Dexie cache
      try {
        const restored = await restoreOfflineSession().catch(() => null);
        if (!restored || !restored.ok || !restored.identity?.tenantId) {
          setUpdateError(
            restored?.reason ||
            "Unable to update supplier offline. Please sign in online first."
          );
          return;
        }

        const updated = await savePendingOfflineSupplierUpdate(
          {
            supplierId: id,
            name: cleanName,
            contactPerson: contactPerson.trim() || undefined,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            gstin: gstin.trim() || undefined,
            address: address.trim() || undefined,
            state: state.trim() || undefined,
          },
          restored.identity.tenantId,
          offlineDB,
          undefined,
          restored.identity
        );

        setSupplier({
          _id: updated.supplierId,
          supplierCode: updated.supplierCode,
          name: updated.name,
          contact: {
            contactPerson: updated.contactPerson,
            phone: updated.phone,
            email: updated.email,
          },
          address: {
            line1: updated.address || updated.line1,
            state: updated.state,
          },
          tax: {
            gstin: updated.gstin,
          },
          paymentTerms: {
            type: updated.paymentType,
            creditDays: updated.creditDays,
          },
          status: updated.status,
          syncStatus: updated.syncStatus,
          errorMessage: updated.errorMessage,
        });

        setIsEditing(false);
        setFieldErrors({});
        setUpdateError(null);

        if (typeof navigator !== "undefined" && navigator.onLine) {
          void triggerSync();
        }
      } catch (err: any) {
        setUpdateError(err?.message || "Unable to update supplier. Please try again.");
      }
    });
  };

  const badge = supplier ? getSupplierDisplayBadge(supplier) : null;
  const isProvisional = isTemporarySupplierCode(supplier?.supplierCode);

  return (
    <AppShell>
      <main className="flex max-w-4xl flex-col gap-4">
        <Link href="/suppliers" className="text-sm underline">
          ← Back to suppliers
        </Link>

        {/* Offline notice banner */}
        {isOffline && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-2 font-medium">
              <span className="size-2 rounded-full bg-amber-500 animate-pulse" />
              Offline Mode — Viewing locally cached supplier record.
            </span>
            <span>Edits will sync automatically when reconnected. Lifecycle actions and purchase history require an online connection.</span>
          </div>
        )}

        {/* NEEDS_ATTENTION safe recovery guidance banner */}
        {supplier?.syncStatus === "NEEDS_ATTENTION" && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-foreground">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-destructive/10 p-1 text-destructive">
                <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
              <div className="flex-1 space-y-1">
                <h3 className="font-semibold text-destructive">Synchronization Requires Attention</h3>
                <p className="text-xs text-muted-foreground font-medium">
                  {supplier.errorMessage || "The server rejected this offline operation due to a validation error or conflict."}
                </p>
                <div className="mt-2 text-xs text-muted-foreground space-y-1 border-t border-destructive/10 pt-2">
                  <p className="font-medium text-foreground">Safe Recovery Guidance:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-xs">
                    <li>Review the error message above (such as duplicate GSTIN, format error, or conflicting profile details).</li>
                    <li>Click <strong>Edit details</strong> below to adjust and correct conflicting fields. Saving your changes updates the queued operation.</li>
                    <li>Dependent offline purchases are safely held in queue and will be processed once this supplier is resolved.</li>
                    <li>Failed operations are preserved for your safety and are never automatically discarded, retried, or reset.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading supplier details...</p>
        ) : error || !supplier ? (
          <p role="alert" className="text-sm text-destructive">{error || "Supplier not found."}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{supplier.name}</h1>
                  {badge && (
                    <span className={badge.className}>
                      {badge.label}
                    </span>
                  )}
                  {supplier.syncStatus === "PENDING" && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      Pending sync
                    </span>
                  )}
                  {supplier.syncStatus === "NEEDS_ATTENTION" && (
                    <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                      Sync failed
                    </span>
                  )}
                </div>

                {/* Supplier Code & GSTIN Display */}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Supplier code:</span>
                  {isProvisional ? (
                    <span
                      className="inline-flex items-center gap-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-amber-800 dark:text-amber-300 border border-amber-500/20"
                      title="Provisional code generated offline. The server assigns an official sequential code once synced."
                    >
                      <span>{supplier.supplierCode}</span>
                      <span className="text-[9px] font-sans font-semibold uppercase tracking-wider bg-amber-500/20 px-1 py-0.2 rounded">
                        Provisional
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono font-medium">{supplier.supplierCode || id}</span>
                  )}
                  <span>·</span>
                  <span>{supplier.tax?.gstin ? `GSTIN: ${supplier.tax.gstin}` : "No GSTIN"}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!supplier.isDeleted && !isEditing && (
                  <>
                    {/* Separate, clearly labelled lifecycle controls (online only) */}
                    {supplier.status === "active" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isOffline}
                          title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                          onClick={() => {
                            setLifecycleError(null);
                            setLifecycleReason("");
                            setPendingModal({ action: "deactivate", title: "Deactivate Supplier" });
                          }}
                        >
                          Deactivate
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isOffline}
                          title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                          className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/20 disabled:text-muted-foreground"
                          onClick={() => {
                            setLifecycleError(null);
                            setLifecycleReason("");
                            setPendingModal({ action: "block", title: "Block Supplier" });
                          }}
                        >
                          Block
                        </Button>
                      </>
                    )}

                    {supplier.status === "inactive" && (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={isOffline}
                        title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                        onClick={() => {
                          setLifecycleError(null);
                          setLifecycleReason("");
                          setPendingModal({ action: "reactivate", title: "Reactivate Supplier" });
                        }}
                      >
                        Reactivate
                      </Button>
                    )}

                    {supplier.status === "blocked" && (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={isOffline}
                        title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                        onClick={() => {
                          setLifecycleError(null);
                          setLifecycleReason("");
                          setPendingModal({ action: "unblock", title: "Unblock Supplier" });
                        }}
                      >
                        Unblock
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isOffline}
                      title={isOffline ? "Lifecycle actions require an active online server connection" : undefined}
                      className="text-destructive hover:bg-destructive/10 disabled:text-muted-foreground"
                      onClick={() => {
                        setLifecycleError(null);
                        setLifecycleReason("");
                        setPendingModal({ action: "delete", title: "Delete / Archive Supplier" });
                      }}
                    >
                      Delete
                    </Button>
                  </>
                )}

                <Button
                  variant={isEditing ? "outline" : "default"}
                  size="sm"
                  onClick={() => {
                    if (!isEditing) {
                      resetFormToSupplier();
                    }
                    setIsEditing(!isEditing);
                  }}
                >
                  {isEditing ? "Cancel" : "Edit details"}
                </Button>
              </div>
            </div>

            {/* Lifecycle feedback notifications */}
            {lifecycleNotice && (
              <div
                role="status"
                className="rounded-md bg-emerald-500/10 p-3 text-xs font-medium text-emerald-800 dark:text-emerald-300"
              >
                {lifecycleNotice}
              </div>
            )}
            {lifecycleError && (
              <div
                role="alert"
                className="rounded-md bg-destructive/10 p-3 text-xs font-medium text-destructive"
              >
                {lifecycleError}
              </div>
            )}

            {/* Provisional code explainer banner */}
            {isProvisional && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <span className="font-semibold">Provisional Supplier Code ({supplier.supplierCode}):</span>{" "}
                This supplier was created offline. The server will automatically allocate an official sequential code (e.g. SUP-0042) upon synchronization.
              </div>
            )}

            {/* Edit details form */}
            {isEditing && (
              <form
                noValidate
                onSubmit={handleUpdate}
                className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm"
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Edit supplier profile</h2>
                  {isOffline && (
                    <span className="text-xs text-amber-700 dark:text-amber-300 font-medium">
                      Saving offline
                    </span>
                  )}
                </div>
                {updateError && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {updateError}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-name">Business name *</Label>
                    <Input
                      id="sup-edit-name"
                      name="name"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        clearFieldError("name");
                      }}
                      aria-invalid={Boolean(fieldErrors.name)}
                      aria-describedby={fieldErrors.name ? "sup-edit-name-error" : undefined}
                      required
                    />
                    {fieldErrors.name && (
                      <p
                        id="sup-edit-name-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.name}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-contact">Contact person</Label>
                    <Input
                      id="sup-edit-contact"
                      name="contactPerson"
                      value={contactPerson}
                      onChange={(e) => {
                        setContactPerson(e.target.value);
                        clearFieldError("contactPerson");
                      }}
                      aria-invalid={Boolean(fieldErrors.contactPerson)}
                      aria-describedby={fieldErrors.contactPerson ? "sup-edit-contact-error" : undefined}
                    />
                    {fieldErrors.contactPerson && (
                      <p
                        id="sup-edit-contact-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.contactPerson}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-phone">Phone number</Label>
                    <Input
                      id="sup-edit-phone"
                      name="phone"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        clearFieldError("phone");
                      }}
                      aria-invalid={Boolean(fieldErrors.phone)}
                      aria-describedby={fieldErrors.phone ? "sup-edit-phone-error" : undefined}
                    />
                    {fieldErrors.phone && (
                      <p
                        id="sup-edit-phone-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.phone}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-email">Email</Label>
                    <Input
                      id="sup-edit-email"
                      name="email"
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearFieldError("email");
                      }}
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={fieldErrors.email ? "sup-edit-email-error" : undefined}
                    />
                    {fieldErrors.email && (
                      <p
                        id="sup-edit-email-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.email}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-gstin">GSTIN</Label>
                    <Input
                      id="sup-edit-gstin"
                      name="gstin"
                      value={gstin}
                      onChange={(e) => {
                        setGstin(e.target.value.toUpperCase());
                        clearFieldError("gstin");
                      }}
                      aria-invalid={Boolean(fieldErrors.gstin)}
                      aria-describedby={fieldErrors.gstin ? "sup-edit-gstin-error" : undefined}
                      maxLength={15}
                    />
                    {fieldErrors.gstin && (
                      <p
                        id="sup-edit-gstin-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.gstin}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sup-edit-address">Address</Label>
                    <Input
                      id="sup-edit-address"
                      name="address"
                      value={address}
                      onChange={(e) => {
                        setAddress(e.target.value);
                        clearFieldError("address");
                      }}
                      aria-invalid={Boolean(fieldErrors.address)}
                      aria-describedby={fieldErrors.address ? "sup-edit-address-error" : undefined}
                    />
                    {fieldErrors.address && (
                      <p
                        id="sup-edit-address-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.address}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={isPending}>
                    {isPending ? "Saving..." : isOffline ? "Save offline" : "Save changes"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      resetFormToSupplier();
                      setIsEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {/* Overview cards */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Payment terms</p>
                <p className="mt-1 font-semibold capitalize">
                  {supplier.paymentTerms?.type === "credit"
                    ? `${supplier.paymentTerms.creditDays || 0} days credit`
                    : supplier.paymentTerms?.type || "Cash"}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Purchases recorded</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{purchases.length}</p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">Contact &amp; Location</p>
                <p className="mt-1 text-sm">
                  {supplier.contact?.phone || supplier.contact?.email || "No direct contact"}
                  {supplier.address?.line1 ? ` · ${supplier.address.line1}` : ""}
                </p>
              </div>
            </div>

            {/* Purchases from this supplier */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Purchase bills from this vendor</h2>
                {!isOffline && (
                  <Link href="/purchases/new" className="text-xs underline">
                    Record new purchase
                  </Link>
                )}
              </div>
              {isOffline ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  Purchase bill history requires an active online connection.
                </div>
              ) : purchases.length === 0 ? (
                <p className="text-sm text-muted-foreground">No purchase bills recorded for this supplier yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="w-full text-sm" aria-label="Supplier purchases">
                    <thead className="border-b bg-muted/40 text-left">
                      <tr>
                        <th className="p-2.5 font-medium">Date</th>
                        <th className="p-2.5 font-medium">Bill #</th>
                        <th className="p-2.5 text-right font-medium">Total</th>
                        <th className="p-2.5 text-right font-medium">Due</th>
                        <th className="p-2.5 text-right font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {purchases.map((p) => (
                        <tr key={p._id} className="hover:bg-muted/30">
                          <td className="p-2.5 text-muted-foreground">
                            {p.purchaseDate
                              ? new Date(p.purchaseDate).toLocaleDateString("en-IN", {
                                  dateStyle: "medium",
                                })
                              : "—"}
                          </td>
                          <td className="p-2.5">
                            <Link
                              href={`/purchases/${p._id}`}
                              className="font-medium underline hover:text-primary"
                            >
                              {p.supplierInvoiceNo || p.purchaseNo || p._id}
                            </Link>
                          </td>
                          <td className="p-2.5 text-right tabular-nums font-medium">
                            {typeof p.grandTotal === "number"
                              ? formatPaise(rupeesToPaise(p.grandTotal))
                              : "—"}
                          </td>
                          <td className="p-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">
                            {typeof p.dueAmount === "number"
                              ? formatPaise(rupeesToPaise(p.dueAmount))
                              : "—"}
                          </td>
                          <td className="p-2.5 text-right">
                            <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize">
                              {p.status || "active"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Lifecycle Confirmation Modal */}
      {pendingModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="lifecycle-modal-title"
          aria-describedby="lifecycle-modal-description"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !isPendingLifecycle) {
              setPendingModal(null);
              setLifecycleReason("");
              setLifecycleError(null);
            }
          }}
        >
          <div className="relative w-full max-w-lg rounded-xl border bg-background p-6 shadow-2xl">
            <h2 id="lifecycle-modal-title" className="text-lg font-semibold tracking-tight">
              {pendingModal.title}
            </h2>

            <p id="lifecycle-modal-description" className="mt-2 text-sm text-muted-foreground leading-relaxed">
              {pendingModal.action === "deactivate" && (
                <>
                  Are you sure you want to deactivate{" "}
                  <strong className="text-foreground">{supplier?.name || "this supplier"}</strong>?
                  Inactive suppliers cannot be selected on new purchase bills or orders. Existing
                  purchase history and transaction records are preserved.
                </>
              )}
              {pendingModal.action === "block" && (
                <>
                  Are you sure you want to block{" "}
                  <strong className="text-foreground">{supplier?.name || "this supplier"}</strong>?
                  Blocked suppliers cannot be selected for new purchases or transactions. You can
                  unblock them at any time.
                </>
              )}
              {pendingModal.action === "reactivate" && (
                <>
                  Are you sure you want to reactivate{" "}
                  <strong className="text-foreground">{supplier?.name || "this supplier"}</strong>?
                  The supplier will become active again and available for recording new purchase bills.
                </>
              )}
              {pendingModal.action === "unblock" && (
                <>
                  Are you sure you want to unblock{" "}
                  <strong className="text-foreground">{supplier?.name || "this supplier"}</strong>?
                  The supplier will return to active status and be available for purchases and payments.
                </>
              )}
              {pendingModal.action === "delete" && (
                <>
                  Are you sure you want to delete{" "}
                  <strong className="text-foreground">{supplier?.name || "this supplier"}</strong>?
                  Suppliers with existing transaction history (purchases, returns, payments, or ledger
                  entries) will be safely deactivated to preserve accounting records. Unreferenced
                  suppliers will be soft-deleted.
                </>
              )}
            </p>

            {/* Optional reason input for deactivate and block */}
            {(pendingModal.action === "deactivate" || pendingModal.action === "block") && (
              <div className="mt-4 flex flex-col gap-1.5">
                <Label htmlFor="lifecycle-modal-reason">
                  Reason for {pendingModal.action === "deactivate" ? "deactivating" : "blocking"}{" "}
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="lifecycle-modal-reason"
                  name="lifecycleReason"
                  value={lifecycleReason}
                  onChange={(e) => setLifecycleReason(e.target.value)}
                  placeholder={
                    pendingModal.action === "deactivate"
                      ? "e.g., Discontinued vendor relationship, business closed"
                      : "e.g., Payment or quality dispute, audit hold"
                  }
                  maxLength={500}
                  disabled={isPendingLifecycle}
                />
                <span className="text-[11px] text-muted-foreground text-right">
                  {lifecycleReason.length}/500
                </span>
              </div>
            )}

            {/* Modal error display */}
            {lifecycleError && (
              <div
                role="alert"
                className="mt-4 rounded-md bg-destructive/10 p-3 text-xs font-medium text-destructive"
              >
                {lifecycleError}
              </div>
            )}

            {/* Actions row */}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={isPendingLifecycle}
                onClick={() => {
                  setPendingModal(null);
                  setLifecycleReason("");
                  setLifecycleError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant={pendingModal.action === "delete" ? "destructive" : "default"}
                className={
                  pendingModal.action === "block"
                    ? "bg-amber-600 hover:bg-amber-700 text-white"
                    : undefined
                }
                disabled={isPendingLifecycle}
                onClick={handleExecuteLifecycleAction}
              >
                {isPendingLifecycle
                  ? "Processing..."
                  : pendingModal.action === "delete"
                  ? "Confirm Delete"
                  : pendingModal.action === "deactivate"
                  ? "Deactivate Supplier"
                  : pendingModal.action === "block"
                  ? "Block Supplier"
                  : pendingModal.action === "reactivate"
                  ? "Reactivate Supplier"
                  : "Unblock Supplier"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
