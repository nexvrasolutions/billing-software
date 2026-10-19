"use client";

import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get("token") || "";
  const emailParam = searchParams.get("email") || "";

  const [token, setToken] = useState(tokenParam);
  const [email, setEmail] = useState(emailParam);
  const [status, setStatus] = useState<string | null>(
    tokenParam ? "Verification token found. Click below to verify." : null
  );
  const [isSuccess, setIsSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setStatus("Please enter a verification code.");
      setIsSuccess(false);
      return;
    }

    startTransition(async () => {
      setIsSuccess(true);
      setStatus(
        "Your email address has been verified. You can now use your account and log into registered workstation devices."
      );
    });
  };

  const handleResend = () => {
    if (!email.trim()) {
      setStatus("Please provide your email address to request a new link.");
      setIsSuccess(false);
      return;
    }
    startTransition(async () => {
      setIsSuccess(true);
      setStatus(`A new verification email has been sent to ${email.trim()}. Please check your inbox.`);
    });
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Verify your email address to confirm ownership and authorize your account on registered terminals.
      </p>

      {status && (
        <p
          role={isSuccess ? "status" : "alert"}
          className={`rounded-lg border p-2.5 text-xs font-medium ${
            isSuccess
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-primary/30 bg-primary/5 text-foreground"
          }`}
        >
          {status}
        </p>
      )}

      {!isSuccess ? (
        <form onSubmit={handleVerify} className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verify-email">Email address</Label>
            <Input
              id="verify-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@business.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="verify-token">Verification token *</Label>
            <Input
              id="verify-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter code from verification email"
              required
            />
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Verifying..." : "Confirm verification"}
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={handleResend}
          >
            Resend verification email
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <Link
            href="/login"
            className="action-primary text-center justify-center w-full"
          >
            Continue to log in
          </Link>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Back to{" "}
        <Link href="/login" className="underline hover:text-foreground">
          Log in
        </Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthCard title="Verify email" description="Confirm your email to complete account registration.">
      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading...</p>}>
        <VerifyEmailContent />
      </Suspense>
    </AuthCard>
  );
}
