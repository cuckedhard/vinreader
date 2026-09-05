import { defineConfig } from "vitest/config";
import { buildYear } from "./scripts/build-year";

export default defineConfig({
  // The app reads §4.4 step 0's floor from this (`currentYear` in `src/lib/storage/db.ts`),
  // so the unit tests have to be given the same value the two vite builds inject.
  define: { __BUILD_YEAR__: buildYear() },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/lib/storage/test-setup.ts"],
    coverage: {
      provider: "v8",
      // scanMachine is pure policy and carries the §6.3 rules, so it is gated like src/lib.
      include: ["src/lib/**/*.ts", "src/features/scan/scanMachine.ts"],
      exclude: [
        "src/lib/**/*.test.ts",
        "src/lib/**/test-setup.ts",
        "src/lib/vin/types.ts",
        // R4-D: test-only helpers live under src/ so vitest collects them, but they are
        // not production source and must not pad the §13.5 denominator.
        "src/lib/**/*.testutil.ts",
      ],
      // §13.5 gates on these numbers, and a hardening round is read in exactly the state
      // where a failing test would otherwise suppress the whole report: a red tree.
      reportOnFailure: true,
      // §13.5 gate.
      thresholds: {
        lines: 95,
        branches: 95,
        "src/lib/vin/checkDigit.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/vin/modelYear.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/lib/vin/extractVin.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
        "src/features/scan/scanMachine.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        "src/lib/payload/codec.ts": { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
});
