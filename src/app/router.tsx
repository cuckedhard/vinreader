import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./Shell";
import { defaultRoutePath, isWideViewport } from "./viewport";
import ScanScreen from "../features/scan/ScanScreen";
import SheetScreen from "../features/sheet/SheetScreen";
import PaintCaptureScreen from "../features/paint/PaintCaptureScreen";
import HistoryScreen from "../features/history/HistoryScreen";
import SettingsScreen from "../features/settings/SettingsScreen";
import ImportScreen from "../features/import/ImportScreen";

/**
 * §6.2's Account screen, split out of the first-paint bundle.
 *
 * It is the only screen that reaches `@supabase/supabase-js`, and a scanner standing next
 * to a truck on one bar of signal must not download an auth client before the camera can
 * start (N7: signing in is optional and never a gate). Every chunk is precached by the
 * service worker (§9-S0 `globPatterns`), so this stays available offline like the rest.
 */
const AccountScreen = lazy(() => import("../features/account/AccountScreen"));

/**
 * §6.6: History is the default route at ≥ 900 px, Scan below it.
 *
 * The width is sampled here, once, as this element renders — the moment the user lands on
 * `/` with no route of their own. It is not watched: `viewport.ts` explains why a resize
 * must never move anybody, and this component has already redirected by the time one could.
 */
function DefaultRoute() {
  return <Navigate to={defaultRoutePath(isWideViewport())} replace />;
}

/** Hash routes keep the app trivially static-hostable and keep handoff
 *  payloads out of server logs (§2, §6.2). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<DefaultRoute />} />
        <Route path="scan" element={<ScanScreen />} />
        <Route path="v/:vin" element={<SheetScreen />} />
        {/* §6.2 (S5 layer 2). A pushed screen off the Sheet with its own camera session —
            never a second decoder on the ZXing stream (N1/P1). */}
        <Route path="v/:vin/paint" element={<PaintCaptureScreen />} />
        <Route path="history" element={<HistoryScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        {/* §6.2 handoff receiver: `/#/i?d=<base64url>` from a QR or a link. */}
        <Route path="i" element={<ImportScreen />} />
        {/* §6.2 (S4). A pushed screen, not a nav tab — the bottom nav is Scan · History ·
            Settings and this slice does not widen it. */}
        <Route
          path="account"
          element={
            <Suspense
              fallback={
                <p className="p-4 text-base text-fg-muted" role="status">
                  Loading…
                </p>
              }
            >
              <AccountScreen />
            </Suspense>
          }
        />
        {/* An unknown route has no destination of its own, so it lands on the same default
            the width chooses rather than pinning one screen for every device. */}
        <Route path="*" element={<DefaultRoute />} />
      </Route>
    </Routes>
  );
}
