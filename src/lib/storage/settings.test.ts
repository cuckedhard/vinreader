import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  clearAllData,
  DEFAULT_SETTINGS,
  getSettings,
  normalizeSettings,
  normalizeTheme,
  updateSettings,
} from "./settings";
import { upsertVehicle } from "./upsert";

const VIN = "1HGCM82633A004352";

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("settings", () => {
  it("creates the row with the defaults on first read", async () => {
    expect(await db.settings.count()).toBe(0);

    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);

    expect(await db.settings.count()).toBe(1);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists a patch and leaves the other fields alone", async () => {
    const updated = await updateSettings({ deviceLabel: "Bay 3", sound: false });

    expect(updated).toEqual({ ...DEFAULT_SETTINGS, deviceLabel: "Bay 3", sound: false });
    expect(await getSettings()).toEqual(updated);
    expect(await db.settings.count()).toBe(1);
  });
});

describe("theme", () => {
  it("defaults to dark (§6.1)", async () => {
    expect(DEFAULT_SETTINGS.theme).toBe("dark");
    expect((await getSettings()).theme).toBe("dark");
  });

  it("round-trips each of the three choices", async () => {
    for (const theme of ["light", "system", "dark"] as const) {
      expect((await updateSettings({ theme })).theme).toBe(theme);
      expect((await getSettings()).theme).toBe(theme);
    }
  });

  it("falls back to dark rather than throwing on a value it does not know", async () => {
    // A row this build cannot write: an older build, a newer one rolled back, or a
    // hand-edited database. It must not strand the app on a palette that has no tokens.
    await db.settings.put({ ...DEFAULT_SETTINGS, theme: "solarized" } as never);

    expect((await getSettings()).theme).toBe("dark");
    expect(normalizeTheme(undefined)).toBe("dark");
    expect(normalizeTheme(null)).toBe("dark");
    expect(normalizeTheme("")).toBe("dark");
    expect(normalizeTheme("Light")).toBe("dark");
  });

  it("gives a row written before the field existed the default", () => {
    const legacy = { ...DEFAULT_SETTINGS, deviceLabel: "Bay 3" } as Partial<
      typeof DEFAULT_SETTINGS
    >;
    delete legacy.theme;

    expect(normalizeSettings(legacy)).toEqual({ ...DEFAULT_SETTINGS, deviceLabel: "Bay 3" });
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("clearAllData", () => {
  it("empties every table and restores the default settings", async () => {
    await upsertVehicle({
      vin: VIN,
      origin: "manual",
      symbology: "manual",
      raw: VIN,
      checkDigitValid: true,
    });
    await updateSettings({ deviceLabel: "Bay 3", uploadPromptDismissed: true });

    await clearAllData();

    expect(await db.vehicles.count()).toBe(0);
    expect(await db.scanEvents.count()).toBe(0);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("the S4 flags (§5.6)", () => {
  it("defaults to syncing, with the first-sign-in prompt unanswered", async () => {
    expect(await getSettings()).toMatchObject({ syncEnabled: true, uploadPromptDismissed: false });
  });

  it("remembers 'Not now', which stops the push without discarding the queue", async () => {
    // §6.4's first-sign-in prompt. §5.7's outbox fills whether or not anyone is signed in,
    // so the rows this phone accumulated are already queued when the question is asked:
    // declining has to gate the push and leave them alone.
    await updateSettings({ syncEnabled: false, uploadPromptDismissed: true });

    expect(await getSettings()).toMatchObject({ syncEnabled: false, uploadPromptDismissed: true });
  });

  it("gives a row written before S4 the defaults rather than undefined", () => {
    const legacy = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
    delete legacy.syncEnabled;
    delete legacy.uploadPromptDismissed;

    expect(normalizeSettings(legacy)).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ["the string 'false'", "false"],
    ["a number", 0],
    ["null", null],
  ])("falls back rather than reading %s as an answer", async (_label, value) => {
    // `if (settings.syncEnabled)` is satisfied by the string "false". A row that is not a
    // boolean is not an answer, and the push gate is the last place to guess at one.
    await db.settings.put({ ...DEFAULT_SETTINGS, syncEnabled: value } as never);

    expect((await getSettings()).syncEnabled).toBe(DEFAULT_SETTINGS.syncEnabled);
    expect(normalizeSettings({ sound: value } as never).sound).toBe(DEFAULT_SETTINGS.sound);
    expect(normalizeSettings({ haptics: value } as never).haptics).toBe(DEFAULT_SETTINGS.haptics);
    expect(normalizeSettings({ autoDecode: value } as never).autoDecode).toBe(
      DEFAULT_SETTINGS.autoDecode,
    );
    expect(normalizeSettings({ uploadPromptDismissed: value } as never).uploadPromptDismissed).toBe(
      DEFAULT_SETTINGS.uploadPromptDismissed,
    );
  });

  it("keeps a device label that is not text out of the push payload", () => {
    // §4.12 sends this as `scan_events.device_label`, a `text` column. A number here is a
    // row PostgREST rejects on every attempt — backed off forever, never dropped (§5.7).
    expect(normalizeSettings({ deviceLabel: 42 } as never).deviceLabel).toBe("");
    expect(normalizeSettings({ deviceLabel: "Bay 3" }).deviceLabel).toBe("Bay 3");
  });
});
