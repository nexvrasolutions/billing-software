
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Ignore generated Workbox service-worker files.
    "public/workbox-*.js",

    // Ignore the generated bundle of the custom worker (worker/index.ts),
    // e.g. public/worker-development.js from `next dev`.
    "public/worker-*.js",
  ]),
]);

export default eslintConfig;
