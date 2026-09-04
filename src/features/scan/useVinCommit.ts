/**
 * The one place a VIN becomes a record. Both entry paths — the camera (§6.3) and the
 * keyboard — run through here, so the D03 gate, the §5.3 upsert and the hop to the Sheet
 * cannot drift apart.
 */
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { checkDigitApplies } from "../../lib/vin/checkDigit";
import { runDecodeQueueOnce } from "../../lib/storage/decodeQueue";
import { getSettings } from "../../lib/storage/settings";
import { upsertVehicle } from "../../lib/storage/upsert";
import type { ExtractResult, Symbology } from "../../lib/vin/types";

/**
 * §5.3: a save on signal kicks the decode straight away, so the sheet fills in without
 * waiting for the §5.4 poll. It kicks the *queue* rather than this one VIN because the
 * queue honours §4.7's one-request-per-VIN rule — re-scanning an already-decoded VIN
 * must not go back to the network. N1: the caller never awaits this, and a failure is
 * swallowed because §5.4 retries.
 */
async function kickDecode(autoDecode: boolean): Promise<void> {
  try {
    if (!autoDecode || !navigator.onLine) return;
    await runDecodeQueueOnce();
  } catch {
    // A decode never surfaces as a save error; the scan is already stored.
  }
}

export interface VinCommitMeta {
  origin: "scan" | "manual";
  symbology: Symbology;
}

export interface VinCommitApi {
  /** A read held back by D03: displayed, never written, until the user decides. */
  pending: ExtractResult | null;
  saving: boolean;
  error: string | null;
  /** Resolves true when the record was written, false when nothing was. */
  request: (candidate: ExtractResult, meta: VinCommitMeta) => Promise<boolean>;
  useAsIs: () => Promise<void>;
  dismiss: () => void;
}

export function useVinCommit(): VinCommitApi {
  const navigate = useNavigate();
  const [pending, setPending] = useState<ExtractResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The held read's provenance. A ref, not state: nothing renders it, and it must survive
  // alongside `pending` so Use as-is writes the symbology the read actually came from.
  const metaRef = useRef<VinCommitMeta | null>(null);
  // Held across renders because a write in flight is not something the screen draws.
  const writingRef = useRef(false);

  const write = useCallback(
    async (candidate: ExtractResult, meta: VinCommitMeta): Promise<boolean> => {
      // The re-entrancy guard has to be a ref, not `saving`: a handler closes over the
      // rendered value, so two taps a frame apart both read `false` and both write — two
      // §5.2 events for one decision on an append-only log. Set before the first await.
      if (writingRef.current) return false;
      writingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        // One settings read serves both the §5.2 `deviceLabel` and the auto-decode check
        // below. N1: a settings read that fails must not fail the save — the event then
        // carries no label, and §5.4's poll still picks the decode up.
        const settings = await getSettings().catch(() => null);
        try {
          await upsertVehicle({
            vin: candidate.vin,
            origin: meta.origin,
            symbology: meta.symbology,
            raw: candidate.raw,
            checkDigitValid: candidate.checkDigitValid,
            // §5.6 keeps the label as typed; §5.2 stores a label or nothing.
            deviceLabel: (settings?.deviceLabel ?? "").trim() || null,
          });
        } catch (cause) {
          // P7: the write is the one thing here that can fail, and it never fails quietly.
          setError(cause instanceof Error ? cause.message : String(cause));
          setPending(null);
          setSaving(false);
          return false;
        }
        void kickDecode(settings?.autoDecode === true);
        // `saving` and `pending` are left standing on purpose: the navigation unmounts the
        // caller, and resetting them first flashes the pre-save controls for a frame.
        navigate(`/v/${candidate.vin}`);
        return true;
      } finally {
        writingRef.current = false;
      }
    },
    [navigate],
  );

  const request = useCallback(
    async (candidate: ExtractResult, meta: VinCommitMeta): Promise<boolean> => {
      // D03: where the check digit means something, a mismatch holds the write behind an
      // explicit choice — no vehicle row and no scan event exist until Use as-is (§6.3).
      if (!candidate.checkDigitValid && checkDigitApplies(candidate.vin)) {
        metaRef.current = meta;
        setPending(candidate);
        return false;
      }
      return write(candidate, meta);
    },
    [write],
  );

  const useAsIs = useCallback(async (): Promise<void> => {
    const meta = metaRef.current;
    if (pending === null || meta === null) return;
    // The second activation is turned away inside `write`, on the ref: this callback and
    // its `saving` are a render behind the tap that started the first one.
    await write(pending, meta);
  }, [pending, write]);

  const dismiss = useCallback(() => {
    metaRef.current = null;
    setPending(null);
    setError(null);
  }, []);

  return { pending, saving, error, request, useAsIs, dismiss };
}
