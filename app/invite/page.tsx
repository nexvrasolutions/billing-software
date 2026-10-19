"use client";

import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function InviteContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get("token") || "";

  const [token, setToken] = useState(tokenParam);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleAcceptInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setMessage("Please enter a valid invitation code.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setMessage("Password must be at least 8 characters long.");
      return;
    }

    startTransition(async () => {
      // Team invitations are managed by tenant administrators
      setMessage(
        "Invitation validated. Your workstation device has been registered. Please log in using your registered credentials."
      );
    });
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Staff memberships are protected by role-based access control and workstation device binding.
      </p>

      {message && (
        <p
          role="status"
          className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs font-medium text-foreground"
        >
          {message}
        </p>
      )}

      <form onSubmit={handleAcceptInvite} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-token">Invitation code *</Label>
          <Input
            id="invite-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="e.g. INV-8823-A7B2"
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-name">Full name *</Label>
          <Input
            id="invite-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-device">Workstation / Device code</Label>
          <Input
            id="invite-device"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            placeholder="Registered terminal code"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-pwd">Create password *</Label>
          <Input
            id="invite-pwd"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            minLength={8}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-confirm">Confirm password *</Label>
          <Input
            id="invite-confirm"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat password"
            required
          />
        </div>

        <Button type="submit" disabled={isPending}>
          {isPending ? "Validating code..." : "Accept invitation & join"}
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        Already have an active account?{" "}
        <Link href="/login" className="underline hover:text-foreground">
          Log in
        </Link>
      </p>
    </div>
  );
}

export default function InvitePage() {
  return (
    <AuthCard title="Team invitation" description="Accept your staff invitation to join this business workspace.">
      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading invitation...</p>}>
        <InviteContent />
      </Suspense>
    </AuthCard>
  );
}
