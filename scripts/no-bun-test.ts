throw new Error(
  "Use `bun run test` (Vitest), not `bun test`. Bun's runner ignores vitest.config.ts " +
    "and reports no branch coverage, so it cannot enforce the §13.5 gate.",
);
