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

/** A row written before a later version added a field keeps that field's default. */
export function normalizeSettings(stored: Partial<StoredSettings> | undefined): StoredSettings {
  const merged: StoredSettings = { ...DEFAULT_SETTINGS, ...stored, id: "settings" };
  return { ...merged, theme: normalizeTheme(merged.theme) };
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
