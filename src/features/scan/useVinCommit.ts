/**
 * The one place a VIN becomes a record. Both entry paths — the camera (§6.3) and the
 * keyboard — run through here, so the D03 gate, the §5.3 upsert and the hop to the Sheet
 * cannot drift apart.
 */
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { checkDigitApplies } from "../../lib/vin/checkDigit";
import { upsertVehicle } from "../../lib/storage/upsert";
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

  const write = useCallback(
    async (candidate: ExtractResult, meta: VinCommitMeta): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        await upsertVehicle({
          vin: candidate.vin,
          origin: meta.origin,
          symbology: meta.symbology,
          raw: candidate.raw,
          checkDigitValid: candidate.checkDigitValid,
        });
      } catch (cause) {
        // P7: the write is the one thing here that can fail, and it never fails quietly.
        setError(cause instanceof Error ? cause.message : String(cause));
        setPending(null);
        setSaving(false);
        return false;
      }
      // `saving` and `pending` are left standing on purpose: the navigation unmounts the
      // caller, and resetting them first flashes the pre-save controls for a frame.
      navigate(`/v/${candidate.vin}`);
      return true;
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
    if (pending === null || meta === null || saving) return;
    await write(pending, meta);
  }, [pending, saving, write]);

  const dismiss = useCallback(() => {
    metaRef.current = null;
    setPending(null);
    setError(null);
  }, []);

  return { pending, saving, error, request, useAsIs, dismiss };
}
