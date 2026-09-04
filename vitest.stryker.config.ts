import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// A23 (§13.5). Used ONLY by `bun run mutate` (stryker.config.json -> vitest.configFile).
// `bun run test` and `bun run test:coverage` keep using vitest.config.ts untouched.
//
// Why it exists: Stryker instruments every mutated file with a coverage call at each
// mutant site. src/lib/vin/extractVin.ts calls expectedCheckDigit once per 17-char
// window, so instrumenting checkDigit.ts adds ~1.7M coverage calls to
// extractVin.adversary.test.ts's 100_000-char input. Measured: that test runs in 635 ms
// uninstrumented and >5000 ms with checkDigit.ts instrumented, so vitest's default 5 s
// testTimeout fails the Stryker dry run and no mutation score can be produced at all.
//
// Raising the per-test clock removes vitest as the adjudicator of hangs and leaves that
// job to Stryker's own timeoutMS/timeoutFactor, which is what reports a mutant as
// "Timeout" instead of silently folding it into "Killed". Nothing else is changed: same
// include globs, same setup file, same environment, same assertions.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);
