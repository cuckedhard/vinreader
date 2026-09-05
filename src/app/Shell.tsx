import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { BottomNav } from "./nav";
import { ErrorBoundary, FailureNotice } from "./ErrorBoundary";
import { UpdateToast } from "../pwa/UpdateToast";
import { db } from "../lib/storage/db";
import { normalizeSettings } from "../lib/storage/settings";
import { startDecodeQueue } from "../lib/storage/decodeQueue";
import { seedWmiCache } from "../lib/storage/wmiCache";
import { applyTheme } from "../ui/theme";

/**
 * §6.1's theme. The shell owns it because the palette belongs to the whole app, not to
 * the screen that happens to change it, and a live query means a change on Settings
 * repaints every route at once. Settings seeds the row, so a missing one here is a first
 * run reading the default rather than a write.
 *
 * `?? null` is what separates "no row" from "no answer yet": `useLiveQuery` returns
 * `undefined` for both, and applying the default while Dexie is still answering would
 * repaint dark over whatever index.html's pre-paint bootstrap had already put up — the
 * flash it exists to remove, one frame later and now visible. Undefined therefore means
 * "still asking" and nothing is applied; `null` means the row is genuinely absent.
 *
 * It is a component of its own so that the boundary around it can be this small: a
 * storage failure here costs the *preference* and nothing else — index.html has already
 * painted §6.1's default — where the same throw from inside `Shell` would take the nav,
 * the outlet and the whole app with it.
 */
function ThemeSync() {
  const stored = useLiveQuery(async () => (await db.settings.get("settings")) ?? null);
  const theme = stored === undefined ? null : normalizeSettings(stored ?? undefined).theme;
  useEffect(() => {
    if (theme === null) return;
    return applyTheme(theme);
  }, [theme]);
  return null;
}

export function Shell() {
  // §5.4: pending decodes are retried on app start, on `online`, and on a poll while
  // visible. The shell owns it because the queue must run wherever the user is — a
  // scan saved offline fills in even if they never open its sheet again (N1).
  useEffect(() => startDecodeQueue(), []);

  // §5.5: the `wmi` cache is "seeded from `wmi-seed.json` on first run". Same owner as
  // the queue and the same reason — it belongs to the app's lifetime, not to a screen.
  // Nothing waits on it: a failure costs the coarse §4.5 manufacturer line on records
  // scanned before a decode names their WMI, and no scan is blocked by it (N1, P1).
  useEffect(() => {
    void seedWmiCache().catch((cause: unknown) => {
      console.error("VIN Relay: WMI seed failed", cause);
    });
  }, []);

  // The key remounts the boundary on every navigation, so a screen that threw does not
  // leave its notice standing over the next one — without it, a failed History would make
  // Scan unreachable, which is the N1/P1 floor this boundary exists to hold.
  const { pathname } = useLocation();

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <ErrorBoundary fallback={() => null}>
        <ThemeSync />
      </ErrorBoundary>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary key={pathname} fallback={(error) => <FailureNotice error={error} />}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <UpdateToast />
      <BottomNav />
    </div>
  );
}
