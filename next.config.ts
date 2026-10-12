import type { NextConfig } from "next";

import withPWA from "@ducanh2912/next-pwa";

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
