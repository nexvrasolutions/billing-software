"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  confirmServerSession,
  forgetSessionIdentity,
  identityFromMe,
  rememberSessionIdentity,
  restoreOfflineSession,
  type OfflineRestorationResult,
} from "@/lib/offline/sessionIdentity";
import {
  clearPendingServerLogout,
  settlePendingServerLogout,
} from "@/lib/offline/offlineAccess";
import {
  checkAccountSwitch,
  countAllUnsyncedItems,
} from "@/lib/offline/pendingQueue";
import {
  persistenceText,
  requestPersistentStorage,
  type PersistenceResult,
} from "@/lib/offline/storageDurability";
import { ExportPendingButton } from "@/components/offline/ExportPendingButton";
import { AuthCard, Field, FormMessage } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";

interface SwitchBlock {
  waiting: number;
  notCovered: number;
  couldNotCheck: boolean;
  sessionEnded: boolean;
}

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [blocked, setBlocked] = useState<SwitchBlock | null>(null);
  const [offlineRestoration, setOfflineRestoration] = useState<OfflineRestorationResult | null>(null);

  // Device status signals (storage durability and waiting local queue)
  const [unsyncedCount, setUnsyncedCount] = useState<number | null>(null);
  const [persistence, setPersistence] = useState<PersistenceResult | null>(null);

  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;

    void countAllUnsyncedItems()
      .then((count) => {
        if (active) setUnsyncedCount(count);
      })
      .catch(() => undefined);

    void requestPersistentStorage(
      typeof navigator !== "undefined" ? navigator.storage : undefined
    )
      .then((res) => {
        if (active) setPersistence(res);
      })
      .catch(() => undefined);

    void restoreOfflineSession()
      .then((res) => {
        if (active && res.ok) setOfflineRestoration(res);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submittingRef.current) return;
    submittingRef.current = true;

    setError(null);
    setBlocked(null);
    setLoading(true);

    try {
      // Step 0: earlier offline sign-out must end the old server session first
      await settlePendingServerLogout().catch(() => "unreachable" as const);

      // Step 1: Authenticate using email, password, and registered device ID
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

      // Step 2: Verify the authenticated session with the server
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

      // Account-switch guard
      const candidate = identityFromMe(meData);
      let decision: Awaited<ReturnType<typeof checkAccountSwitch>> | null = null;
      let couldNotCheck = false;

      if (candidate) {
        try {
          decision = await checkAccountSwitch(candidate);
        } catch {
          couldNotCheck = true;
        }
      }

      if (couldNotCheck || (decision && !decision.allowed)) {
        let sessionEnded = false;
        try {
          const logoutResponse = await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
          });
          const logoutData = await logoutResponse.json().catch(() => null);
          sessionEnded = logoutResponse.ok && logoutData?.success === true;
        } catch {
          sessionEnded = false;
        }

        setBlocked({
          waiting: decision && !decision.allowed ? decision.blockingCount : 0,
          notCovered: decision && !decision.allowed ? decision.uncoveredCount : 0,
          couldNotCheck,
          sessionEnded,
        });
        return;
      }

      await clearPendingServerLogout().catch(() => undefined);

      const identity = identityFromMe(meData);

      if (meData?.user?.mustChangePassword !== true && identity) {
        await rememberSessionIdentity(identity).catch(() => undefined);
      }

      await confirmServerSession(meData, { renew: true }).catch(() => undefined);

      const user = meData?.user ?? meData?.data?.user ?? meData;

      if (user?.mustChangePassword) {
        router.replace("/account");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      const offlineRes = await restoreOfflineSession().catch(() => null);
      if (offlineRes?.ok) {
        setOfflineRestoration(offlineRes);
        setError(
          "Unable to connect to the server. An authorized offline session is available on this device — you can continue offline to use the till."
        );
      } else {
        setError(
          "Unable to connect to the server. Please check your connection and try again."
        );
      }
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Log in">
      {/* Authorized Offline Till Notice */}
      {offlineRestoration?.ok && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-3 text-xs text-foreground"
        >
          <div className="flex items-center justify-between">
            <p className="font-semibold text-emerald-800 dark:text-emerald-200">
              Offline till available
            </p>
            <span className="text-[11px] text-muted-foreground">No internet needed</span>
          </div>
          <p className="text-muted-foreground">
            This device has an active offline session
            {offlineRestoration.overview?.state?.status === "available" && offlineRestoration.overview.state.displayName
              ? ` for ${offlineRestoration.overview.state.displayName}`
              : ""}
            . You can continue to the billing till without logging in online again.
          </p>
          <div className="pt-1">
            <Link
              href="/pos"
              className="inline-flex h-8 items-center rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700"
            >
              Continue to Till (New bill)
            </Link>
          </div>
        </div>
      )}

      {/* Storage Durability Notice */}
      {persistence && persistence !== "persisted" && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs text-foreground"
        >
          <p className="font-medium">Storage notice</p>
          <p className="mt-0.5 text-muted-foreground">{persistenceText(persistence)}</p>
        </div>
      )}

      {/* Unsynced Offline Items Notice */}
      {unsyncedCount !== null && unsyncedCount > 0 && (
        <div
          role="status"
          className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs text-foreground"
        >
          <p className="font-medium">Local offline queue</p>
          <p className="mt-0.5 text-muted-foreground">
            {unsyncedCount} unsynced operation(s) are stored on this device and will synchronize when online.
          </p>
        </div>
      )}

      {/* Account Switch Safeguard Alert */}
      {blocked && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-foreground"
        >
          <p className="font-semibold text-destructive">Sign-in was stopped</p>
          {blocked.couldNotCheck ? (
            <p className="text-muted-foreground">
              Sign-in was stopped because the operations waiting on this device could not be checked. Reload the page and try again.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {blocked.waiting} operation(s) made on this device by another account are still waiting to be sent
                {blocked.notCovered < blocked.waiting ? ` (${blocked.notCovered} not yet saved to a file)` : ""}.
                They have not been deleted, changed or moved to your account.
              </p>
              <p className="text-muted-foreground">
                To send them, sign in as the account that made them, or save a copy to a file.
              </p>
              <div className="pt-1">
                <ExportPendingButton
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  onSaved={() => setBlocked(null)}
                />
              </div>
            </>
          )}
          {!blocked.sessionEnded && (
            <p className="border-t border-destructive/20 pt-1 text-[11px] text-muted-foreground">
              The new sign-in could not be confirmed as ended on the server.
            </p>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />

        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />

        <Field
          id="deviceId"
          label="Device ID"
          type="text"
          autoComplete="off"
          maxLength={100}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          placeholder="Registered workstation code"
          disabled={loading}
        />

        <FormMessage kind="error" text={error} />

        <Button type="submit" disabled={loading}>
          {loading ? "Logging in..." : "Log in"}
        </Button>
      </form>

      <Link href="/forgot-password" className="text-sm underline">
        Forgot your password?
      </Link>
      <p className="text-sm text-muted-foreground">
        New here? <Link href="/register" className="underline">Create an account</Link>
      </p>
    </AuthCard>
  );
}
