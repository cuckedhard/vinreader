# `harden S1` — final report (§13.8)

Run 2026-09-05 → 2026-09-06. Two rounds against a slice that had already seen five earlier
rounds of work. **Stopped short of §13.6, deliberately and for a reason that more rounds cannot
change** — see §5.

## 1. Rounds run

| round | step 1 (audit) | step 2 (triage) | step 3 (fix) | step 4 (gate) |
|---|---|---|---|---|
| 1 | 5 auditors in parallel — 36 findings, 32 new | 3 S1 · 9 S2 · 16 S3 · 8 S4; 32 FIX, 3 NEEDS-ZACH, 1 WONTFIX; **10 stale rows closed on evidence** | 11 commits, 1 rejected and remediated | green but for the environment-blocked test |
| 2 | — (worked the triaged backlog) | — | **35 commits, 33 reviewed, 29 approved, 4 rejected** | green but for the same test |

Round 1's audit also closed ten rows that said `open` while the commit fixing them had already
landed — `A23`, `B2`, `R3-I`, `R3-F7`, `R4-J`, `A23-a`, `M1` among them. A ledger that misreports
its own state makes §13.6 criterion 1 unmeasurable, so that mattered before anything else could.

## 2. Findings by severity

| sev | found | fixed | open |
|---|---|---|---|
| S1 | 3 | 2 | 1 (NEEDS-ZACH) |
| S2 | 9 | 7 | 2 (1 NEEDS-ZACH) |
| S3 | 16 | 14 | 2 |
| S4 | 8 | 8 | 0 |

**32 findings closed across the two rounds.** The four rejects are recorded rather than reverted:
in each the named defect is genuinely gone and what the reviewer refused was a claim made *around*
the fix. Three of the four became new rows (`SB-5-a`, `SB-5-b`, `FB-1`, `R3-F11-a`).

### The four that mattered most

**The e2e gate was running 4 of 47 tests.** A flaky light-theme assertion raced React's mount, and
`playwright.config.ts` gives `desktop` a `dependencies: ["light"]`, so one intermittent failure
skipped the entire desktop project — the fake-camera scan flow, offline, import, share. Every
"green" before `cce85e3` was worth nothing. It now runs 89.

**The bench was measuring an easier problem than the app solves.** `bench/run.ts` handed ZXing a
~1050 px symbol in a ~1100 px image; the app hands it a 1920×1080 video frame. Measured on
identical, unresampled symbol pixels: 68.0% → 62.5% overall, and `code_128` severe **62.5% → 25.0%**.
Every §13.6 margin ever reported by this bench was optimistic by an unknown amount.

**`extractVin` could return characters that were never scanned.** §4.2 step 1 said "Uppercase" and
the code read it as `String.prototype.toUpperCase`, a *length-changing* map: fifteen code points
outside §4.1 uppercase **into** the alphabet, six into two or three characters. Live on four
normalisation paths, not the one the audit found — including typed entry, where pasting a
17-character string containing `ﬁ` produced 18. Zach ruled ASCII-only; §4.2 step 1 now says so.

**A blank screen when storage is blocked.** No error boundary existed anywhere in `src/`, and
`useLiveQuery` re-throws during render *by design* so one can catch it. `#root` measured **0 bytes**
with IndexedDB reads throwing. Then F1-b: when IndexedDB never *opens*, Dexie filters
`DatabaseClosedError` before `observer.error`, so the new boundary never fired either and
`/#/v/:vin` rendered an empty `<main>`.

## 3. Gate

Final tree, measured not asserted:

| | |
|---|---|
| `typecheck` · `lint` | clean |
| `test` | **1394 passed / 1 failed** of 1395, 87 files |
| `test:e2e` | **89 passed** (was 4 running, 43 skipped) |
| `test:e2e:android` | 170 passed (pixel-7, galaxy-s9) |
| `coverage` | 99.35% statements · **98.13% branches** · 99.66% lines (§13.5 bar: 95/95) |
| per-file 100% | `checkDigit` `modelYear` `extractVin` `codec` `scanMachine` — all held |
| `mutate` | scoped only: `extractVin.ts` 89.19%, `scanMachine.ts` 99.39% (both over the 80% break) |
| `bench` | **FAIL — 14 of 21 decode-rate cells**; false accepts **0** in 4,200 and 0 in the 21,000-attempt sweep |

