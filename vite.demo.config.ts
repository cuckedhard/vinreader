/**
 * Single-file demo build (Claude Artifact target).
 *
 * The published artifact is one HTML file served from a sandboxed iframe with a CSP that
 * blocks every external subresource, so the build has to emit exactly one JS chunk and one
 * CSS file for `scripts/build-demo.ts` to inline. Nothing here is part of the shipping
 * app: `vite.config.ts` is the real build and is imported unchanged below.
 *
 * Three deviations from the real build, each forced by the host:
 *
 * 1. **No service worker.** A sandboxed frame cannot register one. `vite.config.ts`
 *    already honours `PWA_DISABLED=1`, so this sets it rather than restating the plugin —
 *    with the plugin disabled, `virtual:pwa-register/react` still resolves, to the no-op
 *    stub the plugin ships for exactly this case, and `UpdateToast` renders nothing.
 *    The env var is set before the dynamic `import()` below, which is why the config is a
 *    function: a static import is hoisted above the assignment and would read it too late.
 *
 * 2. **No code splitting.** `output.codeSplitting: false` folds the two lazy boundaries — the
 *    Account screen (`src/app/router.tsx`) and the sync engine (`src/main.tsx`), which
 *    pulls in the ~214 kB `@supabase/supabase-js` — back into the entry chunk. Both are
 *    lazy on purpose in the real build (N7: the scanner never waits on auth) and both
 *    still work once inlined, because `getSupabase()` returns `null` with no
 *    `VITE_SUPABASE_*` set instead of throwing. `cssCodeSplit: false` does the same for
 *    CSS, and `modulePreload: false` keeps the emitted HTML from carrying preload links
 *    to a chunk that will no longer exist by the time the file is inlined.
 *
 * 3. **`base: "./"`** so the emitted `index.html` references its assets relatively; the
 *    inliner then resolves them against `dist-demo/` rather than against a server root.
 */
import { defineConfig, mergeConfig } from "vite";
import type { UserConfig } from "vite";

// Set before `vite.config.ts` is evaluated (see note 1 above). Also set by the
// `demo:build` npm script, so a direct `vite build -c vite.demo.config.ts` behaves the
// same as the scripted one.
process.env.PWA_DISABLED = "1";

export default defineConfig(async (): Promise<UserConfig> => {
  // Extensionless on purpose: `./vite.config.ts` is what Vite's native config loader wants
  // and what `tsc` rejects outright without `allowImportingTsExtensions`, which is off for
  // the whole repo. Vite resolves this fine and only warns; `scripts/build-demo.ts` sets
  // `VITE_CONFIG_NATIVE_IGNORE_WARNING` so the warning does not read as a build problem.
  const base = (await import("./vite.config")) as { default: UserConfig };

  return mergeConfig(base.default, {
    base: "./",
    build: {
      outDir: "dist-demo",
      emptyOutDir: true,
      cssCodeSplit: false,
      modulePreload: false,
      // Everything is inlined by hand afterwards, so leave the emitted assets on disk as
      // real files: the inliner needs to read them, and a build-time data: URI would only
      // have to be decoded again.
      assetsInlineLimit: 0,
      // No source map can be shipped inside the CSP, so leave Vite 8's default minifier
      // (oxc) alone rather than naming one — `minify: "esbuild"` fails outright here,
      // because Vite 8 no longer bundles esbuild and nothing else in the repo installs it.
      sourcemap: false,
      rollupOptions: {
        output: {
          // Rolldown's spelling. `inlineDynamicImports` still works but warns as
          // deprecated, and this is the option that actually collapses the graph.
          codeSplitting: false,
          entryFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  } satisfies UserConfig);
});
