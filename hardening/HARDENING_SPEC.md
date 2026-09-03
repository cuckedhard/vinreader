# HARDENING_SPEC — spec-change ledger

Audit trail for edits to `VIN_RELAY_BOOTSTRAP.md` and `CLAUDE.md`, per §13.1: agents propose diffs here, Zach approves, and only approved diffs are applied.

**Round 0 — pre-build review, 2026-09-03.** Source: a read-only review of the spec before any code existed. Every §4 constant was re-derived from the underlying standard before the spec was read, then compared value by value; the §4.2, §4.9 and §4.12 behaviours were measured with reference implementations and a live Postgres instance. Zach approved all defaults on 2026-09-03.

## Applied

| id | sev | area | spec ref | change | evidence |
|---|---|---|---|---|---|
| A01 | S1 | model year | §4.4 | The current-year cap now applies to **both** disambiguation branches; the early candidate resolves when the late one is dropped; the current year is an explicit input; `candidates` lists survivors only. | As written, rule 1 ("position 7 is a letter → the late candidate. Certain.") resolved pre-2010 Freightliner, International and Volvo VINs to 2034–2039 as facts, offline, with no ambiguity marker. That is the fleet §1.1 describes and a direct N2 violation, which §13.3 grades S1. Verified: `1FUJGLDR49SAV1234` → 2039, `1HTMMAAL67H412345` → 2037, `4V4NC9TJ98N412345` → 2038, `1FUJA6CK14LM12345` → 2034. All four have valid check digits. |
| A02 | S3 | fixtures | §4.11 | Row 3 rewritten: sum 313, 313 mod 11 = 5, so the expected check char is 5 and position 9 holds 3. | The original read "expected 3, got …" — inverted, with the actual value missing. The numbers 313 and 5 were already correct; only the prose was wrong. A test asserting the stated expectation would have failed and, under rule 2, halted S0. |
| A03 | S4 | fixtures | §4.11, Appendix B | Added fixtures: `1HGCM826X3A004350` (check digit X, sum 307), the four heavy trucks above, and `TRAILING` (18 chars). Appendix B now comments `BAD_CHECK`. | §13.5 demands 100% branch coverage on `checkDigit.ts` and `modelYear.ts`, but no fixture exercised a remainder of 10, and none covered the §4.4 cap on the letter branch. All computed and verified. |
| A04 | S2 | tooling | §2, §7 item 1, §13.5, anchor Commands | `bun test` → `bun run test` at all four command sites. | Verified on Bun 1.3.11: `bun test` runs Bun's own runner, rewrites `vitest` imports to `bun:test` and passes without Vitest installed, ignores `vitest.config.ts` thresholds, sweeps `tests/e2e` into the run, and reports no branch data — so the §13.5 coverage clause is unmeasurable under it. A §13 agent executing the anchor verbatim would gate on the wrong runner. |
| A05 | S4 | routing | §10, anchor | The S0 routing row and the anchor's reading line now name `S0_DECISIONS.md`. | §10 otherwise gives the S0 session no channel to receive decisions taken before the build. |

### Round 1 — vehicle coverage, 2026-09-03

Zach: "make sure this can read every vehicle not just heavy trucks." Three places assumed a North American truck. All measured before changing anything; scripts under `scratchpad/everyvehicle/`.

| id | sev | area | spec ref | change | evidence |
|---|---|---|---|---|---|
| A06 | S1 | check digit | §4.3, §6.3, §6.4, §4.11 | A mismatch blocks only when `checkDigitApplies(vin)` — position 9 is a digit or `X`. Otherwise the scan proceeds with a neutral note. | A check digit can only be `0`–`9` or `X`, so a letter at position 9 proves none exists. Measured over 200,000 random grammar-valid identifiers: 97.0% fail §4.3, and 66.6% carry a letter other than `X` at position 9. Without the predicate every vehicle that uses no check digit — anything never sold in North America, and the off-highway PINs §4.7 puts in scope — hits "usually a misread" on every single scan. `checkDigitValid` and the stored schema are untouched. |
| A07 | S2 | extraction | §4.2, §4.11 | Step 4(a) prefers, among check-valid windows, one spanning a whole run, then start-aligned, then end-aligned, then the first. | Closes O07. Verified: all fourteen fixture and stress cases match expectation, `1HGCM82633A0043531HGCM82633A004352` now returns the real VIN instead of `M82633A0043531HGC`, a VIN embedded in surrounding data is still found 72.5% of the time as before, and false extraction from a payload URL is unchanged at 44.2% (D14 keeps payloads away from `extractVin`). A broader fallback was tested first and rejected: it drove false extraction to 99.3%. |
| A08 | S3 | WMI seed | §4.5 | Candidate list widened from 23 heavy-truck WMIs to five classes covering trucks, pickups, cars, imports, motorcycles and trailers. | §4.5 already drops unresolved candidates, so breadth costs one API call each. Without it a passenger car shows no manufacturer offline. |

## Open — NEEDS-ZACH

Verified, not applied. None blocks S0.

| id | sev | area | spec ref | finding |
|---|---|---|---|---|
| O01 | S2 | sync | §4.12 | The SQL skeleton never adds `vehicles` to the `supabase_realtime` publication, so `postgres_changes` cannot fire. Confirmed by inspection of the skeleton and of `pg_publication_tables` after running it. |
| O02 | S2 | sync | §4.12, §5.8 | The pull cursor `updated_at >= max received` misses rows committed out of timestamp order. Reproduced with two concurrent transactions: the row from the longer transaction carries an earlier timestamp, commits after the cursor advanced past it, and is never pulled. |
| O03 | S2 | merge | §5.3, §4.12 | §5.3 keeps an existing `partial` or `unsupported` decode forever; §4.12 lets a higher rank win. §4.12 claims the rules are "identical on server and client". They are not. |
| O04 | S1 | sync | §4.12 | `apply_scan_event` seeds `meta_updated_at` from the scan time, so a device's offline unit edit is discarded when another device first-scans the same VIN later and pushes first. D11 protects the client side; the trigger still needs a sentinel seed. |
| O05 | S2 | payload | §4.9 | `at`, `u` and `by` are neither in the drop order nor in the never-drop list, and no behaviour is defined when the URL still exceeds 700 bytes after every droppable field is gone. Measured floor with all droppables removed: 335 bytes. |
| O06 | S2 | microcopy | §6.4 | No microcopy exists for `no_camera`, `stream_lost`, the `requesting` state, or any import rejection path, against P7's requirement that every error state has copy. |
| O08 | scope | grammar | §4.1 | Exactly 17 characters is required, so pre-1981 vehicles and equipment with shorter serials cannot be entered at all. A deliberate limit; widening it is a scope decision, not a defect fix. |
| O09 | S3 | symbology | §4.6 | Four symbologies are enabled. Whether any label class in this fleet uses another is answerable only against real labels, in the S1 bench. |

*Closed in round 1: O07, by A07.*

## Environment note

`vpic.nhtsa.dot.gov:443` is refused by the build environment's egress proxy (CONNECT 403, curl exit 56, all attempts). The §4.8 field map, the DecodeWMI response key names and the heavy-truck year counterexamples therefore rest on knowledge, not on a live call. §4.8 verification is already S2's job per the spec; the WMI seed is D09.
