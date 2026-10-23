import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?">
      <div className="flex flex-col gap-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          For multi-tenant workstation security and device lease safety, password resets must be issued by a business administrator or requested via your verified email.
        </p>
        <p>
          If you are logged into another registered device, you can change your password under <strong>My account</strong>.
        </p>
      </div>
      <Link href="/login" className="text-sm underline">
        Back to log in
      </Link>
    </AuthCard>
  );
}
