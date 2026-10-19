import type { NextConfig } from "next";
import { randomUUID } from "crypto";

import withPWA from "@ducanh2912/next-pwa";

// Changes on every build, so each new service worker re-downloads the
// precached app-shell pages together with that build's (precached) scripts.
const APP_SHELL_REVISION = randomUUID();

// Security headers (the single place that sets them; proxy.ts sets none).
//
// The Content Security Policy is REPORT-ONLY: the browser blocks nothing and
// only logs "[Report Only] ..." violations to its console. It is not
// enforced yet and has no reporting endpoint. It has no nonce: every page
// is prerendered as static HTML (and /dashboard and /offline-test are
// precached by the service worker), so no per-request nonce could ever match
// it; that is why 'unsafe-inline' is allowed for scripts and styles until a
// hash-based approach is evaluated. 'unsafe-eval' is added in development
// only (React needs it there).
//
// Left out on purpose: Strict-Transport-Security (decide it with the hosting;
// over plain HTTP it is ignored, and over HTTPS it locks browsers to HTTPS),
// an enforcing CSP, upgrade-insecure-requests, COEP and CORP.
function contentSecurityPolicyReportOnly(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    const isDev = process.env.NODE_ENV === "development";

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicyReportOnly(isDev) },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: [
              "camera=()",
              "microphone=()",
              "geolocation=()",
              "payment=()",
              "usb=()",
              "bluetooth=()",
              "serial=()",
              "hid=()",
              "display-capture=()",
              "accelerometer=()",
              "gyroscope=()",
              "magnetometer=()",
            ].join(", "),
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        // API answers hold private business data (and some set cookies): no
        // browser, proxy or CDN may store them. The service worker already
        // treats /api/* as network-only; this covers everything else.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default withPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  // The plugin's default reloads every page when the connection returns.
  // That would throw away a sale being entered and cut off a sync in
  // progress; the app instead syncs by itself on reconnect (AutoSync).
  reloadOnOnline: false,
  // Keep the default caching for static assets and pages, but replace the
  // default "apis" rule: authenticated /api/* responses contain private
  // business data and must never be served from cache (for example to
  // another user, or after logout). The custom worker in /worker deletes
  // the old "apis" cache that earlier versions created.
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    // A new version must not take over open tabs by itself: activation
    // removes the old version's precached files, which an open (possibly
    // offline) tab may still need. The new worker waits until the user
    // chooses "Reload to update" (UpdateBanner posts SKIP_WAITING; Workbox
    // adds that message listener when skipWaiting is false) or until every
    // tab of the app is closed. The very first install still controls the
    // page at once (clientsClaim), so offline use works after one visit.
    skipWaiting: false,
    // App-shell pages needed offline (offline status on the dashboard, offline
    // work page, and offline POS). All are static, prerendered pages without user data:
    // all private data comes from /api/*, which is never cached. Precaching makes
    // them available offline as soon as the service worker is installed,
    // instead of only after a visit populated the runtime "pages" cache.
    additionalManifestEntries: [
      { url: "/dashboard", revision: APP_SHELL_REVISION },
      { url: "/offline-test", revision: APP_SHELL_REVISION },
      { url: "/pos", revision: APP_SHELL_REVISION },
    ],
    runtimeCaching: [
      {
        urlPattern: ({ sameOrigin, url }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "GET",
        options: { cacheName: "apis" },
      },
      {
        urlPattern: ({ sameOrigin, url }) =>
          sameOrigin &&
          (url.pathname.startsWith("/_next/static/css/") ||
            /\.(?:css|less)$/i.test(url.pathname)),
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "static-style-assets",
          expiration: {
            maxEntries: 32,
            maxAgeSeconds: 86400,
          },
        },
      },
    ],
  },
})(nextConfig);
