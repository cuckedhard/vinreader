/** §5.6 settings — a single row, id "settings". Defaults per D16. */
import type { SettingsRecord } from "../vin/types";
import { db } from "./db";

/** §6.1's theme choice. "system" follows `prefers-color-scheme`; dark is the default. */
export const THEMES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEMES)[number];

/** §5.6's row, plus §6.1's theme choice. */
export interface StoredSettings extends SettingsRecord {
  theme: Theme;
}

/**
 * S4 needed no new field here: §5.6 already names both flags the slice turns on.
 *
 * - `syncEnabled` is the **push gate**. §5.7's outbox fills on every local write whether or
 *   not anyone is signed in, so the rows a phone accumulated before its first sign-in are
 *   already queued when the §6.4 prompt asks "Add the 14 records on this phone to your
 *   account?". **Not now** therefore has to stop the push, not discard the rows: it clears
 *   this flag and the queue waits for "Add N local records" on the Account screen.
 * - `uploadPromptDismissed` is what stops that prompt being asked twice.
 *
 * Neither syncs (§4.12 pushes `vehicles` and `scan_events`, and nothing else): they are
 * per-device answers, like `theme`.
 */
export const DEFAULT_SETTINGS: StoredSettings = {
  id: "settings",
  deviceLabel: "",
  sound: true,
  haptics: true,
  autoDecode: true,
  syncEnabled: true,
  uploadPromptDismissed: false,
  theme: "dark",
};

/**
 * `theme` is the one field whose value space is narrower than `string`, and the row is
 * whatever an older build or a hand-edited database left behind — so an unrecognised
 * value falls back to the §6.1 default instead of reaching `data-theme` and stranding
 * the app on a palette that does not exist.
 */
export function normalizeTheme(value: unknown): Theme {
  return THEMES.find((theme) => theme === value) ?? DEFAULT_SETTINGS.theme;
}

/**
 * A stored value of the wrong type is not a value. It is what an older build, a rolled-back
 * newer one, or a hand-edited database left behind, and the row is read straight into
 * decisions the user cannot see being made: `if (settings.syncEnabled)` is satisfied by the
 * *string* `"false"`, which would push a device whose owner said "Not now".
 */
function normalizeFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A row written before a later version added a field keeps that field's default. */
export function normalizeSettings(stored: Partial<StoredSettings> | undefined): StoredSettings {
  const merged: StoredSettings = { ...DEFAULT_SETTINGS, ...stored, id: "settings" };
  return {
    id: "settings",
    // §4.12 pushes this into `scan_events.device_label`, a `text` column: anything else here
    // is a row PostgREST rejects on every attempt, backing off forever without being dropped.
    deviceLabel:
      typeof merged.deviceLabel === "string" ? merged.deviceLabel : DEFAULT_SETTINGS.deviceLabel,
    sound: normalizeFlag(merged.sound, DEFAULT_SETTINGS.sound),
    haptics: normalizeFlag(merged.haptics, DEFAULT_SETTINGS.haptics),
    autoDecode: normalizeFlag(merged.autoDecode, DEFAULT_SETTINGS.autoDecode),
    syncEnabled: normalizeFlag(merged.syncEnabled, DEFAULT_SETTINGS.syncEnabled),
    uploadPromptDismissed: normalizeFlag(
      merged.uploadPromptDismissed,
      DEFAULT_SETTINGS.uploadPromptDismissed,
    ),
    theme: normalizeTheme(merged.theme),
  };
}

export async function getSettings(): Promise<StoredSettings> {
  return db.transaction("rw", db.settings, async () => {
    const stored = await db.settings.get("settings");
    if (!stored) {
      const created = { ...DEFAULT_SETTINGS };
      await db.settings.put(created);
      return created;
    }
    return normalizeSettings(stored);
  });
}

export async function updateSettings(
  patch: Partial<Omit<StoredSettings, "id">>,
): Promise<StoredSettings> {
  return db.transaction("rw", db.settings, async () => {
    const current = await getSettings();
    const next: StoredSettings = { ...current, ...patch, id: "settings" };
    await db.settings.put(next);
    return next;
  });
}

/** §6.2 "Clear all data": every table, then the settings row back at its defaults. */
export async function clearAllData(): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
    await db.settings.put({ ...DEFAULT_SETTINGS });
  });
}
