/**
 * §6.2's `/#/account` — the only screen in the app that knows an account exists.
 *
 * Signed out it is an email field and a 6-digit code; signed in it is the state of the sync
 * engine, the way to add this phone's records to the account, the two ways out, and the two
 * deletes. Nothing else in v1 (§12).
 *
 * ## What this screen is careful about
 *
 * **It never waits on the network to render** (N7, P1). `useAuth` reads a module snapshot,
 * every Dexie read is a live query with a defined "not yet" state, and the first paint of a
 * device whose session is still being read shows neither a form nor a panel — showing either
 * would be a guess about who is holding the phone (N2).
 *
 * **It arms the upload question before the session exists.** §5.6 defaults `syncEnabled` to
 * true and §5.7's queue has been filling since the first scan, so a prompt asked *after*
 * sign-in would be asked while the upload it offers to authorise is already in flight. The
 * line before `verifyCode` is the last honest moment to shut the gate; `localRecords.ts`
 * holds that decision and the reasoning behind it.
 *
 * **Sign-out is ordered.** `engine.stop()` first, then the Dexie half, then the session —
 * `signOut.ts` states the rule, and the cost of getting it wrong is one wasted push attempt
 * per queued row against a session that has already ended.
 */
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { supabaseAvailability } from "../../lib/auth/client";
import { useAuth } from "../../lib/auth/useAuth";
import { db } from "../../lib/storage/db";
import { getSettings, normalizeSettings, updateSettings } from "../../lib/storage/settings";
import { normalizeSyncState } from "../../lib/storage/syncState";
import { getSyncEngine } from "../../lib/sync/engine";
import { signOutClearDevice, signOutKeepRecords } from "../../lib/sync/signOut";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { SyncChip } from "../../ui/SyncChip";
import { addLocalRecords, armUploadPrompt, countLocalRecords, declineUpload } from "./localRecords";
import { deleteAccount, deleteCloudData } from "./cloudDelete";
import * as text from "./strings";

const PANEL = "rounded-[var(--radius)] border border-border bg-bg-elev";

const INPUT_CLASSES =
  "w-full min-h-[var(--tap-lg)] rounded-[var(--radius)] border border-border bg-bg-elev " +
  "px-4 py-3 text-lg text-fg placeholder:text-fg-muted";

/** Which long-running action is holding the screen. Only one can run at a time. */
type Busy = "sync" | "add" | "signout" | "delete";

/** What just finished, so the screen can say so after the thing it describes is gone. */
type Outcome = "added" | "signed-out-kept" | "signed-out-cleared" | "cloud-deleted" | "deleted";

type Confirming = "cloud" | "account";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** §5.8's stamps are ISO with an offset; the device shows them in its own locale. */
function when(iso: string | null): string {
  if (iso === null) return text.NEVER;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? text.NEVER : new Date(at).toLocaleString();
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg leading-tight font-bold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="font-bold text-fg">{value}</dd>
    </div>
  );
}

const OUTCOME: Record<Outcome, { title: string; body: string }> = {
  added: { title: text.ADDED_TITLE, body: text.ADDED_BODY },
  "signed-out-kept": { title: text.SIGNED_OUT_KEPT_TITLE, body: text.SIGNED_OUT_KEPT_BODY },
  "signed-out-cleared": {
    title: text.SIGNED_OUT_CLEARED_TITLE,
    body: text.SIGNED_OUT_CLEARED_BODY,
  },
  "cloud-deleted": { title: text.CLOUD_DELETED_TITLE, body: text.CLOUD_DELETED_BODY },
  deleted: { title: text.ACCOUNT_DELETED_TITLE, body: text.ACCOUNT_DELETED_BODY },
};

