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

/**
 * §6.1's light theme, which until this project existed no test in the gate had ever rendered.
 * One small spec rather than a second pass over all 37: the palette is app-wide, so a handful
 * of screens carrying banners, chips and a focus ring catch a regression that running the
 * whole suite twice would only catch more slowly.
 *
 * `colorScheme: "light"` is the OS preference, not the app's setting — the spec sets the §5.6
 * row itself. It matters for the third state: "System" only means anything when the OS has an
 * answer, and light is the one the dark default disagrees with.
 */
const LIGHT_SPEC = /light-theme\.spec\.ts/;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  projects: [
    { name: "light", testMatch: LIGHT_SPEC, use: { colorScheme: "light", launchOptions: launch } },
    // `dependencies` is what puts the light guard inside the gate: §13.5 runs `bun run test:e2e`,
    // which is `--project=desktop`, and Playwright runs a project's dependencies with it. The
    // cost is that a red light run skips desktop instead of running it alongside — the cleaner
    // arrangement is for `test:e2e` to name both projects and for this edge to go, but that is
    // package.json's line to change.
    {
      name: "desktop",
      testIgnore: LIGHT_SPEC,
      dependencies: ["light"],
      use: { launchOptions: launch },
    },
    // The Android profiles exist for §6.1's target sizes, which the light spec does not measure,
    // so they skip it rather than paying for it twice.
    {
      name: "pixel-7",
      testIgnore: LIGHT_SPEC,
      use: { ...devices["Pixel 7"], launchOptions: launch },
    },
    {
      name: "galaxy-s9",
      testIgnore: LIGHT_SPEC,
      use: { ...devices["Galaxy S9+"], launchOptions: launch },
    },
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
