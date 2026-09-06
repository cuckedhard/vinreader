import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router";
import { version } from "../../../package.json";
import { FailureNotice } from "../../app/ErrorBoundary";
import { db } from "../../lib/storage/db";
import {
  clearAllData,
  getSettings,
  normalizeSettings,
  updateSettings,
} from "../../lib/storage/settings";
import type { StoredSettings, Theme } from "../../lib/storage/settings";
import { getSyncEngine } from "../../lib/sync/engine";
import type { SyncStatus } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { useSyncSnapshot } from "../../ui/SyncChip";

const CONFIRM_WORD = "DELETE";

/**
 * §6.4 writes no copy for Settings, so every sentence this screen adds for S4 is supplied
 * and named here rather than left in JSX — §0 rule 4, and the same discipline the Account
 * screen's `strings.ts` follows. Each one is listed in the session report.
 */
const ACCOUNT_LINK_LABEL = "Account";
/**
 * Shown to a device with no account, which includes a build with no Supabase at all: the
 * Account screen says so in its own words, and promising sign-in from here would be a
 * guess about a build this screen cannot inspect (N2). It never implies anything is
 * missing without one (N7).
 */
const ACCOUNT_SIGNED_OUT_HINT =
  "Sign in to see this history on your other devices. Optional — everything here works without it.";
/** Signed in: the screen this points at is where the account's own deletes live (§6.2). */
const ACCOUNT_SIGNED_IN_HINT =
  "Signed in. Sync status, sign out, and deleting your cloud data or your account are all here.";

/**
 * The truth a signed-in device owes the user *before* they type DELETE. "Clear all data"
 * empties this phone; the account keeps its copy and sync downloads it again within
 * seconds, which looks exactly like the button not having worked. §9-S4 has the two
 * commands that mean something else, and both are one tap away on the Account screen.
 */
const CLEAR_ACCOUNT_NOTE =
  "You’re signed in, so your account keeps its own copy and this phone will download it " +
  "again. To empty the account, use Delete my cloud data on the Account screen.";
const CLEARED_ACCOUNT_NOTE = "What’s in your account will download again.";

/**
 * §4.10 has six sync statuses and only one of them says "no account on this device".
 * Everything else — offline, error, syncing, pending, synced — is a signed-in phone, and
 * an offline one still has an account that will refill it (N2).
 */
export function accountIsLinked(status: SyncStatus): boolean {
  return status !== "signed_out";
}

/** The device label rides along in handoff payloads (§4.9 `by`), so keep it short. */
const DEVICE_LABEL_MAX = 40;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const INPUT_CLASSES =
  "w-full min-h-[var(--tap-lg)] rounded-[var(--radius)] border border-border bg-bg-elev " +
  "px-4 py-3 text-lg text-fg placeholder:text-fg-muted";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg leading-tight font-bold text-fg">{title}</h2>
      {children}
    </section>
  );
}

interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/**
 * N5: a real switch button — one tap on the whole row, keyboard-reachable, no hover or
 * long-press affordance. The state is spelled out in words as well as colour, because
 * colour alone does not survive glare.
 */
function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={
        "flex min-h-[var(--tap)] w-full items-center justify-between gap-4 rounded-[var(--radius)] " +
        "border border-border bg-bg-elev px-4 py-3 text-left active:opacity-80"
      }
    >
      <span className="flex flex-col gap-1">
        <span className="text-base font-bold text-fg">{label}</span>
        <span className="text-sm leading-snug text-fg-muted">{hint}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3" aria-hidden="true">
        <span className={`text-sm font-bold ${checked ? "text-accent" : "text-fg-muted"}`}>
          {checked ? "On" : "Off"}
        </span>
        <span
          className={
            "flex h-8 w-14 items-center rounded-full border-2 px-1 " +
            (checked ? "justify-end border-accent bg-accent" : "justify-start border-border bg-bg")
          }
        >
          <span className={`h-5 w-5 rounded-full ${checked ? "bg-bg" : "bg-fg-muted"}`} />
        </span>
      </span>
    </button>
  );
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

