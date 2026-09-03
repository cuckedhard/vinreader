import { Outlet } from "react-router";
import { BottomNav } from "./nav";
import { UpdateToast } from "../pwa/UpdateToast";

export function Shell() {
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
