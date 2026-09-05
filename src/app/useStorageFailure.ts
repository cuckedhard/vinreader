import { useEffect, useState } from "react";
import { probeStorage } from "../lib/storage/availability";

/**
 * The storage-availability signal F1-b asks for, as one line of wiring around
 * `probeStorage` (the rule lives there, testable without a DOM).
 *
 * `null` until the database has been asked, and after it opened; otherwise the reason it
 * did not, wrapped so that a failure carrying no reason is still a failure. Screens whose
 * live query would otherwise never answer — the Sheet, and History — render `FailureNotice`
 * with it instead of an empty frame (§6.4, P7).
 *
 * Not hoisted into `Shell` above the outlet: storage being gone must cost the screens that
 * read storage and nothing else. Scan and its keyboard path work without it, and N1/P1 say
 * a scan is never blocked, so a notice that replaced the whole outlet would be a worse bug
 * than the one it fixes.
 */
export function useStorageFailure(): { readonly cause: unknown } | null {
  const [failure, setFailure] = useState<{ readonly cause: unknown } | null>(null);

  useEffect(() => {
    let live = true;
    void probeStorage().then((probe) => {
      if (live && !probe.ok) setFailure({ cause: probe.cause });
    });
    return () => {
      live = false;
    };
  }, []);

  return failure;
}
