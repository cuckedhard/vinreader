/**
 * §9-S4's delete: a soft delete that propagates, and the two states the Sheet shows around it.
 *
 * **It is a tombstone, not a removal** (§4.12). `softDeleteVehicle` stamps `deletedAt` and
 * queues the `vehicle_delete` outbox row in one transaction, and any later scan event clears
 * the tombstone on both sides. So nothing here says "permanently", "can't be undone", or asks
 * anyone to type `DELETE`: §6.4 gives that sentence and that typed word to *"Delete cloud
 * data / account"*, the two actions that really are irreversible, and spending them on an
 * action a rescan reverses is how a confirmation stops meaning anything.
 *
 * **What it borrows from Settings' "Clear all data" is the shape, not the ceremony.** There,
 * a destructive button is inert until a second, deliberate act arms it, and the copy states
 * exactly what goes and what does not. Both hold here — the first tap arms, the second
 * deletes — and the second act is a tap rather than six typed characters because this delete
 * is reversible and because the person tapping it may be wearing gloves (N5). The armed panel
 * is the app's existing shape for a consequential either/or: §6.3's check-digit banner, with
 * the vehicle named in it so the wrong one cannot be deleted from the bottom of a long sheet.
 *
 * §6.4 has no microcopy for any of this. Every string below is supplied under §0 rule 4 and
 * exported so the session report can list it and `harden` can find it in one place.
 */
import { useEffect, useRef, useState } from "react";
import { softDeleteVehicle } from "../../lib/storage/upsert";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { VinDisplay } from "../../ui/VinDisplay";

const LABEL = "text-sm font-bold tracking-wide text-fg-muted uppercase";

/* --------------------------------------------------------------- supplied (§0 rule 4) */

export const DELETE_TITLE = "Remove this vehicle";

/**
 * Two facts, in the order they matter: where it goes, and that it comes back. "when you're
 * signed in" rather than "on your other devices" flat, because signed out there are no other
 * devices and the sentence would be describing an account the user does not have (N2).
 */
export const DELETE_BODY =
  "Takes it out of your history on this device, and on your other devices when you're signed " +
  "in. Scanning or importing this VIN again brings it back.";

/** One word for both taps: the second is the same action, with its subject named above it. */
export const DELETE_ACTION = "Delete";
export const DELETE_BUSY = "Deleting…";

export const DELETE_CONFIRM_TITLE = "Delete this vehicle?";
export const DELETE_CANCEL = "Cancel";

/** P7: the failure is said out loud, and it says what is still true. */
export const DELETE_FAILED_TITLE = "Couldn't delete this vehicle";
export const DELETE_FAILED_BODY = "It's still in your history. Tap Delete to try again.";

export const DELETED_TITLE = "Vehicle deleted";
export const DELETED_BODY =
  "It's out of your history. Scanning or importing this VIN again brings it back.";
export const DELETED_BACK = "Back to History";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface DeleteConfirmProps {
  vin: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The armed state, presentational so its copy is pinned by a test that needs no DOM.
 *
 * `Banner` gives every action a ≥ 48 px target (§6.1), and Cancel comes second only in
 * reading order — it is the same size as Delete, because the escape from a destructive
 * confirmation must never be the harder tap to hit.
 */
export function DeleteConfirm({ vin, busy, onConfirm, onCancel }: DeleteConfirmProps) {
  return (
    <Banner
      tone="danger"
      title={DELETE_CONFIRM_TITLE}
      actions={
        <>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? DELETE_BUSY : DELETE_ACTION}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {DELETE_CANCEL}
          </Button>
        </>
      }
    >
      <VinDisplay vin={vin} size="md" className="break-all" />
    </Banner>
  );
}

export interface DeletedNoticeProps {
  vin: string;
  /** Omitted inside §6.6's pane, which has its own Close and no route to leave. */
  onBack?: () => void;
}

/**
 * What the Sheet shows once `deletedAt` is set — whether this device set it a second ago or
 * another device's delete arrived through §4.12's pull.
 *
 * It replaces the sheet rather than the screen falling back to *"No record for this VIN"*:
 * a tombstone and a VIN this device has never seen are different facts, and only one of them
 * is undone by scanning the label again (N2).
 */
export function DeletedNotice({ vin, onBack }: DeletedNoticeProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <VinDisplay vin={vin} size="lg" className="break-all" />
      <Banner tone="ok" title={DELETED_TITLE}>
        {DELETED_BODY}
      </Banner>
      {onBack ? (
        <Button variant="primary" full onClick={onBack}>
          {DELETED_BACK}
        </Button>
      ) : null}
    </div>
  );
}

export interface DeleteVehicleProps {
  vin: string;
  /** Lets a host — §6.6's pane — react to a delete it did not initiate. */
  onDeleted?: (vin: string) => void;
}

export function DeleteVehicle({ vin, onDeleted }: DeleteVehicleProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  // §6.2 puts Delete last, on a sheet that runs ~1955 px on a phone, so the tap that arms
  // it comes from the bottom of the scroll by definition — and the panel is taller than the
  // 56 px button it replaces, so it opened past the fold: 1.75 of 48 px of Delete and of
  // Cancel visible at 390×844, none at all at 320×658, and `elementFromPoint` at both
  // centres returning the bottom nav, which is where the confirming second tap of a
  // destructive flow landed instead. §6.4 gives the panel one job — to be read, with the
  // VIN in it, before that tap — and it cannot do it off screen.
  //
  // `block: "nearest"` scrolls the least it can and does nothing when the panel is already
  // whole, so a sheet short enough to fit does not move under the user's thumb. Nothing is
  // animated (§6.1 is a gloved, one-handed screen; the scroll is instant and the panel is
  // `role="alert"`, so it is announced as well as shown).
  useEffect(() => {
    if (!armed) return;
    confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [armed]);

  function remove(): void {
    if (busy) return;
    setBusy(true);
    setError(null);
    // §9-S4: `softDeleteVehicle` is the one delete path. It stamps the tombstone and queues
    // the §5.7 row in a single transaction, so a second path here could only queue a delete
    // that never happened locally, or hide a row the account never hears about.
    softDeleteVehicle(vin)
      .then(() => {
        setArmed(false);
        // The live query above this component swaps in `DeletedNotice` on its own; this is
        // for a host that has its own idea of what to do (close the §6.6 pane).
        onDeleted?.(vin);
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="delete-heading">
      <h2 id="delete-heading" className={LABEL}>
        {DELETE_TITLE}
      </h2>

      <p className="text-base leading-snug text-fg-muted">{DELETE_BODY}</p>

      {armed ? (
        <div ref={confirmRef}>
          <DeleteConfirm vin={vin} busy={busy} onConfirm={remove} onCancel={() => setArmed(false)} />
        </div>
      ) : (
        <Button variant="danger" onClick={() => setArmed(true)}>
          {DELETE_ACTION}
        </Button>
      )}

      {error !== null ? (
        <Banner tone="danger" title={DELETE_FAILED_TITLE}>
          {DELETE_FAILED_BODY} {error}
        </Banner>
      ) : null}
    </section>
  );
}
