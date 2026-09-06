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

## 4. NEEDS-ZACH

Delivered as a list, per §13.6 criterion 5. The loop never resolves these.

1. **B1/B3 · R4-F · SB-1 — the §13.6 bench criterion.** 14 cells missed, `code_128_fnc1` at 0% severe. Meeting 99/90/70 needs either a §13.4 tier change or an acceptance that this is what ZXing gives you on this corpus.
2. **SB-4** — `qr_code` clean 98.5% is three specific VINs that never decode, deterministically, with ZXing as the cause. §4.6.
3. **SB-5-b** — `code_128` severe confirms at 2,561 ms against §6.3's 1,500 ms window. Move the window or accept the cell.
4. **M11** — 26 production files have no unit test at all; `vitest.config.ts` is `environment: "node"` and there are zero `.test.tsx`. Closing it is a §13.5 scope change.
5. **F1's five microcopy strings** — supplied under §0 rule 4, pinned verbatim by a test, still unsigned.
6. **§8 Q1 / `VITE_APP_HOST`** — read nowhere in `src/`; `.env.example`'s comment describes a fallback that does not exist.

## 5. Why this stopped short of §13.6

Criterion 4 requires 99/90/70 per symbology and zero false accepts. **No number of rounds reaches
it**, because closing the gap needs a §4.6 or §13.4 constant changed and §13.6 forbids an agent
from touching either. Criterion 2 — two consecutive rounds with no new S1/S2 — is also unmet:
round 2's own reviews opened two fresh S2s.

Continuing would grind S3 and S4 conformance while the thing that actually gates convergence sits
untouched. §13.6's budget rule exists for exactly this, so the loop stops here and reports.

## 6. What another round would do

In value order: fix `SB-5-a`'s unfalsifiable sentence (a fifth guard that cannot fail); fix `FB-1`,
where §6.6's table fits at 1280 px and no width below it and a §6.5 copy button has zero visible
pixels from 900 px up; run `bun run mutate` whole-suite on a machine that can; and take one run of
`bun run seed:wmi` with network to close the last red test.

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