The single red test is `wmiCache.test.ts`: `wmi-seed.json` is `{}` until `bun run seed:wmi` runs
against vpic.nhtsa.dot.gov, and this environment has no egress to it. The test is right, the code
is right, the artifact is missing. **It needs one run on a machine with network.** Left red and
unweakened.

`bun run mutate` could not execute in the storage pass at all, so the score is scoped rather than
whole-suite. That is a gap in this report, not a passing grade.

### The bench, honestly

| symbology | clean ≥99% | moderate ≥90% | severe ≥70% |
|---|---|---|---|
| `code_39` | 100.0% | 77.5% ±5.8 | 30.0% ±6.3 |
| `code_39_i` | 100.0% | 79.0% ±5.6 | 23.5% ±5.8 |
| `code_39_check` | 24.0% | 18.5% ±5.4 | 7.0% ±3.6 |
| `code_128` | 100.0% | 80.5% ±5.5 | 25.0% ±6.0 |
| `code_128_fnc1` | 100.0% | 71.0% ±6.2 | **0.0%** |
| `data_matrix` | 100.0% | 99.0% | 37.0% ±6.6 |
| `qr_code` | 98.5% | 98.0% | 43.0% ±6.8 |

Every cell now carries a 95% Wilson band, so a claimed improvement can be checked against the
~6 pp of seed noise that used to be invisible. **Tier ordering holds in every cell** — the property
B1/B3 said the ladder did not have.

**Zero false accepts is not a clean bill of health.** Both known collisions — R4-F and SB-1 — are
arithmetic in Code 128's mod-103 check (R4-F's subset-B deltas sum to `-103 ≡ 0`), indifferent to
what the bench measures. They stopped appearing because the frames carrying them stopped decoding
at all. The bench now *replays both on every run* and reports whether they still read as nothing.
And a white 1920×1080 field is the **easier** case for a row-histogram binariser than a real door
jamb, which is dark and textured — so these numbers remain a ceiling.

## 3b. Round 3 — 2026-09-08 / 09, driven by field reports

Round 2 ended with *"S1 is built. It is not hardened, and it is not done."* Round 3 was not a
scheduled round. It started because a real user on the deployed build reported three things in his
own words — **"sharing button doesn't work"**, **"I scanned a car and I don't see how I can scan the
paint code"**, and, of the paint entry he did eventually find, **"well I see it but it's just typed
not scan"** — and each turned out to be a defect no automated round had found.

**15 rows fixed, 35 commits, 5 deployments, 4 rejections.**

| id | sev | what it was |
|---|---|---|
| `RCH-1` | S2 | The only door into the paint reader measured **0 of 48 px at both ends of the scroll**, at 390×844 and 320×658. Not a target-size defect and not a scrolling defect — nothing in the first screenful said a paint code existed, so there was no reason to scroll toward it. |
| `S5-5` | S2 | OCR could not start on the deployed build: a typeless `new Response(bytes)` overwrote workbox's typed cache entry, so the engine fetched an asset with the wrong Content-Type and refused it. |
| `GATE-1` | S2 | `tsc --noEmit` — the gate's typecheck **and** the first half of `bun run build` — had never read a single test. 7,553 lines of specs and helpers, unchecked. |
| `G6-a` | S2 | A red in the `light` or `pages` project still silently skipped the entire desktop e2e leg, and the exit summary did not say so. The mechanism behind a gate that once reported green while running 4 of 47 tests. |
| `ENV-1` | S2 | The fake-camera helper leaked ~5 GB per e2e run and had filled the volume to 100%, taking the suite to 17 failed / 6 did not run on `ENOSPC`. Root cause was not the missing cleanup: Playwright loads a spec module twice, so every video was written twice. |
| `SB-5-a` | S2 | The bench printed *"every cell's mean is inside §6.3's 1500 ms window"* while filtering out cells that never confirmed at all — the reassurance printed in exactly the case the number exists to catch. |
| `R3-C` | S2 | An import silently overwrote a stored `unit` and `notes` with the sender's values, and moved §4.12's LWW clock so it won on the user's other devices too. |
| `F5` | S2 | An imported record kept none of the sender's year/make/model, so the receiving phone showed and re-shared a bare VIN. The codec was not at fault — all nine §4.9 keys survive the round trip and were dropped on the way in. |
| `FR-3` `FR-4` `FR-6` | S2 | Three more instances of one defect — see below. |
| `R3-E` | S3 | A failed write's banner survived into the next check-digit hold, so two banners contradicted each other, one about a read that was gone. |
| `CP-1` | S3 | §6.4 calls itself the copy of record and was silent on two whole surfaces: the refusal explanation and every string on the paint field and its camera reader. ~40 strings shipped under §0 rule 4 and never written down. |
| `GATE-1a` `ENV-1b` `FR-7` | S4 | A guard that read the config instead of the command; nothing pinning the fake camera's bytes; a comment stating as settled a property its own scene falsified. |

