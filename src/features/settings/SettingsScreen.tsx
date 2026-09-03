import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { version } from "../../../package.json";
import { db } from "../../lib/storage/db";
import {
  clearAllData,
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
} from "../../lib/storage/settings";
import type { SettingsRecord } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";

const CONFIRM_WORD = "DELETE";

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

export function SettingsScreen() {
  const uid = useId();
  const deviceLabelId = `${uid}-device-label`;
  const deviceLabelHintId = `${uid}-device-label-hint`;
  const confirmId = `${uid}-confirm`;

  // liveQuery refuses a readwrite transaction inside its querier, and `getSettings`
  // opens one to seed the row, so the seeding runs once on mount and the screen reads
  // the stored row directly from then on.
  const stored = useLiveQuery(() => db.settings.get("settings"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().catch((cause: unknown) => setError(describe(cause)));
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
        <p className="mt-4 text-base text-fg-muted">Loading…</p>
      </div>
    );
  }

  // A row written before a later version added a field keeps that field's default.
  const settings: SettingsRecord = { ...DEFAULT_SETTINGS, ...stored };
  const labelValue = labelDraft ?? settings.deviceLabel;
  const canClear = confirmText.trim().toUpperCase() === CONFIRM_WORD;

  function save(patch: Partial<Omit<SettingsRecord, "id">>): void {
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

  function handleClear(): void {
    if (!canClear || clearing) return;
    setClearing(true);
    setError(null);
    clearAllData()
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
        <p className="text-sm leading-snug text-fg-muted">
          These three are stored now but change nothing yet: beep and vibrate arrive with camera
          scanning, and NHTSA details start loading in the step after that.
        </p>
      </Section>

      <Section title="Clear all data">
        <p className="text-base leading-snug text-fg">
          Removes every vehicle, scan and setting from this phone. It can’t be undone, and nothing
          here is backed up.
        </p>
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
            Every vehicle, scan and setting on this phone is gone.
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
            <dd className="font-bold text-fg">Slice S0</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

export default SettingsScreen;
