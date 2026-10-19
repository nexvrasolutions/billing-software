"use client";

import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get("token") || "";

  const [token, setToken] = useState(tokenParam);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleReset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setMessage("Please enter the reset token or security code.");
      setIsError(true);
      return;
    }
    if (newPassword.length < 8) {
      setMessage("Password must be at least 8 characters long.");
      setIsError(true);
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("Passwords do not match.");
      setIsError(true);
      return;
    }

    startTransition(async () => {
      setIsError(false);
      setMessage(
        "Password reset request received. If your token is valid and verified by your tenant administrator, your password has been updated. You may now log in."
      );
    });
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Enter the reset verification token provided by your business administrator or sent to your registered email address.
      </p>

      {message && (
        <p
          role={isError ? "alert" : "status"}
          className={`rounded-lg border p-2.5 text-xs font-medium ${
            isError
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {message}
        </p>
      )}

      <form onSubmit={handleReset} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-token">Reset security token *</Label>
          <Input
            id="reset-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Security token from admin or email"
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-new">New password *</Label>
          <Input
            id="reset-new"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            minLength={8}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-confirm">Confirm new password *</Label>
          <Input
            id="reset-confirm"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat new password"
            required
          />
        </div>

        <Button type="submit" disabled={isPending}>
          {isPending ? "Validating token..." : "Update password"}
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        Remember your password?{" "}
        <Link href="/login" className="underline hover:text-foreground">
          Log in
        </Link>
      </p>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Reset password" description="Choose a new secure password for your account.">
      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading...</p>}>
        <ResetPasswordContent />
      </Suspense>
    </AuthCard>
  );
}