interface ThemeRowProps {
  value: Theme;
  onChange: (next: Theme) => void;
}

/**
 * N5: three visible buttons rather than a control that cycles on tap — the choice in
 * force is named, not inferred, and each option carries its own 48 px target. The
 * selected one is marked with a tick as well as the fill, because a filled button and
 * an unfilled one are the same shape in glare.
 */
function ThemeRow({ value, onChange }: ThemeRowProps) {
  return (
    <div
      className={
        "flex w-full flex-col gap-3 rounded-[var(--radius)] border border-border " +
        "bg-bg-elev px-4 py-3"
      }
    >
      <span className="flex flex-col gap-1">
        <span className="text-base font-bold text-fg">Theme</span>
        <span className="text-sm leading-snug text-fg-muted">
          Dark is easiest at night. System follows the phone’s own setting.
        </span>
      </span>
      <div role="radiogroup" aria-label="Theme" className="flex gap-2">
        {THEME_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={
                "min-h-[var(--tap)] flex-1 rounded-[var(--radius)] border px-3 text-base " +
                "font-bold active:opacity-80 " +
                (selected ? "border-accent bg-accent text-bg" : "border-border bg-bg text-fg")
              }
            >
              <span aria-hidden="true">{selected ? "✓ " : ""}</span>
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * §6.2's "Account (S4)" entry, and the only way into `/#/account`: the bottom nav is Scan ·
 * History · Settings and S4 does not widen it.
 *
 * It is a plain `Link`, and deliberately reads nothing from `src/lib/auth/` — the account
 * screen is lazily loaded so that `@supabase/supabase-js` stays out of the first-paint
 * bundle (`router.tsx`), and importing the auth client here to label one row would undo
 * that for every user who never signs in. The sync engine's snapshot already knows whether
 * this device has an account, costs nothing, and is the same store the §6.4 chip reads.
 */
function AccountRow({ linked }: { linked: boolean }) {
  return (
    <Link
      to="/account"
      className={
        "flex min-h-[var(--tap-lg)] w-full items-center justify-between gap-4 " +
        "rounded-[var(--radius)] border border-border bg-bg-elev px-4 py-3 active:opacity-80 " +
        "focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-accent"
      }
    >
      <span className="flex flex-col gap-1">
        <span className="text-base font-bold text-fg">{ACCOUNT_LINK_LABEL}</span>
        <span className="text-sm leading-snug text-fg-muted">
          {linked ? ACCOUNT_SIGNED_IN_HINT : ACCOUNT_SIGNED_OUT_HINT}
        </span>
      </span>
      <span className="shrink-0 text-lg font-bold text-fg-muted" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

export function SettingsScreen() {
  const uid = useId();
  const deviceLabelId = `${uid}-device-label`;
  const deviceLabelHintId = `${uid}-device-label-hint`;
  const confirmId = `${uid}-confirm`;

  // liveQuery refuses a readwrite transaction inside its querier, and `getSettings`
  // opens one to seed the row, so the seeding runs once on mount and the screen reads
  // the stored row directly from then on.
  const stored = useLiveQuery(() => db.settings.get("settings"));
  // Whether this device has an account, from the one store that already knows. Read
  // before the loading return below, because a hook cannot be conditional.
  const linked = accountIsLinked(useSyncSnapshot().status);
  const [error, setError] = useState<string | null>(null);
  // G5: the same failure, kept as the value rather than only as a sentence. The catch below
  // already knew why this screen was empty and the loading gate returned above the banner
  // that would have said it, so "Loading…" stood for the rest of the session over a
  // database that had already refused. Wrapped, because a rejection may carry no reason and
  // "no reason" is not "storage is fine" (`probeStorage`).
  const [unreadable, setUnreadable] = useState<{ cause: unknown } | null>(null);

  useEffect(() => {
    getSettings().catch((cause: unknown) => {
      setError(describe(cause));
      setUnreadable({ cause });
    });
  }, []);

  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [labelSaved, setLabelSaved] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  if (!stored) {
    return (
      <div className="mx-auto w-full max-w-md p-4">
        <h1 className="text-2xl leading-tight font-bold text-fg">Settings</h1>
        {/*
         * P7. `getSettings` is this screen's only storage read, so a rejection from it is
         * storage saying no — not an inference (N2, `FailureNotice.fromStorage`). Until it
         * answers, "Loading…" is still the honest word; after it refuses, the live query is
         * never going to emit either, because Dexie filters `DatabaseClosedError` out of
         * `liveQuery`. Settings is where "Clear all data" lives — the one recovery from a
         * wedged database — so this is the screen that most owes the reason.
         */}
        {unreadable === null ? (
          <p className="mt-4 text-base text-fg-muted">Loading…</p>
        ) : (
          <div className="-mx-4 mt-4">
            <FailureNotice error={unreadable.cause} fromStorage standalone={false} />
          </div>
        )}
      </div>
    );
  }

  const settings = normalizeSettings(stored);
  const labelValue = labelDraft ?? settings.deviceLabel;
  const canClear = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  function save(patch: Partial<Omit<StoredSettings, "id">>): void {
    setError(null);
    updateSettings(patch).catch((cause: unknown) => setError(describe(cause)));
  }

  function commitDeviceLabel(): void {
    if (labelDraft === null) return;
    const next = labelDraft.trim();
    if (next === settings.deviceLabel) {
      setLabelDraft(null);
      return;
    }
    setError(null);
    // The draft holds the committed text rather than dropping back to the stored value,
    // so the field does not flicker while the live query catches up.
    setLabelDraft(next);
    updateSettings({ deviceLabel: next })
      .then(() => setLabelSaved(true))
      .catch((cause: unknown) => setError(describe(cause)));
  }

  /**
   * The wipe, with the S4 ordering every destructive path in this slice follows
   * (`signOut.ts`): stop the sync engine first, then touch storage.
   *
   * A cycle running through the wipe would be pushing rows out of a queue that is being
   * emptied underneath it and applying pulled rows into tables that are being cleared —
   * and it would spend §5.7 attempts doing it. The engine is started again either way,
   * because a phone left silently unsynced is a worse outcome than the one the user asked
   * for; on a signed-in device that restart is also what downloads the account's copy
   * back, which is what `CLEAR_ACCOUNT_NOTE` says before the button is even enabled.
   */
  async function clearEverything(): Promise<void> {
    const engine = getSyncEngine();
    engine?.stop();
    try {
      await clearAllData();
    } catch (cause) {
      // The records are still here and the session is untouched, so sync goes back to
      // work before the failure is reported (P7 — no silent catch, and never a silently
      // dead engine either).
      engine?.start();
      throw cause;
    }
    engine?.start();
  }

  function handleClear(): void {
    if (!canClear || clearing) return;
    setClearing(true);
    setError(null);
    clearEverything()
      .then(() => {
        setConfirmText("");
        setLabelDraft(null);
        setLabelSaved(false);
        setCleared(true);
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setClearing(false));
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 p-4 pb-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl leading-tight font-bold text-fg">Settings</h1>
        <p className="text-base leading-snug text-fg-muted">
          Saved on this phone. Nothing here is sent anywhere.
        </p>
      </header>

      {error ? (
        <Banner tone="danger" title="Couldn’t save that">
          {error}
        </Banner>
      ) : null}

      <Section title="This phone">
        <div className="flex flex-col gap-2">
          <label htmlFor={deviceLabelId} className="text-base font-bold text-fg">
            Device label
          </label>
          <p id={deviceLabelHintId} className="text-sm leading-snug text-fg-muted">
            Names this phone on records you hand to another device.
          </p>
          <input
            id={deviceLabelId}
            aria-describedby={deviceLabelHintId}
            className={INPUT_CLASSES}
            type="text"
            value={labelValue}
            maxLength={DEVICE_LABEL_MAX}
            autoCapitalize="words"
            autoComplete="off"
            spellCheck={false}
            placeholder="Truck 12 phone"
            onChange={(event) => {
              setLabelDraft(event.target.value);
              setLabelSaved(false);
            }}
            onBlur={commitDeviceLabel}
          />
          <p className="min-h-5 text-sm font-bold text-ok" role="status">
            {labelSaved ? "Saved ✓" : ""}
          </p>
        </div>
        <ThemeRow value={settings.theme} onChange={(next) => save({ theme: next })} />
      </Section>

      <Section title="Scan and details">
        <ToggleRow
          label="Sound"
          hint="Plays a short beep when a scan is confirmed."
          checked={settings.sound}
          onChange={(next) => save({ sound: next })}
        />
        <ToggleRow
          label="Haptics"
          hint="Vibrates on a confirmed scan, where the phone supports it."
          checked={settings.haptics}
          onChange={(next) => save({ haptics: next })}
        />
        <ToggleRow
          label="Auto-decode"
          hint="Fetches vehicle details from NHTSA automatically when you’re online."
          checked={settings.autoDecode}
          onChange={(next) => save({ autoDecode: next })}
        />
      </Section>

      {/* §6.2 lists Account between the toggles and Clear all data, and the order matters
          here: the account-level deletes are through this link, so a user heading for
          "delete everything" meets them before the button that only clears the phone. It
          carries no heading of its own — the row is the item, and a heading reading
          "Account" above a row reading "Account" is a word twice, not a structure. */}
      <AccountRow linked={linked} />

      <Section title="Clear all data">
        <p className="text-base leading-snug text-fg">
          Removes every vehicle, scan and setting from this phone. It can’t be undone, and nothing
          here is backed up.
        </p>
        {linked ? <p className="text-base leading-snug text-fg">{CLEAR_ACCOUNT_NOTE}</p> : null}
        <label htmlFor={confirmId} className="text-base font-bold text-fg">
          Type {CONFIRM_WORD} to turn on the button
        </label>
        <input
          id={confirmId}
          className={INPUT_CLASSES}
          type="text"
          value={confirmText}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={CONFIRM_WORD}
          onChange={(event) => {
            setConfirmText(event.target.value);
            setCleared(false);
          }}
        />
        <Button
          variant="danger"
          full
          disabled={!canClear || clearing}
          onClick={handleClear}
          // §6.1: the destructive action is this screen's primary action, so it gets the
          // 56 px target. Inline, because the variant's own min-height is a class.
          style={{ minHeight: "var(--tap-lg)" }}
        >
          {clearing ? "Clearing…" : "Clear all data"}
        </Button>
        {cleared ? (
          <Banner tone="ok" title="All data cleared">
            {/* N2: on a signed-in phone the records are about to reappear, and a banner
                that stopped at "gone" would be describing a device state that lasts
                seconds. */}
            Every vehicle, scan and setting on this phone is gone.
            {linked ? ` ${CLEARED_ACCOUNT_NOTE}` : null}
          </Banner>
        ) : null}
      </Section>

      <Section title="About">
        <dl className="flex flex-col gap-2 text-base text-fg-muted">
          <div className="flex justify-between gap-4">
            <dt>App</dt>
            <dd className="font-bold text-fg">VIN Relay</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Version</dt>
            <dd className="font-bold text-fg">{version}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Build</dt>
            {/* The commit the installed app was built from, stamped by the bundler. The
                §7 item 4 device matrix needs to say which build a phone is running, and
                both a hand-written slice number and MODE ("production") fail at that. */}
            <dd className="font-vin font-bold text-fg">{__BUILD_STAMP__}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

export default SettingsScreen;
