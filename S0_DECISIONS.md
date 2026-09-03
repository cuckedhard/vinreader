# S0 decisions addendum

Companion to `VIN_RELAY_BOOTSTRAP.md`, named in the §10 routing row for S0. It exists because §10 gives the S0 session no other channel to receive decisions made before the build starts.

**Status:** every item below was approved by Zach on 2026-09-03 ("default on everything") after the pre-build spec review. Items marked *applied* are already edited into the spec or the anchor; see `hardening/HARDENING_SPEC.md` for the exact diffs. Everything else is a §0 rule 4 decision the S0 session implements and echoes in its session report.

Nothing here changes a §4 constant except D04, which Zach approved explicitly and which is recorded as an applied diff.

## Decisions

| # | § | Decision |
|---|---|---|
| D01 | §8 Q1 | Name stays **VIN Relay**. Host is a placeholder in `.env.example`. Rename-proof identifiers are fixed now and never track the display name: Dexie database `vinrelay`, manifest `id: "/"`, export bundle `app: "vin-relay"`, share file prefix `vin-relay-<vin>.json`. |
| D02 | §8 Q2 | Unit / asset tag is **optional**. The manual-entry form does not ask for it; the Sheet ships the unit and notes fields in S0, so `metaUpdatedAt` edits exist from S0. |
| D03 | §6.3, §4.3 | **The check-digit banner gates persistence.** On `checkDigitValid === false` nothing is written — no vehicles row, no `scanEvents` row, no decode kick, no outbox row — and no success feedback fires. Only "Use as-is" persists, with `checkDigitValid: false` and the warning badge. In S0 manual entry the same rule holds: a submit with a failing check digit is held behind an explicit **Use as-is** step, with **Edit** as the primary action. No beep and no "Got it ✓" on a mismatch. |
| D04 | §4.4 | *Applied.* The current-year cap applies to **both** branches, and the early candidate resolves when the late one is dropped. `modelYear(vin, currentYear)` takes the year as an argument and never reads the clock, so tests are deterministic. `candidates` lists survivors only. |
| D05 | §4.2 | **Kept exactly as written.** Step 4(a) can prefer a straddling window inside a run longer than 17, and step 1 joins runs across whitespace. Both are implemented as specified and pinned as documented-behaviour tests, with the weakness logged in the session report rather than silently fixed. |
| D06 | §4.5, §5.1 | Position-1 `0` is grammar-valid but has no region. `structural.region` is typed `Region \| null` with `country: null`; the region row is omitted from the sheet (N2). The §4.10 `Region` enum is untouched. |
| D07 | §2, §7.1, §13.5 | *Applied.* The gate is `bun run test`, never `bun test` — Bun's own runner silently rewrites `vitest` imports, ignores `vitest.config.ts` thresholds and reports no branch coverage. `package.json` gets `"test": "vitest run"`, and a `bunfig.toml` preload throws on an accidental `bun test`. |
| D08 | §2 | Version pins, recorded in the anchor's version record at install: **typescript 6.0.3** (typescript-eslint's peer range stops below 6.1, so latest 7.0.2 cannot lint green) and **vitest + @vitest/coverage-v8 4.1.11** (5.0.0 shipped 2026-09-03; Stryker's vitest runner predates it and mutation is required from S2). Everything else takes current stable. |
| D09 | §4.5, §9-S0 | `vpic.nhtsa.dot.gov:443` is refused by the build environment's egress policy, so `bun run seed:wmi` cannot run there. S0 ships `scripts/build-wmi-seed.ts` and commits `wmi-seed.json`: real output if the host is reachable in the S0 session, otherwise `{}` with the gap logged, for Zach to regenerate locally. `1HG` is added to the candidate list so the §4.11 fixture VIN shows a manufacturer. |
| D10 | §8 Q5 | Hosting is chosen at S0 sign-off, not in code. A cloudflared tunnel or a preview deploy is acceptable for the install and offline device matrix; `@vitejs/plugin-basic-ssl` alone cannot register a service worker on iOS. |
| D11 | §5.1, §4.12 | `metaUpdatedAt` is **epoch** (`1970-01-01T00:00:00.000Z`) on create, for every origin. Only a user edit to unit or notes — or an import landing non-empty values — sets the device clock. The re-scan branch never touches it. Seeding it from scan time lets a later fresh scan wipe another device's edit through last-writer-wins. |
| D12 | §5.3, §4.12 | §5.3 governs **local writes only** (scan, manual, import). "cloud-pull" in that sentence is an erratum: S4 gets a separate apply path where server aggregates overwrite local values, with no synthetic scan events and no outbox rows. S0 builds the upsert accepting `scan \| manual \| import` only. |
| D13 | §9-S4, N7 | Delete account signs out and then shows the same **Keep / Clear this phone** prompt as sign-out. N7 wins over the slice text; the confirmation copy says what happens to this phone. |
| D14 | §6.3, §9-S3 | In `streaming`, the raw decoded string is tested for a §4.9 carrier — a fragment beginning `/i?d=` or a `VINRELAY1:` prefix — **before** `extractVin` runs. A match stops the stream on one read and routes to Import. Only non-carrier results reach `extractVin`. S1 ships the predicate; S3 fills it in. Without this, roughly 5 to 10 percent of the app's own QR payloads confirm a fabricated VIN. |
| D15 | §6.3 | Manual entry has **no `maxlength`**. `extractVin` runs on the raw field value, so the I-prefixed form (18 chars) and the grouped display form (22 chars) both work. "17-char input" describes the normalized VIN. |
| D16 | §5.6, §6.2, §6.4 | Small S0 defaults: `deviceLabel` defaults to empty and is prompted once in Settings; `sound`, `haptics` and `autoDecode` default true; "Clear all data" requires typing `DELETE`; History empty, no-search-results and unknown-VIN Sheet states each get plain microcopy in the P7 style. |

## Not decided here

These stay open and are not S0's to settle. They are listed in `hardening/HARDENING_SPEC.md` with the evidence.

- §4.12 never adds `vehicles` to the `supabase_realtime` publication, so the realtime signal cannot fire (S4).
- The pull cursor `updated_at >= max received` can miss rows committed out of timestamp order (S4).
- §5.3 and §4.12 state different decode-merge rules while §4.12 claims both sides are identical (S4).
- §4.9 leaves `at`, `u` and `by` neither droppable nor protected under the 700-byte cap, and defines no behaviour when the URL is still too long (S3).
- §6.4 has no microcopy for `no_camera`, `stream_lost`, or any import rejection (S1, S3).
