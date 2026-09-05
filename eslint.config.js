import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "dist-demo",
      "docs",
      "dev-dist",
      "coverage",
      "node_modules",
      ".stryker-tmp",
      "reports",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
  },
  {
    // P3: the pure core has no DOM, no React, no I/O.
    files: ["src/lib/vin/**/*.ts", "src/lib/payload/**/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: "P3: src/lib/vin and src/lib/payload stay pure." },
        { name: "document", message: "P3: src/lib/vin and src/lib/payload stay pure." },
        { name: "fetch", message: "P3: src/lib/vin and src/lib/payload stay pure." },
        { name: "localStorage", message: "P3: src/lib/vin and src/lib/payload stay pure." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "P3: take the current year as an argument (§4.4).",
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "P3: take the current year as an argument (§4.4).",
        },
      ],
    },
  },
  // Node contexts: build scripts, the bench generators, and Playwright specs, which run
  // in node rather than in the page.
  {
    files: ["scripts/**/*.ts", "bench/**/*.{ts,mjs,js}", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
