import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "./index.css";
import { AppRoutes } from "./app/router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  </StrictMode>,
);

/**
 * Runs `task` once the browser is done with the work that puts pixels on screen.
 * `requestIdleCallback` where it exists (Safari has it from 15.4), a macrotask elsewhere;
 * the 2 s timeout keeps a permanently busy tab from starving it forever.
 */
function afterFirstPaint(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => task(), { timeout: 2000 });
    return;
  }
  setTimeout(task, 0);
}

/**
 * §4.12 pulls on app start, so the engine starts here — the one place that owns the app's
 * lifetime rather than a screen's.
 *
 * Two things keep it off the critical path, and both matter to someone standing in front of
 * a truck. It is **imported dynamically**, so `@supabase/supabase-js` and the auth client
 * are a separate chunk that the scanner never waits on (the route for the only screen that
 * needs them is lazy for the same reason). And it is **started after the first paint**,
 * because `startAppSync` builds the client and kicks a cycle synchronously up to its first
 * await — cheap, but not free, and nothing about sync is worth a frame of the camera.
 *
 * Harmless when unconfigured: with no `VITE_SUPABASE_*` the engine's own cycle finds no
 * client, makes no request, and settles on `signed_out` — which is the state the §6.4 chip
 * renders as nothing at all.
 */
afterFirstPaint(() => {
  void import("./lib/sync/authBridge")
    .then(({ startAppSync }) => {
      startAppSync();
    })
    .catch((cause: unknown) => {
      // P7: loud in the log, and visible in the UI as the sync chip staying hidden — with
      // no engine there is no sync state to claim. Everything else on the device is local
      // and unaffected (N7, P1).
      console.error("VIN Relay: sync engine failed to start", cause);
    });
});