### One defect in five places

`R3-F5`, `R3-E`, `FR-3`, `FR-4` and `FR-6` are the same defect: **a notice that outlives the thing
it describes, rendered beside the notice that is still true.** Two banners, two *"Keep scanning"*
buttons, one of them about a code that has left the frame (N2).

They were fixed one at a time over three days, and the pattern is worth more than any of the fixes:
**each of the last three was found by the agent that had just fixed the previous one, on the tree it
had just fixed.** Fixing one puts you in exactly the state where the next is visible.

`FR-6` is where it ended, because it stopped being a list of instances. The notice's *content* lived
in `ScanScreen`'s `useState` while its *lifetime* lived in a `state.kind` guard — so the banner could
only ever be **suppressed**, and a suppression ends when the state does. Moving one piece of state
into the machine closed the class; the production diff is **+46 / −59 non-comment lines**, a net
deletion of 13 lines of code.

### Nineteen guards, and the two the reviewer caught in this round

The through-line of round 3 is not the defects. It is that **a guard which cannot fail reads as
coverage**, and this project has now produced nineteen of them. Two were caught here, both by
mutating the tree rather than reading it:

- `ENV-1`'s first attempt was **rejected**. Its implementation was right — byte-identical video
  output across all eight callers, zero bytes leaked on a warm-cache interrupt — but two of its nine
  tests could not fail. One compared an inode to itself (both `statSync` calls ran *after* both
  writes). The other never exercised the production default, so **restoring the per-call `mkdtemp` —
  ENV-1 itself, reintroduced — passed the whole suite written to catch it.**
- `G6-b` and `GATE-1c` are open, and they are the same shape as `GATE-1a`, which landed in the same
  batch: **a guard that reads configuration rather than the command that consumes it.** Three
  instances now. The reviewer found them by turning `GATE-1a`'s own lesson on the guard beside it.

A golden value has to come from outside the thing it measures. `ENV-1b`'s digest qualifies, and the
reviewer proved it: regenerating the one-frame video with the **pre-`ENV-1` implementation** gives the
same header, length and sha256.

### The ledger misreported itself a third time

**Three staleness sweeps, three sets of stale rows: ten in round 1, two on 2026-09-08, fifteen on
2026-09-09.** The third was eight read-only auditors over every `open` row plus a completeness critic
whose only job was to find where the sweep was wrong. 49 rows read `open` across 47 distinct ids;
**15 were already fixed**, every cited sha an ancestor of HEAD, eleven of them re-read against the
current code rather than the commit message. None was wrong.

The critic earned its place by attacking the sweep's premise: `status == open` is not the same set as
*not closed*. Three real defects were outside that filter — `A22-a`, `G6-b` and, most importantly,
`GATE-2`: **the gate is red at HEAD and no row said so.** The one condition blocking §13.6 criterion
3 was the one thing the ledger did not track. It also caught a NEEDS-ZACH paragraph presenting a
decision that had already been taken, at a figure that had been retracted — anyone delivering
criterion 5's list out of that file would have shipped a question that no longer exists.

I also put a false causal claim into the ledger myself, from a fixer's report, without checking it,
and a reviewer caught it. The correction is left visible in the row rather than swapped out.

### Round 3 gate

