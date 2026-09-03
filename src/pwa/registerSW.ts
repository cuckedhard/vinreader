/**
 * Service worker policy. The one and only registration is performed by
 * `useRegisterSW` inside `UpdateToast`; this module holds the options that
 * registration is handed, so the policy lives in one place instead of inside JSX.
 *
 * §9-S0: `registerType: "prompt"`. Nothing here activates a waiting worker or
 * reloads the page — that happens only when the user taps Reload on the toast.
 */
import type { RegisterSWOptions } from "virtual:pwa-register/react";

/** An installed PWA can stay open for days in the field, so re-check on a timer. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const swRegisterOptions: RegisterSWOptions = {
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    setInterval(() => {
      // Backgrounded or offline, the check would only fail; the next tick gets it.
      if (!navigator.onLine || document.visibilityState !== "visible") return;
      void registration.update().catch(() => {});
    }, UPDATE_CHECK_INTERVAL_MS);
  },
};
