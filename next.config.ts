import type { NextConfig } from "next";
import { randomUUID } from "crypto";

import withPWA from "@ducanh2912/next-pwa";

// Changes on every build, so each new service worker re-downloads the
// precached app-shell pages together with that build's (precached) scripts.
const APP_SHELL_REVISION = randomUUID();

const nextConfig: NextConfig = {
  /* config options here */
};

export default withPWA({
  dest: "public",
  register: true,
  // Keep the default caching for static assets and pages, but replace the
  // default "apis" rule: authenticated /api/* responses contain private
  // business data and must never be served from cache (for example to
  // another user, or after logout). The custom worker in /worker deletes
  // the old "apis" cache that earlier versions created.
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    // App-shell pages needed offline (PIN unlock on the dashboard, offline
    // work page). Both are static, prerendered pages without user data: all
    // private data comes from /api/*, which is never cached. Precaching makes
    // them available offline as soon as the service worker is installed,
    // instead of only after a visit populated the runtime "pages" cache.
    additionalManifestEntries: [
      { url: "/dashboard", revision: APP_SHELL_REVISION },
      { url: "/offline-test", revision: APP_SHELL_REVISION },
    ],
    runtimeCaching: [
      {
        urlPattern: ({ sameOrigin, url }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "GET",
        options: { cacheName: "apis" },
      },
    ],
  },
})(nextConfig);