export function AccountScreen() {
  const uid = useId();
  const emailId = `${uid}-email`;
  const codeId = `${uid}-code`;
  const confirmId = `${uid}-confirm`;

  const auth = useAuth();

  // Live, and all four of them defined as "not answered yet" while Dexie is still looking:
  // a count the screen has not got cannot be put in a sentence about the user's records.
  const storedSettings = useLiveQuery(() => db.settings.get("settings"));
  const storedSyncState = useLiveQuery(() => db.syncState.get("cursor"));
  const pending = useLiveQuery(() => db.outbox.count());
  const localRecords = useLiveQuery(() => countLocalRecords());

  // `useLiveQuery` refuses a readwrite transaction inside its querier and `getSettings`
  // opens one to seed the row, so the seeding happens once, here (the Settings screen does
  // the same). Until it lands, `storedSettings` is undefined and nothing that depends on it
  // is rendered.
  useEffect(() => {
    getSettings().catch(() => {
      // Storage that cannot seed a settings row will fail louder, and more usefully, at the
      // first action the user takes; this screen still renders everything else.
    });
  }, []);

  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [editingEmail, setEditingEmail] = useState(false);
  const [code, setCode] = useState("");
  const [detail, setDetail] = useState<string | null>(null);

  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const email = emailDraft ?? auth.email ?? "";
  const settings = storedSettings === undefined ? null : normalizeSettings(storedSettings);
  const syncState = storedSyncState === undefined ? null : normalizeSyncState(storedSyncState);
  const records = localRecords ?? 0;
  const locked = busy !== null || auth.busy;

  async function run(kind: Busy, action: () => Promise<void>): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      // P7: the user is told, in the words of whatever failed, and the screen stays usable.
      setError(describe(cause));
    } finally {
      setBusy(null);
    }
  }

  function send(): void {
    setDetail(null);
    setOutcome(null);
    void auth.sendCode(email).then((result) => {
      if (result.ok) {
        setEditingEmail(false);
        setCode("");
      } else {
        setDetail(result.message);
      }
    });
  }

  function verify(): void {
    setDetail(null);
    void (async () => {
      try {
        // Before the session exists — see the file header and `localRecords.ts`.
        await armUploadPrompt();
      } catch (cause) {
        setError(describe(cause));
      }
      const result = await auth.verifyCode(code);
      if (result.ok) {
        setCode("");
        setOutcome(null);
      } else {
        setDetail(result.message);
      }
    })();
  }

  function signOutWith(mode: "keep" | "clear"): void {
    void run("signout", async () => {
      const engine = getSyncEngine();
      // §9-S4 order, and it is load-bearing: a push that starts after the session ends fails
      // every batch and spends an attempt on every row it was carrying.
      engine?.stop();
      try {
        if (mode === "keep") {
          await signOutKeepRecords();
          // The queue left with the account it was addressed to, so the next sign-in on this
          // phone owes the §6.4 question again — very possibly for a different account.
          await updateSettings({ uploadPromptDismissed: false });
        } else {
          await signOutClearDevice();
        }
        await auth.signOut();
        setSignOutOpen(false);
        setOutcome(mode === "keep" ? "signed-out-kept" : "signed-out-cleared");
      } finally {
        // Back on its feet for whoever signs in next. Signed out it makes no requests.
        engine?.start();
      }
    });
  }

  function runDelete(): void {
    const target = confirming;
    if (target === null) return;
    void run("delete", async () => {
      const engine = getSyncEngine();
      engine?.stop();
      try {
        if (target === "cloud") {
          await deleteCloudData();
          setOutcome("cloud-deleted");
        } else {
          await deleteAccount();
          await auth.signOut();
          setOutcome("deleted");
        }
        setConfirming(null);
        setConfirmText("");
      } finally {
        engine?.start();
      }
    });
  }

  const ready = auth.ready;
  const signedIn = auth.userId !== null;
  const codeStep = auth.stage === "code_sent" && !editingEmail;
  const canDelete = confirmText.trim().toUpperCase() === text.CONFIRM_WORD;
  // The §6.4 prompt is owed while the answer is unknown and there is something to upload.
  const askUpload = settings !== null && !settings.uploadPromptDismissed && records > 0;
  const canAdd = settings !== null && settings.uploadPromptDismissed && !settings.syncEnabled;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 p-4 pb-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl leading-tight font-bold text-fg">{text.SCREEN_TITLE}</h1>
      </header>

      {outcome !== null ? (
        <Banner tone="ok" title={OUTCOME[outcome].title}>
          {OUTCOME[outcome].body}
        </Banner>
      ) : null}

      {error !== null ? (
        <Banner tone="danger" title={text.ACTION_FAILED_TITLE}>
          {error}
        </Banner>
      ) : null}

      {!ready ? (
        <p className="text-base text-fg-muted" role="status">
          {text.CHECKING}
        </p>
      ) : null}

      {/* A build with no Supabase is the ordinary one for a user who never signs in, so it
          says so plainly and offers nothing that cannot work (client.ts, P7). */}
      {ready && !auth.configured ? (
        supabaseAvailability() === "invalid_config" ? (
          <Banner tone="danger" title={text.INVALID_CONFIG_TITLE}>
            {text.INVALID_CONFIG_BODY}
          </Banner>
        ) : (
          <Banner tone="info" title={text.NOT_CONFIGURED_TITLE}>
            {text.NOT_CONFIGURED_BODY}
          </Banner>
        )
      ) : null}

      {ready && auth.configured && !signedIn ? (
        <section className={`flex flex-col gap-4 p-5 ${PANEL}`}>
          {!codeStep ? (
            <>
              <p className="text-base leading-snug text-fg">{text.SIGN_IN_PROMPT}</p>
              <div className="flex flex-col gap-2">
                <label htmlFor={emailId} className="text-base font-bold text-fg">
                  {text.EMAIL_LABEL}
                </label>
                <input
                  id={emailId}
                  className={INPUT_CLASSES}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={text.EMAIL_PLACEHOLDER}
                  value={email}
                  onChange={(event) => setEmailDraft(event.target.value)}
                />
              </div>
              <Button full disabled={locked || email.trim() === ""} onClick={send}>
                {auth.busy ? text.SENDING : text.SEND_CODE}
              </Button>
            </>
          ) : (
            <>
              <p className="text-base leading-snug text-fg">{text.CODE_SENT}</p>
              <p className="text-sm leading-snug text-fg-muted">{auth.email}</p>
              <div className="flex flex-col gap-2">
                <label htmlFor={codeId} className="text-base font-bold text-fg">
                  {text.CODE_LABEL}
                </label>
                <input
                  id={codeId}
                  className={`${INPUT_CLASSES} font-vin tracking-[0.3em]`}
                  type="text"
                  inputMode="numeric"
                  // The token length is the Supabase project's setting (session.ts), so the
                  // field neither caps it nor validates it — it only asks for digits.
                  autoComplete="one-time-code"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={text.CODE_PLACEHOLDER}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <Button full disabled={locked || code.trim() === ""} onClick={verify}>
                {auth.busy ? text.SIGNING_IN : text.SIGN_IN}
              </Button>
              <Button variant="secondary" full disabled={locked || !auth.canResend} onClick={send}>
                {auth.canResend ? text.RESEND : text.resendIn(auth.resendSeconds)}
              </Button>
              <Button
                variant="ghost"
                full
                disabled={locked}
                onClick={() => {
                  setEditingEmail(true);
                  setEmailDraft("");
                  setDetail(null);
                }}
              >
                {text.CHANGE_EMAIL}
              </Button>
            </>
          )}

          {auth.error !== null ? (
            <Banner tone="danger" title={text.authFailureText(auth.error)}>
              {/* P7: the server's own words, for the deployment mistakes no microcopy covers. */}
              {detail !== null ? <p className="text-sm text-fg-muted">{detail}</p> : null}
            </Banner>
          ) : null}
        </section>
      ) : null}

      {ready && signedIn ? (
        <>
          <Section title={text.SIGNED_IN_AS}>
            <p className="text-lg leading-snug font-bold break-all text-fg">{auth.email}</p>
          </Section>

          <Section title={text.SYNC_TITLE}>
            <div className="flex flex-wrap items-center gap-3">
              <SyncChip />
            </div>
            <dl className="flex flex-col gap-2 text-base text-fg-muted">
              <Row
                label={text.PENDING_LABEL}
                value={pending === undefined ? "—" : String(pending)}
              />
              <Row label={text.LAST_UPLOAD_LABEL} value={when(syncState?.lastPushAt ?? null)} />
              <Row label={text.LAST_DOWNLOAD_LABEL} value={when(syncState?.lastPullAt ?? null)} />
            </dl>

            {/* §6.4's "Sync error — tap for details" is a link to this screen; this is the
                detail it promised. */}
            {syncState?.lastError ? (
              <Banner tone="danger" title={text.SYNC_ERROR_TITLE}>
                {syncState.lastError}
              </Banner>
            ) : null}

            {canAdd && records > 0 ? (
              <Banner tone="warn" title={text.SYNC_OFF_TITLE}>
                {text.SYNC_OFF_BODY}
              </Banner>
            ) : null}

            <Button
              variant="secondary"
              full
              disabled={locked}
              onClick={() =>
                void run("sync", async () => {
                  const engine = getSyncEngine();
                  if (engine === null) throw new Error(text.SYNC_UNAVAILABLE);
                  await engine.sync();
                })
              }
            >
              {busy === "sync" ? text.SYNCING_NOW : text.SYNC_NOW}
            </Button>
          </Section>

          {/* §9-S4's first sign-in merge. Asked once per device-and-account; the answer is
              §5.6's `uploadPromptDismissed`, and until it is given the push gate stays shut. */}
          {askUpload ? (
            <Banner
              tone="info"
              title={text.uploadPromptQuestion(records)}
              actions={
                <>
                  <Button
                    disabled={locked}
                    onClick={() =>
                      void run("add", async () => {
                        await addLocalRecords();
                        setOutcome("added");
                      })
                    }
                  >
                    {busy === "add" ? text.ADDING : text.UPLOAD_ADD}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={locked}
                    onClick={() => void run("add", declineUpload)}
                  >
                    {text.UPLOAD_NOT_NOW}
                  </Button>
                </>
              }
            />
          ) : null}

          {!askUpload && canAdd && records > 0 ? (
            <Button
              full
              disabled={locked}
              onClick={() =>
                void run("add", async () => {
                  await addLocalRecords();
                  setOutcome("added");
                })
              }
            >
              {busy === "add" ? text.ADDING : text.addLocalRecordsLabel(records)}
            </Button>
          ) : null}

          <Section title={text.SIGN_OUT_TITLE}>
            {!signOutOpen ? (
              <Button
                variant="secondary"
                full
                disabled={locked}
                onClick={() => setSignOutOpen(true)}
              >
                {text.SIGN_OUT}
              </Button>
            ) : (
              <Banner
                tone="warn"
                title={text.SIGN_OUT_QUESTION}
                actions={
                  <>
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() => signOutWith("keep")}
                    >
                      {busy === "signout" ? text.SIGNING_OUT : text.SIGN_OUT_KEEP}
                    </Button>
                    <Button variant="danger" disabled={locked} onClick={() => signOutWith("clear")}>
                      {text.SIGN_OUT_CLEAR}
                    </Button>
                    <Button variant="ghost" disabled={locked} onClick={() => setSignOutOpen(false)}>
                      {text.CANCEL}
                    </Button>
                  </>
                }
              >
                {text.SIGN_OUT_BODY}
              </Banner>
            )}
          </Section>

          <Section title={text.DANGER_TITLE}>
            <Button
              variant="danger"
              full
              disabled={locked}
              onClick={() => {
                setConfirming("cloud");
                setConfirmText("");
                setOutcome(null);
              }}
            >
              {text.DELETE_CLOUD}
            </Button>
            <Button
              variant="danger"
              full
              disabled={locked}
              onClick={() => {
                setConfirming("account");
                setConfirmText("");
                setOutcome(null);
              }}
            >
              {text.DELETE_ACCOUNT}
            </Button>

            {/* One panel, one typed word, and it is rebuilt whenever the target changes —
                a DELETE typed for one of these must never arm the other. */}
            {confirming !== null ? (
              <div className={`flex flex-col gap-3 p-5 ${PANEL}`}>
                <p className="text-base leading-snug text-fg">{text.DELETE_WARNING}</p>
                {confirming === "account" ? (
                  <p className="text-base leading-snug text-fg">{text.DELETE_ACCOUNT_EXTRA}</p>
                ) : null}
                <label htmlFor={confirmId} className="text-base font-bold text-fg">
                  {text.confirmWordHint(text.CONFIRM_WORD)}
                </label>
                <input
                  id={confirmId}
                  className={INPUT_CLASSES}
                  type="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={text.CONFIRM_WORD}
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                />
                <Button
                  variant="danger"
                  full
                  disabled={locked || !canDelete}
                  onClick={runDelete}
                  // §6.1: the destructive action is this panel's primary action, so it takes
                  // the 56 px target. Inline, because the variant's min-height is a class.
                  style={{ minHeight: "var(--tap-lg)" }}
                >
                  {busy === "delete"
                    ? text.DELETING
                    : confirming === "cloud"
                      ? text.DELETE_CLOUD
                      : text.DELETE_ACCOUNT}
                </Button>
                <Button
                  variant="ghost"
                  full
                  disabled={locked}
                  onClick={() => {
                    setConfirming(null);
                    setConfirmText("");
                  }}
                >
                  {text.CANCEL}
                </Button>
              </div>
            ) : null}
          </Section>
        </>
      ) : null}
    </div>
  );
}

export default AccountScreen;
