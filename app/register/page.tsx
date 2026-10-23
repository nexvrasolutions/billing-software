import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <AuthCard title="Create your account">
      <div className="flex flex-col gap-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          New tenant accounts and staff memberships are issued with cryptographic device pairing.
        </p>
        <p>
          To register your business or register a new workstation terminal, contact your system administrator or follow the invite link sent to your email.
        </p>
        <Link href="/login" className="action-primary text-center">
          Back to log in
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Already have an account? <Link href="/login" className="underline">Log in</Link>
      </p>
    </AuthCard>
  );
}
