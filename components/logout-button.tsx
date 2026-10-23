"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { countAllUnsyncedItems } from "@/lib/offline/pendingQueue";
import { endOfflineAccess } from "@/lib/offline/sessionIdentity";

export function LogoutButton(): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [unsent, setUnsent] = useState<number | null>(null);

  async function logOut(): Promise<void> {
    setPending(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }).catch(() => undefined);

      await endOfflineAccess().catch(() => undefined);

      router.replace("/login");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function start(): Promise<void> {
    const waiting = await countAllUnsyncedItems().catch(() => 0);
    if (waiting > 0) {
      setUnsent(waiting);
      return;
    }
    await logOut();
  }

  if (unsent !== null) {
    return (
      <div
        role="alertdialog"
        aria-label="Items not synced yet"
        className="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-2 text-xs text-foreground"
      >
        <span>
          {unsent} item(s) on this device are not synced yet. They stay here and
          sync when you sign in again.
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setUnsent(null);
            }}
          >
            Stay logged in
          </Button>
          <Button
            variant="destructive"
            size="xs"
            disabled={pending}
            onClick={() => void logOut()}
          >
            {pending ? "Logging out..." : "Log out anyway"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => void start()}
    >
      {pending ? "Logging out..." : "Log out"}
    </Button>
  );
}
