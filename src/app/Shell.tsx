import { useEffect } from "react";
import { Outlet } from "react-router";
import { BottomNav } from "./nav";
import { UpdateToast } from "../pwa/UpdateToast";
import { startDecodeQueue } from "../lib/storage/decodeQueue";

export function Shell() {
  // §5.4: pending decodes are retried on app start, on `online`, and on a poll while
  // visible. The shell owns it because the queue must run wherever the user is — a
  // scan saved offline fills in even if they never open its sheet again (N1).
  useEffect(() => startDecodeQueue(), []);

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
