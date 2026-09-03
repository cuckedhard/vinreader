/** §5.6 settings — a single row, id "settings". Defaults per D16. */
import type { SettingsRecord } from "../vin/types";
import { db } from "./db";

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: "settings",
  deviceLabel: "",
  sound: true,
  haptics: true,
  autoDecode: true,
  syncEnabled: true,
  uploadPromptDismissed: false,
};

export async function getSettings(): Promise<SettingsRecord> {
  return db.transaction("rw", db.settings, async () => {
    const stored = await db.settings.get("settings");
    if (!stored) {
      const created = { ...DEFAULT_SETTINGS };
      await db.settings.put(created);
      return created;
    }
    // A row written before a later version added a field keeps that field's default.
    return { ...DEFAULT_SETTINGS, ...stored };
  });
}

export async function updateSettings(
  patch: Partial<Omit<SettingsRecord, "id">>,
): Promise<SettingsRecord> {
  return db.transaction("rw", db.settings, async () => {
    const current = await getSettings();
    const next: SettingsRecord = { ...current, ...patch, id: "settings" };
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
