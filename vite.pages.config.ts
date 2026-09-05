import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { buildYear } from "./scripts/build-year";

/**
 * GitHub Pages build. **Additive** — `vite.config.ts` is untouched and remains the
 * config for dev, `bun run build` and the e2e run.
 *
 * Pages serves a project site from a repository sub-path, so this build differs from
 * the root build in exactly three ways:
 *
 *  1. `base` is `/vinreader/`, so every emitted URL is prefixed. Vite rewrites the
 *     `index.html` references itself; the values this plugin passes through verbatim
 *     (`vite-plugin-pwa` does not prefix `id`, `start_url`, `scope` or icon `src`)
 *     are spelled out below with the prefix already in them.
 *  2. `build.outDir` is `docs/`, which is one of the two folders Pages can publish
 *     from on a branch. Nothing else writes there.
 *  3. `.nojekyll` is emitted into it, because Pages otherwise runs the output through
 *     Jekyll, which drops every path segment beginning with an underscore.
 *
 * `basicSsl()` is deliberately absent: it only configures the dev server, and there
 * is no dev server here.
 */

/** Same stamp `vite.config.ts` injects — the Settings screen renders it (§7 item 4). */
function buildStamp(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** The published sub-path. One literal, because six places have to agree on it. */
const BASE = "/vinreader/";

/**
 * Writes `docs/.nojekyll` after every build.
 *
 * The file is committed as well, but `emptyOutDir` wipes the folder on each run, so
 * without this the second build would silently drop it and Pages would start feeding
 * the output to Jekyll — which strips `_`-prefixed paths (Vite emits none today, but
 * a future chunk name or a dependency's asset costs nothing to be safe about).
 */
function nojekyll(): Plugin {
  return {
    name: "vin-relay:nojekyll",
    apply: "build",
    closeBundle() {
      const dir = resolve(import.meta.dirname, "docs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, ".nojekyll"), "");
    },
  };
}

export default defineConfig({
  base: BASE,
  // The same two values the root build injects; `__BUILD_YEAR__` is §4.4 step 0's floor.
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()), __BUILD_YEAR__: buildYear() },
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt", // never auto-reload: a reload mid-scan is unacceptable (§9-S0)
      includeAssets: ["favicon.svg"],
      manifest: {
        // Every one of these is passed through by the plugin exactly as written — it
        // prefixes none of them with `base` — so each carries the sub-path itself.
        // `id` stays fixed for the life of this deployment (S0_DECISIONS.md D01); it
        // differs from the root build's `/` because a Pages install is a different
        // app identity at a different URL, not a rename of the same one.
        id: BASE,
        name: "VIN Relay",
        short_name: "VIN Relay",
        description: "Scan, decode and hand off vehicle VINs. Works offline.",
        start_url: `${BASE}#/scan`,
        scope: BASE,
        display: "standalone",
        orientation: "any",
        background_color: "#0b0f14",
        theme_color: "#0b0f14",
        icons: [
          { src: `${BASE}icon-192.png`, sizes: "192x192", type: "image/png" },
          { src: `${BASE}icon-512.png`, sizes: "512x512", type: "image/png" },
          {
            src: `${BASE}icon-maskable-512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // App shell only. Decode results are cached in Dexie, never in the SW,
        // so vPIC is network-only (§9-S0).
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Precache entries themselves are relative to the service worker's own
        // location, so they land under the sub-path with no help. This one is a
        // lookup key handed to `createHandlerBoundToURL`, so it is written out in
        // full to match the entry it has to find.
        navigateFallback: `${BASE}index.html`,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/vpic\.nhtsa\.dot\.gov\/.*/i,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
    nojekyll(),
  ],
});
