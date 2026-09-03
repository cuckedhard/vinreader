import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "https://localhost:4173",
    trace: "off",
    // The dev certificate from @vitejs/plugin-basic-ssl is self-signed (§2).
    ignoreHTTPSErrors: true,
    // Use the Chromium already on the machine rather than downloading one.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    // Build first: `vite preview` serves dist/, so without this the suite silently
    // tests whatever was built last.
    command: "bun run build && npx vite preview --port 4173 --strictPort",
    url: "https://localhost:4173",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
