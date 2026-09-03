import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/lib/storage/test-setup.ts"],
    coverage: {
      provider: "v8",
      // scanMachine is pure policy and carries the §6.3 rules, so it is gated like src/lib.
      include: ["src/lib/**/*.ts", "src/features/scan/scanMachine.ts"],
      exclude: ["src/lib/**/*.test.ts", "src/lib/**/test-setup.ts", "src/lib/vin/types.ts"],
      // §13.5 gate. codec.ts joins the 100% list in S3.
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
      },
    },
  },
});
