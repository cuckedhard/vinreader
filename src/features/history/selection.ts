/**
 * §6.2's multi-select, as pure functions over a set of VINs.
 *
 * A `Set<string>` of VINs and not a set of records, because §5.3 keys everything by VIN
 * and the records themselves are replaced on every live-query answer: holding the records
 * would mean a selection quietly pointing at a copy of a vehicle that has since been
 * re-scanned, re-decoded or pulled down from another device (§4.12).
 *
 * That indirection is also what makes a selection self-healing. `selectedRecords` reads
 * the set against whatever the live query currently holds, so a VIN deleted on another
 * device — or on this one — leaves the selection on its own, and the count beside the copy
 * buttons is always the number of records those buttons will actually write.
 *
 * Pure: no DOM, no React, no I/O. Every returned set is new, so React sees a change.
 */
import type { VehicleRecord } from "../../lib/vin/types";

export function toggleVin(selected: ReadonlySet<string>, vin: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(vin)) next.add(vin);
  return next;
}

export function withAll(selected: ReadonlySet<string>, vins: readonly string[]): Set<string> {
  const next = new Set(selected);
  for (const vin of vins) next.add(vin);
  return next;
}

/**
 * The selected records, in the order the screen lists them — newest first (§6.2) — so a
 * copied block reads in the order the user sees, and copying the same selection twice
 * cannot produce two different orders.
 */
export function selectedRecords(
  records: readonly VehicleRecord[],
  selected: ReadonlySet<string>,
): VehicleRecord[] {
  return records.filter((record) => selected.has(record.vin));
}

/** Whether every one of these records is already selected — empty is not "all". */
export function allSelected(
  records: readonly VehicleRecord[],
  selected: ReadonlySet<string>,
): boolean {
  return records.length > 0 && records.every((record) => selected.has(record.vin));
}
