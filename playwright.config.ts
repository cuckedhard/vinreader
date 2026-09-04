import { defineConfig, devices } from "@playwright/test";

/**
 * §7 item 4's matrix names Android Chrome, and §9-S1's performance target is a mid-range
 * Android phone. These projects run the whole suite under Chromium emulating two real
 * Android profiles — a current Pixel and the narrowest modern Samsung, which is the one
 * that stresses §6.1's 48/56 px targets. `bun run test:e2e` stays on `desktop` so the
 * §13.5 inner loop is not tripled; `bun run test:e2e:android` runs the other two.
 *
 * This emulates the surface — viewport, device scale factor, touch, user agent — and not
 * the engine. A real Android Chrome is still §13.7's to verify, and passing here is not
 * that pass.
 */
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  projects: [
    { name: "desktop", use: { launchOptions: launch } },
    { name: "pixel-7", use: { ...devices["Pixel 7"], launchOptions: launch } },
    { name: "galaxy-s9", use: { ...devices["Galaxy S9+"], launchOptions: launch } },
  ],
  use: {
    baseURL: "https://localhost:4173",
    trace: "off",
    // The dev certificate from @vitejs/plugin-basic-ssl is self-signed (§2).
    ignoreHTTPSErrors: true,
    // Use the Chromium already on the machine rather than downloading one.
    launchOptions: launch,
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
