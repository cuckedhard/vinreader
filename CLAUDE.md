# CLAUDE.md — VIN Relay

Read this, then `VIN_RELAY_BOOTSTRAP.md` §0–§8 and the routing row (§10) for the slice you were told to start, plus any decisions addendum that row names (`S0_DECISIONS.md` for S0). Nothing else.

## Rules that never bend
1. **Build nothing until Zach says `start S<n>`.** Plan and ask freely; write no code before that.
2. **Constants in §4 are authoritative.** Check-digit weights, transliteration, year table, symbologies, vPIC field map, payload codec, enums. Never re-derive, never "fix" silently. If one looks wrong, stop and say so.
3. **One slice per session.** Load only what the routing table lists.
4. **Ask before assuming** on anything in §8. Smallest reasonable decision otherwise, logged in the session report.
5. **Scan never blocks on network.** Structural decode always saves offline; vPIC fills in later.
6. **Never show a guess as a fact.** Ambiguous year shows both candidates; empty vPIC fields are not rendered.
7. **Data leaves the device only on user action** (share / QR / copy / export), the VIN-only vPIC lookup, or sync to the user's own account when signed in. No analytics, no third-party scripts.
8. **Pure core.** `src/lib/vin/` and `src/lib/payload/` contain no DOM, React, or I/O. Tests live there.
9. **Records are keyed by VIN and upserted** (§5.3). No duplicates, ever.
10. **Field-usable UI.** Targets ≥ 48 px (primary ≥ 56 px), no long-press/swipe/pinch, dark high-contrast default, VIN in large grouped monospace.
11. **Hardening loop only on `harden spec` / `harden S<n>`** (bootstrap §13). Subagents in `.claude/agents/`; only `fixer` edits `src/`; auditors are read-only; constants, N-rules and scope changes go to the NEEDS-ZACH list, never applied by agents. Stops at `R_MAX = 6` rounds or the §13.6 exit criteria, whichever comes first.
12. **Sign-in is optional; local-first stays.** Everything works signed out. Sync is an outbox with client UUIDs, idempotent pushes, one pull path, merge rules from bootstrap §4.12. RLS on every table; the service-role key exists only in the `delete-account` Edge Function. Clipboard writes stay synchronous inside the tap handler.

## Stack (locked — §2)
Bun · Vite · React + TypeScript strict · react-router `HashRouter` · Tailwind + `tokens.css` · ZXing (`@zxing/browser`, `@zxing/library`) · `qrcode` · Dexie + `dexie-react-hooks` · `zod` · Vitest · `vite-plugin-pwa` (`registerType: "prompt"`) · `@vitejs/plugin-basic-ssl` for on-device dev · Supabase Auth (email OTP) + Postgres with RLS + Realtime (S4 only).

## Layout
See Appendix A of the bootstrap. Pure logic in `src/lib/*`, screens in `src/features/*`, primitives in `src/ui/`, agents in `.claude/agents/`, ledgers and reports in `hardening/`, scan corpus and bench in `bench/`, auth and sync in `src/lib/auth/` and `src/lib/sync/`, backend in `supabase/`.

## Commands
`bun install` · `bun run dev` (HTTPS, `--host`) · `bun run typecheck` · `bun run lint` · `bun run test` · `bun run test:e2e` · `bun run bench` · `bun run mutate` · `bun run build` · `bun run seed:wmi` · S4: `supabase start` · `supabase db push` · `supabase functions deploy delete-account`

## Triggers (from Zach, verbatim)
`start S<n>` — build slice n · `harden spec` — audit the bootstrap, propose diffs, apply only approved ones · `harden S<n>` — run the §13 loop on slice n until §13.6 or budget

## Definition of done (§7)
Typecheck + lint + tests green · works offline · no regressions · manual device matrix (iPhone Safari tab **and** installed, Android Chrome, desktop Chrome; real door-jamb labels for camera slices) · session report delivered · version record below updated. **Built ≠ hardened ≠ done** (§13.7): hardening is automated, the device matrix is human.

## Version record (fill after each install)
| Package | Version | Slice |
|---|---|---|
| | | |
