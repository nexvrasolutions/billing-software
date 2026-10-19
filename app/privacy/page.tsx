import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>Last updated: [date]. This explains how Nexvra Billing Software collects, holds and protects personal and business data.</p>
      <h2>1. Information we collect</h2>
      <p>We collect information needed to run the billing software, including accounts (name, email, password hashes), business and GST details, customer and supplier records, and inventory transactions.</p>
      <h2>2. Use of data</h2>
      <p>Your business records belong to you and are strictly partitioned under multi-tenant isolation. We do not sell or share business records with advertisers.</p>
      <h2>3. Device data &amp; Offline storage</h2>
      <p>To enable offline POS billing, your browser securely caches authorized catalog and pending queue records in IndexedDB. Queued operations are bound to your account and cryptographically verified upon synchronization.</p>
      <h2>4. Data retention and export</h2>
      <p>You can export transactions and pending operations at any time. Records are maintained according to statutory tax and auditing regulations.</p>
    </LegalPage>
  );
}
