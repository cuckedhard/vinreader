/**
 * Storage for the §6.3 cooldown ("the same VIN confirmed again within 10 s is
 * ignored — prevents double-logging on return to Scan").
 *
 * The map lives at module scope, above React, because that rule is about a return
 * to Scan and a return to Scan is a fresh mount: accepting a read navigates to the
 * Sheet, which unmounts the Scan screen and takes any component state with it. A
 * cooldown held in `useReducer` state therefore guards nothing at exactly the
 * moment §6.3 names.
 *
 * Not persisted and not a Dexie table: the window is ten seconds, so it has to
 * outlive a screen, not the tab.
 */

export interface CooldownStore {
  /** A snapshot. Callers own what they get back and cannot write through it. */
  read(): Record<string, number>;
  record(vin: string, atMs: number): void;
  /** Tests only: module state would otherwise leak from one test into the next. */
  clear(): void;
}

const acceptedAt = new Map<string, number>();

export const cooldownStore: CooldownStore = {
  read() {
    return Object.fromEntries(acceptedAt);
  },
  record(vin, atMs) {
    acceptedAt.set(vin, atMs);
  },
  clear() {
    acceptedAt.clear();
  },
};
