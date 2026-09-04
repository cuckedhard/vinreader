import { useEffect } from "react";
import { Outlet } from "react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { BottomNav } from "./nav";
import { UpdateToast } from "../pwa/UpdateToast";
import { db } from "../lib/storage/db";
import { normalizeSettings } from "../lib/storage/settings";
import { startDecodeQueue } from "../lib/storage/decodeQueue";
import { applyTheme } from "../ui/theme";

export function Shell() {
  // §5.4: pending decodes are retried on app start, on `online`, and on a poll while
  // visible. The shell owns it because the queue must run wherever the user is — a
  // scan saved offline fills in even if they never open its sheet again (N1).
  useEffect(() => startDecodeQueue(), []);

  // §6.1's theme. The shell owns it for the same reason: the palette belongs to the
  // whole app, not to the screen that happens to change it, and a live query means a
  // change on Settings repaints every route at once. Settings seeds the row, so a
  // missing one here is a first run reading the default rather than a write.
  //
  // `?? null` is what separates "no row" from "no answer yet": `useLiveQuery` returns
  // `undefined` for both, and applying the default while Dexie is still answering would
  // repaint dark over whatever index.html's pre-paint bootstrap had already put up — the
  // flash it exists to remove, one frame later and now visible. Undefined therefore means
  // "still asking" and nothing is applied; `null` means the row is genuinely absent.
  const stored = useLiveQuery(async () => (await db.settings.get("settings")) ?? null);
  const theme = stored === undefined ? null : normalizeSettings(stored ?? undefined).theme;
  useEffect(() => {
    if (theme === null) return;
    return applyTheme(theme);
  }, [theme]);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <UpdateToast />
      <BottomNav />
    </div>
  );
}