| | |
|---|---|
| `typecheck` · `lint` | clean |
| `test` | **1877 passed / 1 failed** of 1878 (was 1394 in round 2) |
| `test:e2e` | **180 passed** (was 89) |
| `coverage` | 99.06% lines · **98.36% branches** (§13.5 bar: 95/95) |
| per-file 100% | `checkDigit` `modelYear` `extractVin` `codec` `scanMachine` — all held; `scanMachine` now 76/76 branches |
| `bench` | **FAIL — the same 14 decode-rate cells**; false accepts **0**. Every rate byte-identical to round 2's, which is the determinism claim B1/B3 wanted |
| `build` | clean |

The single red test is unchanged and unweakened: `wmi-seed.json` is `{}` until `bun run seed:wmi`
runs against vpic.nhtsa.dot.gov, and no environment in this project has ever had egress to it. It is
now tracked as `GATE-2`.

## 4. NEEDS-ZACH

Delivered as a list, per §13.6 criterion 5. The loop never resolves these. **Nine open rows plus one
question about the ledger itself**, as of 2026-09-09.

1. **`R4-F` · `SB-1` (both S1) — the §13.6 bench criterion.** Two degraded Code 128 labels decode to
   *different but mod-103-valid* VINs. 14 cells miss 99/90/70 and `code_128_fnc1` is at 0% severe.
   Meeting the criterion needs a §4.6 or §13.4 constant changed, which §13.6 forbids an agent from
   touching. **This is the only thing that gates convergence**, and it has been true since round 1.
2. **`SB-4` (S2)** — `qr_code` clean sits at 98.5% because three specific VINs never decode,
   deterministically, with ZXing as the cause. §4.6.
3. **`SB-5-b` (S2)** — `code_128` severe confirms at 2,561 ms against §6.3's 1,500 ms window. Move the
   window or accept the cell. **Note the evidence is now 83 `src/` commits stale**, and
   `bench/report.md` says so itself in SB-11's words. The `SB-5-a` fixer deliberately did not re-take
   it: swapping the basis of an open decision inside a fix commit would move the question without you
   seeing it. Re-taking it is a separate act.
4. **`M11` (S2)** — 22 production modules under `src/app`, `src/features` and `src/ui` have no unit
   test at all; `vitest.config.ts` is `environment: "node"` and there are zero `.test.tsx`. Closing it
   is a §13.5 scope change.
5. **`R3-F3` (S2) — blocked on copy, not on code.** A saved row whose stored data fails
   `normalizeVehicle` vanishes from History *and* from the count, so the app says "2 vehicles" while
   holding 3, and "Nothing to copy or export yet" while holding one. Both are §6.4 strings and both
   are false in that state. Five remedies were tried and each needs a sentence §6.4 does not have —
   including the one worth knowing, that putting the raw rows into the export makes the count honest
   and the bundle **unimportable**, trading a partial loss for a total one. **What is needed: one
   title and one body in §6.4's voice.** There is also a real WONTFIX case, since no shipped write
   path can produce such a row.
6. **`RCH-2` (S3)** — the whole middle of the vehicle sheet is reachable only by reading down it. Any
   fix is a §6.2 composition change.
7. **`GATE-1b` (S3)** — `supabase/functions/delete-account/index.ts` is now the only `.ts` file in the
   repo outside every typecheck, and it is the one place the service-role key is used. Closing it
   needs a second Deno-aware program, which is the arrangement `GATE-1` argued against, and it is S4
   code in an S1 round.
8. **`FR-10` (S4)** — one production line is not killed by any test, and the only instrument that
   could kill it is a jsdom / testing-library render. **§2's stack is locked**, so that is a
   dependency decision.
9. **§8 Q1 / `VITE_APP_HOST`** — read nowhere in `src/`; `.env.example`'s comment describes a fallback
   that does not exist.

**And one question about severity, which is one call across four rows rather than a per-row edit.**
`R3-F5`, `R3-E`, `FR-3`, `FR-4` and `FR-6` are one defect in five places. They were filed S2, S3, S2,
S2, S2. A strict reading of §13.3 makes all of them **S1**, because each is an N2 violation and §13.3
puts an N-rule violation at S1. Nothing about the work changes either way — all five are fixed. What
changes is whether §13.6's exit criteria can be counted, since they are counted by severity. No agent
re-scored anything.

