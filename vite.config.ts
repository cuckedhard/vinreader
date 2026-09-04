import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

// HTTPS in dev is required for camera (S1) and share (S3) on a real phone (N4).
// See README.md for the basic-ssl and tunnel options.
/**
 * A build stamp the device matrix (§7 item 4) can read off a phone: which commit is
 * actually installed. `import.meta.env.MODE` only ever says "production", and a
 * hand-written slice number goes stale, which is what it replaced.
 */
function buildStamp(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()) },
  plugins: [
    react(),
    tailwindcss(),
    basicSsl(),
    VitePWA({
      // A service worker cannot register from a sandboxed preview frame, so the
      // single-file demo build turns it off rather than crashing on load.
      disable: process.env.PWA_DISABLED === "1",
      registerType: "prompt", // never auto-reload: a reload mid-scan is unacceptable (§9-S0)
      includeAssets: ["favicon.svg"],
      manifest: {
        // `id` is fixed and does not track the display name, so a rename does not
        // re-identify the installed PWA (S0_DECISIONS.md D01).
        id: "/",
        name: "VIN Relay",
        short_name: "VIN Relay",
        description: "Scan, decode and hand off vehicle VINs. Works offline.",
        start_url: "/#/scan",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#0b0f14",
        theme_color: "#0b0f14",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-maskable-512.png",
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
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/vpic\.nhtsa\.dot\.gov\/.*/i,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
});
