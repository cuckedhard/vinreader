import type { ReactNode } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "../ui/Button";
import { swRegisterOptions } from "./registerSW";

interface BarProps {
  message: string;
  onDismiss: () => void;
  action?: ReactNode;
}

/**
 * Sits in the Shell's column flow directly above the bottom nav, so it never
 * covers the row a user is reading and needs no offset from the nav's height.
 */
function Bar({ message, onDismiss, action }: BarProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-t border-border bg-bg-elev px-4 py-3"
    >
      <p className="text-base font-semibold text-fg">{message}</p>
      {/* N5: full-width targets, no gesture, nothing hover-only. */}
      <div className="mt-3 flex gap-3">
        <Button variant="secondary" full onClick={onDismiss}>
          Dismiss
        </Button>
        {action}
      </div>
    </div>
  );
}

/**
 * §9-S0: the app never reloads itself. A waiting worker sits behind this bar
 * until the user taps Reload, because a reload mid-scan loses the read.
 */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW(swRegisterOptions);

  if (needRefresh) {
    return (
      <Bar
        message="Update available"
        onDismiss={() => {
          setNeedRefresh(false);
          // Clearing both keeps a stale install note from surfacing behind this one.
          setOfflineReady(false);
        }}
        action={
          <Button full onClick={() => void updateServiceWorker(true)}>
            Reload
          </Button>
        }
      />
    );
  }

  if (offlineReady) {
    return <Bar message="Ready to work offline" onDismiss={() => setOfflineReady(false)} />;
  }

  return null;
}