(`F1`'s five microcopy strings, listed here in round 2, are no longer outstanding: `CP-1` wrote every
supplied string into §6.4 verbatim, so the copy of record now contains them.)

## 5. Why this still stops short of §13.6

Unchanged in substance from round 2, and now measured three rounds deep.

**Criterion 4** requires 99/90/70 per symbology and zero false accepts. No number of rounds reaches
it, because closing the gap needs a §4.6 or §13.4 constant changed and §13.6 forbids an agent from
touching either. Round 3's bench is byte-identical to round 2's on every rate — which is the
determinism the earlier rounds asked for, and also proof that grinding more rounds moves nothing here.

**Criterion 3** — gate green — is **unmeetable in this environment at all**, and round 3 is the first
to say so in a row rather than a footnote (`GATE-2`). One `bun run seed:wmi` on a machine with network
access to `vpic.nhtsa.dot.gov` closes it. No code changes.

**Criterion 2** — two consecutive rounds with no new S1/S2 — is unmet, and round 3 made it worse
before it made it better: the round's own reviews opened `G6-b`, `SHT-1`, `GATE-2` and `A22-a`. That
is not a failure of the round. **A round that opens new S2s is a round whose instruments got sharper**,
and the three staleness sweeps are the evidence: the ledger has misreported its own state every single
time anyone checked.

**Criterion 1** — the ledger accurate — is the one criterion round 3 can claim it improved
structurally rather than incrementally, by building the sweep that measures it.

## 6. What another round would do

In value order, and shorter than round 2's list because round 3 spent itself on the top of it:

1. **`SHT-1` (S2)** — the only genuinely actionable S2 left. Typing into a second field on the vehicle
   sheet while the first field's blur-save is in flight destroys what you typed. Real loss of a
   hand-typed field, on the screen someone uses at a paint counter.
2. **`G6-b` and `GATE-1c`** — finish the shape `GATE-1a` started. A guard that reads configuration
   rather than the command consuming it is now three instances, and the fix for both is one assertion
   each over `package.json`, using a tokeniser that already exists.
3. **`FR-8`** — the FR-6 spec's first assertion has effectively one chance in its 20 s budget and has
   failed 1 in 18 under load. Same class as ENV-1: the gate reddening for reasons unrelated to code.
4. **`FR-5`** — two of the eleven scanner-machine actions appear in no property or law suite, so no
   law is ever checked over a sequence containing them. It matters specifically because `FR-6`'s
   identity return rests on an invariant nothing states.
5. **`A22-a`** — `feedback.ts` has tests and is in neither the coverage nor the mutation glob, so
   §6.1's beep-and-vibrate path is measured by no gate.
6. **The remaining §7-item-5 rows** — `R3-J` (three call sites, not two), `R6-SA-5`, `FB-2`. Each is
   one §6.4 sentence or one constant typed out more than once.
7. **`bun run mutate` whole-suite** on a machine that can, and **`bun run seed:wmi`** with network.

## 7. §13.7 — what no agent can verify

Real door-jamb labels on real trucks · iOS installed-PWA camera · torch and focus on specific
phones · AirDrop and Nearby Share · QR readability on a phone screen in sunlight · gloved
cold-hands usability · vPIC live behaviour over time · sign-in email delivery.

**Device matrix (§7 item 4): one of four cells closed.** Android Chrome passed on 2026-09-05 with a
real door-jamb label through the camera. iPhone Safari as a tab, iPhone installed, and desktop
Chrome are open — and iOS carries the two known hazards, §6.5's synchronous-clipboard rule whose
failure is silent, and standalone-vs-tab camera behaviour. See `hardening/DEVICE_MATRIX.md`.

Also human-only, from R5: which encoding variants this fleet's labels actually use — how many
Code 39 labels carry the optional mod-43 check character (§4.2 refuses 76.0% of those), whether
any Code 128 label sets a leading FNC1, and whether MH10.8.2 labels here use FNC1 separators at
all. One photographed sample of each settles all three.

**A slice is built when §7 items 1–3, 5, 6 pass · hardened when §13.6 is met · done when the human
device matrix passes. S1 is built. It is not hardened, and it is not done.**
