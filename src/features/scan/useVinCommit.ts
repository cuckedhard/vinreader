/**
 * The one place a VIN becomes a record. Both entry paths — the camera (§6.3) and the
 * keyboard — run through here, so the D03 gate, the §5.3 upsert and the hop to the Sheet
 * cannot drift apart.
 */
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { checkDigitApplies } from "../../lib/vin/checkDigit";
import { kickDecodeQueue } from "../../lib/storage/decodeQueue";
import { getSettings } from "../../lib/storage/settings";
import { upsertVehicle } from "../../lib/storage/upsert";
import { errorLine } from "../../app/errorLine";
import type { ExtractResult, Symbology } from "../../lib/vin/types";

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
  useAsIs: () => Promise<boolean>;
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
        // N1: a settings read that fails must not fail the save — the event then carries
        // no label, and §5.4's poll still picks the decode up.
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
          // §6.4 prints this underneath "Couldn't save this VIN", so it is shaped for a
          // person rather than passed through raw: Dexie's message already restates itself
          // and carries a newline, which reached the screen as one sentence twice (R3-F4).
          setError(errorLine(cause));
          setPending(null);
          setSaving(false);
          return false;
        }
        // §5.3: the save kicks the queue so the sheet fills in without waiting for the
        // §5.4 poll. The kick reads §5.6's `autoDecode` and swallows its own failures.
        void kickDecodeQueue();
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

  // Reports success like `request` does, so the caller can hold the §6.3 cooldown back
  // until the record actually exists.
  const useAsIs = useCallback(async (): Promise<boolean> => {
    const meta = metaRef.current;
    if (pending === null || meta === null) return false;
    // The second activation is turned away inside `write`, on the ref: this callback and
    // its `saving` are a render behind the tap that started the first one.
    return await write(pending, meta);
  }, [pending, write]);

  const dismiss = useCallback(() => {
    metaRef.current = null;
    setPending(null);
    setError(null);
  }, []);

  return { pending, saving, error, request, useAsIs, dismiss };
}
