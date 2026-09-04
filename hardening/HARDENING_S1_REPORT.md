# HARDENING_S1 — final report (§13.8)

`harden S1`, one round. The loop **did not converge** and stopped deliberately. §13.6 cannot be reached from inside it: criterion 1 requires zero open S1/S2, and the one S1 is a §4 constant change that CLAUDE.md rule 2 and §13.6's own hard stop forbid any agent from making.

## Rounds run

One, plus its review. §13.3's five steps all executed: audit (five roles in parallel), triage, fix, gate, check. `R_MAX` was 6; the loop used 1 and stopped on a hard stop, not on budget.

## Findings by severity

| sev | found | fixed | open                        |
| --- | ----- | ----- | --------------------------- |
| S1  | 1     | 0     | 1 (NEEDS-ZACH)              |
| S2  | 11    | 10    | 1 (NEEDS-ZACH)              |
| S3  | 14    | 8     | 6 (2 NEEDS-ZACH, 4 carried) |
| S4  | 7     | 6     | 1                           |

36 raw findings from four auditors plus 4 from the bench, deduplicated to 29. Five were reported independently by two or three roles. The reviewer then rejected the fix diff and raised 4 more, all addressed.

## Gate

| check               | result                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `bun run typecheck` | pass                                                                                      |
| `bun run lint`      | pass                                                                                      |
| `bun run test`      | 613 pass                                                                                  |
| `bun run test:e2e`  | 21 pass                                                                                   |
| coverage            | 100% lines, 98.7% branches; 100% on checkDigit, modelYear, extractVin, codec, scanMachine |
| `bun run bench`     | **fails** — 6 threshold cells, all traceable to NEEDS-ZACH tier calibration               |
| `bun run mutate`    | **does not exist** — the §13.5 mutation clause has never run                              |

## Bench (§13.4), 200 VINs · 5 symbologies · 3 tiers · 3,000 attempts · seed 0x5eed1a7c

| symbology   | clean (≥99%) | moderate (≥90%) | severe (≥70%) |
| ----------- | ------------ | --------------- | ------------- |
| code_39     | 100.0%       | 77.5% ✗         | 80.5%         |
| code_39_i   | 100.0%       | 79.0% ✗         | 73.5%         |
| code_128    | 100.0%       | 81.0% ✗         | 85.5%         |
| data_matrix | 100.0%       | 99.0%           | 53.5% ✗       |
| qr_code     | 98.5% ✗      | 97.5%           | 0.0% ✗        |

**False accepts: 0.** Decode time mean 9.6 ms, p95 37.1 ms.

Read the misses with care. Moderate scores _worse_ than severe on every 1D symbology, because `moderate` blurs and `severe` does not — the tiers are not ordered, so the 99/90/70 ladder cannot mean what it intends (Z2). The 2D severe cells are governed by a glare band sized to the image diagonal (Z3). And the harness is not the app's decode path: a payload QR it scores as a miss is read correctly by the real scanner in Chromium, verified. **No number in this table should be read as a statement about the shipped scanner until Z2, Z3 and B2 are settled.**

> **B2, settled and measured (later round).** The bench now decodes in Chromium through the app's own `BrowserMultiFormatReader` and hints (`bench/browser-entry.ts`), and every frame is degraded once and read by both instruments so the difference is reported cell by cell. **The difference is zero** — over 4,200 frames at seed `0x5eed1a7c`, `canvas` and the old `rgb` node path each read 2,839 correctly, with no frame read by only one and no frame whose decoded text differed by a byte. On a grey corpus the two luminance sources compute the same buffer, and the two configuration differences behind them (`isRotateSupported()`'s 90° `TRY_HARDER` retry; `decodeWithState` against `decode(bitmap, hints)`) change nothing here. So the "not the app's decode path" clause of this caveat is **retired**: the numbers in the table above were statements about the shipped scanner after all, and the ones in `bench/report.md` now are so by construction rather than by luck. The rest of the caveat stands on Z2 and Z3. What is *not* zero is the camera itself — see B2a: through Chromium's fake capture device a frame reads slightly **worse** (67/105 against 69/105 on a subset), deterministically, from the studio-swing colour expansion of a `C420` stream.

## What was fixed

The §6.3 cooldown, which could not work at all: the machine lived in component state and every successful scan navigated away and destroyed it, leaving the double-logging §6.3 names by name unguarded. A tab hidden over 30 s not re-requesting the camera. Both §6.3 windows compared one-sidedly, so a backwards clock jump cooled down every scanned VIN forever. A decode after the tab hid rebuilding a dropped candidate. "Got it ✓" firing beside a mismatch banner. A fatal ZXing error silently ending the scan loop. §4.6 defined twice and pinned by no test. Scan events never recording the device label. One corrupt row white-screening History. Two Use as-is taps writing two events. Plus target sizes, contrast, stale strings and dead code.

## NEEDS-ZACH

Four items, in `hardening/HARDENING_S1.md`. **Z1 is the one that matters.**

**Z1 (S1) — §4.2 accepts a wrong VIN as check-digit-valid whenever anything legal precedes it.** `extractVin("UNIT B\nCM82633A004352…")` returns a 17-character string nobody printed, marked valid. Verified directly. The two-read rule agrees because a 2D code decodes identically every frame; §4.3's gate is satisfied because the check digit genuinely validates. About 1–6% of multi-field payloads. This is §13.6 criterion 4 — false accepts must be zero — reached through a §4 constant, so no agent may touch it.

Z2, Z3: the bench tiers. Z4: the light theme §6.1 promises is unreachable.

## What the loop could not verify (§13.7)

Everything that needs a truck. Real door-jamb labels, curved, scuffed and sun-glared. The iOS installed-PWA camera, which has historically differed from the Safari tab. Torch and focus on specific phones. Gloved hands in cold. The bench is synthetic and, as Z2/Z3 show, was mis-calibrated; it tunes hints and confirmation logic and closes nothing in §7 item 4. B2 is settled — it decodes through the app's own reader in Chromium now, at a measured difference of zero — and B2a bounds what is left: a frame through Chromium's own capture pipeline reads 2 of 105 fewer than the same frame drawn from a PNG, and no synthetic frame at all has been through a lens.

Also unverified here: the §13.5 mutation clause, which has no script; and the bench's own blind spot — every corpus image renders a VIN alone, which is precisely why it reported zero false accepts while Z1 sat in the extractor.

## What another round would do

Little, until Z1 is answered. The remaining open items are S3 and S4, and the bench cannot produce a trustworthy verdict while its tiers are unordered. The useful order is: settle Z1, fix the tier definitions, add multi-field payloads to the corpus, then run rounds 2 and 3 to satisfy §13.6's two-clean-rounds rule.
