# VIN Relay — Bootstrap Spec (v1)

> Working name. Rename freely; nothing below depends on it.
> One file = the whole v1 spec package. Thin constitution (§1–§8) + thick vertical slices (§9) + routing (§10).

---

## 0. How to use this document (Claude Code: read this first)

**Standing rules (Zach's, non-negotiable):**
1. **Build nothing until Zach says `start S<n>`.** Reading, planning, and asking questions are fine. Writing code is not.
2. **Follow stated constants exactly — never re-derive.** Check-digit weights, transliteration, year table, symbology list, field map, payload codec, enums (§4) are authoritative. If one looks wrong, say so and stop; do not "fix" it silently.
3. **One slice per session.** Load `CLAUDE.md`, §0–§8, the routing row for the slice (§10), and that slice's section in §9. Do not load other slices.
4. **Ask before assuming** on anything in §8. Otherwise, make the smallest reasonable decision and log it in the session report.
5. **End every slice with a session report:** what was built, exact library versions installed (fill the version record in `CLAUDE.md`), deviations from spec and why, open questions, and the manual test results (§7).
6. **The hardening loop (§13) runs only on `harden spec` or `harden S<n>`.** It fixes defects against this spec. It never changes §4 constants, N-rules, or slice scope — those go to Zach as NEEDS-ZACH items.

---

## 1. Purpose & non-negotiables

### 1.1 What it is
A mobile-first **installable web app (PWA)** that:
1. **Scans** the barcode on a vehicle's door-jamb certification label with the phone camera.
2. **Extracts and validates the VIN** locally, instantly, offline.
3. **Decodes** the VIN into a readable vehicle sheet (year, make, model, engine, GVWR, plant, …) using NHTSA's free vPIC service, cached forever per VIN.
4. **Hands the record off** to any other phone or computer with one tap: system share sheet (AirDrop / Nearby Share / text / email), QR code, clipboard, file export.
5. **Optionally signs in**, so the same VIN history appears on every device the user opens the app on — phone or computer — with one-tap copy of any record in the format the next tool needs (VIN, summary, spreadsheet row, JSON).

Primary user: someone standing next to a truck outdoors, possibly gloved, cold, in glare or in the dark, possibly with no signal.

### 1.2 Non-negotiables (no slice may violate these)
- **N1 — Scan never blocks on network.** A scan always produces a saved record with the structural decode (§4.1–§4.5) even with zero connectivity. vPIC data fills in later.
- **N2 — Never show a guessed value as a fact.** Ambiguous model year shows both candidates. Failed check digit is surfaced, not hidden. vPIC fields that are empty are not shown at all.
- **N3 — Data leaves the device only on an explicit user action** (share, QR, copy, export), **the vPIC lookup** (VIN only), **or — when the user is signed in — sync to that user's own account** (§4.12). No analytics, no telemetry, no third-party scripts.
- **N4 — Camera and share require a secure context.** Production is HTTPS. Dev on a real phone uses HTTPS too (§2).
- **N5 — Field-usable.** Touch targets ≥ 48 px (primary ≥ 56 px), no long-press or multi-finger gestures, dark high-contrast theme by default, VIN always shown large and grouped (§6.1).
- **N6 — Constants are authoritative** (§4). Tests pin them.
- **N7 — Signing in is optional and never a gate.** Every feature works signed out. Local data goes to the account only when the user chooses to add it, and signing out never destroys local data without an explicit "clear this phone" choice.

---

## 2. Stack lock

No substitutions without an explicit decision from Zach.

| Concern | Choice | Notes |
|---|---|---|
| Runtime / package manager | **Bun** | `bun install`, `bun run`; tests run as `bun run test` (a package script → Vitest). `bun test` is Bun's own runner and must not be used as the gate. |
| Build | **Vite** | `vite-plugin-pwa` for manifest + service worker (Workbox) |
| UI | **React + TypeScript (strict)** | Function components + hooks only. No state library. |
| Routing | **react-router, `HashRouter`** | Hash routes keep the app static-host-trivial and keep handoff payloads (§4.9) out of server logs |
| Styling | **Tailwind** + a small `tokens.css` of CSS variables | Tokens in §6.1 |
| Barcode decoding | **ZXing** (`@zxing/browser`, `@zxing/library`) | The only decoder in v1. Native `BarcodeDetector` is a later optimization, not a v1 code path. |
| QR generation | `qrcode` | Error correction level **M** |
| Local storage | **Dexie** (IndexedDB) + `dexie-react-hooks` | Schema in §5. No `localStorage` for records. |
| Validation | `zod` | All imported payloads and files pass through a schema |
| Tests | **Vitest** | Unit tests for everything in §4; fixtures in §4.11 |
| Dev on device | `@vitejs/plugin-basic-ssl` (`vite --host`) or a `cloudflared` tunnel | Camera needs HTTPS off-localhost |
| Hosting | Any static host with HTTPS (Cloudflare Pages / Netlify / Vercel) | Zach picks (§8) |
| Accounts & sync (S4 only) | **Supabase**: Auth (email OTP) · Postgres with RLS · Realtime `postgres_changes` · one Edge Function | `supabase` CLI for migrations and local testing. Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The service-role key never reaches the client. |
| Hardening loop (§13) | Playwright (Chromium) · `fast-check` · `axe-core` · `bwip-js` · `sharp` · `ffmpeg` · StrykerJS | Dev-only. Nothing here ships in the bundle. |

**Versions:** use current stable at install time. This document pins no versions. Record what was installed in `CLAUDE.md` → *Version record*.

---

## 3. Architecture principles

- **P1 — Offline-first, local-first.** Dexie is the source of truth on the device. The network is an enhancement.
- **P2 — Two-stage decode.** *Structural* (pure functions, instant, offline: §4.1–§4.5) then *catalog* (vPIC, async, cached: §4.7). The UI renders structural immediately and upgrades in place.
- **P3 — Pure core.** Everything in `src/lib/vin/` and `src/lib/payload/` is pure TypeScript with no DOM, no React, no I/O. That is where the tests live.
- **P4 — Idempotent writes.** Records are keyed by VIN. Re-scanning or re-importing the same VIN upserts (§5.3); it never duplicates.
- **P5 — One codebase, two roles.** The same PWA runs on the phone (scanner) and on a computer (desk receiver, S4). No separate desktop app.
- **P6 — Versioned payloads.** Every cross-device format carries `v`. Unknown major version → clear rejection message, never a crash.
- **P7 — Fail loudly to the user, quietly in the log.** Every error state has microcopy (§6.4). No silent catch-and-ignore.
- **P8 — Events are the truth, rows are caches, RLS is the wall.** Server-side, `scan_events` is append-only and `vehicles` aggregates are derived by trigger; every table is row-level-secured to `auth.uid()`; the client holds only the anon key (§4.12).

---

## 4. Authoritative constants

### 4.1 VIN grammar
- Exactly **17** characters.
- Alphabet: `A–Z` and `0–9` **excluding `I`, `O`, `Q`**. Regex: `^[A-HJ-NPR-Z0-9]{17}$`
- Positions (1-indexed):

| Pos | Field | Notes |
|---|---|---|
| 1–3 | **WMI** — World Manufacturer Identifier | Pos 1 = region (§4.5) |
| 4–8 | **VDS** — Vehicle Descriptor Section | Manufacturer-specific; not decoded structurally |
| 9 | **Check digit** | §4.3 |
| 10 | **Model year code** | §4.4 |
| 11 | **Plant code** | Shown raw |
| 12–17 | **Serial** | Shown raw |

Display grouping (always, monospace): `WMI VDS C Y P SERIAL` → e.g. `1HG CM826 3 3 A 004352`

### 4.2 Normalization: raw scan → VIN (`extractVin(raw)`)
1. Uppercase. Strip whitespace and `*` (Code 39 start/stop, if a decoder ever passes them through).
2. Split the string into **runs** of allowed characters (`[A-HJ-NPR-Z0-9]+`). Any other character is a separator.
3. Over every run of length ≥ 17, slide a 17-char window. Collect windows that match the grammar.
4. Choose, in order: (a) the first window whose check digit is valid; (b) if none, and exactly one grammar-valid window exists, that window with `checkDigitValid = false`; (c) otherwise → `NO_VIN`.
5. Return `{ vin, raw, checkDigitValid }`.

Covered cases (these are tests):
- Plain 17-char Code 39 → the VIN.
- **Leading `I`** (ANSI MH10.8.2 data identifier for VIN, common on door labels): `I1HGCM82633A004352` → `I` is not an allowed char, so it splits off → `1HGCM82633A004352`.
- A 2D code carrying JSON or delimited text that contains the VIN → extracted from the run.
- Garbage / partial reads → `NO_VIN`, scanner keeps going.

### 4.3 Check digit (position 9)
Transliteration (letters → values; digits are themselves):

```
A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8
J=1 K=2 L=3 M=4 N=5 P=7 R=9
S=2 T=3 U=4 V=5 W=6 X=7 Y=8 Z=9
```

Weights by position 1–17:

```
8 7 6 5 4 3 2 10 0 9 8 7 6 5 4 3 2
```

`sum = Σ value(pos) × weight(pos)`; `remainder = sum mod 11`; expected check char = remainder, or `X` if remainder is 10. Valid iff position 9 equals the expected char.

Policy: the check digit is mandatory for North-American-market vehicles (pos 1 in `1–5`). A failure is almost always a **misread**, so the scanner prompts a rescan (§6.3). The user may accept anyway ("Use as-is"); the record then carries `checkDigitValid: false` and shows a warning badge. Never hard-block.

### 4.4 Model year (position 10)
Allowed codes and the two candidate years (30-year cycle):

```
A 1980/2010  B 1981/2011  C 1982/2012  D 1983/2013  E 1984/2014
F 1985/2015  G 1986/2016  H 1987/2017  J 1988/2018  K 1989/2019
L 1990/2020  M 1991/2021  N 1992/2022  P 1993/2023  R 1994/2024
S 1995/2025  T 1996/2026  V 1997/2027  W 1998/2028  X 1999/2029
Y 2000/2030  1 2001/2031  2 2002/2032  3 2003/2033  4 2004/2034
5 2005/2035  6 2006/2036  7 2007/2037  8 2008/2038  9 2009/2039
```
Not valid in position 10: `I O Q U Z 0`.

Disambiguation (structural stage only; vPIC `ModelYear` overrides when present). The current year is an explicit input to this function, never read from the clock inside it. Compute both candidates, then apply in order:
0. **Cap — applies to both branches below.** Drop any candidate greater than the current year + 1. `candidates` lists the survivors only. The early candidate is never dropped (2009 is its maximum), so at least one always survives.
1. If **position 7 is a letter** → the 2010–2039 candidate, *provided it survived the cap*. Certain. If the cap dropped it, the 1980–2009 candidate is the only survivor and is `resolved`. Pre-2010 heavy trucks routinely carry a letter in position 7, so this is a common case in this app's fleet, not an edge case: `1FUJGLDR49SAV1234` → 2009, never 2039.
2. If position 7 is a digit → for light-duty vehicles this indicates 1980–2009, but the rule is **not reliable for heavy trucks and equipment**, which are exactly this app's fleet. So while both candidates survive the cap the year stays ambiguous: `modelYear = { candidates: [early, late], resolved: null }` and the UI shows **"1996 or 2026"** until vPIC resolves it (N2). When the cap leaves one survivor, it is `resolved`.

### 4.5 WMI region (coarse — vPIC `Manufacturer` / `PlantCountry` are authoritative)
Position 1 → region: `A–H` Africa · `J–R` Asia · `S–Z` Europe · `1–5` North America · `6–7` Oceania · `8–9` South America.

Specific countries shown when the first character is: `1`,`4`,`5` United States · `2` Canada · `3` Mexico · `J` Japan · `L` China · `W` Germany. Otherwise show the region only.

**WMI → manufacturer seed.** Do **not** hand-type a manufacturer table. `scripts/build-wmi-seed.ts` takes a candidate list of WMIs, calls vPIC `DecodeWMI/{wmi}` for each, and writes `src/lib/vin/wmi-seed.json` (`{ wmi: { manufacturer, make? } }`). Unresolved candidates are dropped. The committed JSON is the artifact. Starting candidate list (verify, drop any that fail): `1FT 1FD 1FM 1FV 1FU 1GC 1GB 1GT 1GK 3GC 1C6 1C4 3C6 1XK 1XP 1M1 1HT 4V4 1N6 5TF JTE 1J4 WDB`. At runtime, every successful vPIC decode also upserts its WMI into a local `wmi` cache table (§5), so the seed grows with use.

### 4.6 Barcode symbologies
Enabled in ZXing hints (`POSSIBLE_FORMATS`), in priority order: **CODE_39, CODE_128, DATA_MATRIX, QR_CODE**. `TRY_HARDER = true`. Nothing else in v1.

Rationale: door-jamb certification labels carry the VIN as Code 39 (most common) or Code 128; some newer labels add a Data Matrix or QR. QR is also the app's own handoff format (§4.9).

### 4.7 vPIC contract (NHTSA)
- Endpoint: `GET https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{VIN}?format=json`
- No API key. Response shape: `{ Count, Message, SearchCriteria, Results: [ { ...flat string fields } ] }`. Use `Results[0]`. Every field is a string; empty string = unknown.
- `ErrorCode === "0"` → `decode.status = "ok"`. Any other value → `"partial"`, keep populated fields, show `ErrorText` in the sheet's notice area. Network/timeout/5xx → `"pending"` (retry later, §5.4).
- Client rules: timeout **10 s**; up to **3 attempts** with backoff 2 s / 6 s; one request per VIN ever (cache is permanent; a manual "Refresh details" button on the sheet is the only way to re-fetch).
- Off-highway machines (loaders, dozers, excavators) have 17-character PINs that vPIC does not decode. If the result carries no `Make` and no `Model`, set `decode.status = "unsupported"` and show the off-highway microcopy (§6.4). Structural fields still display.

### 4.8 Display field map (the "easy to read" sheet)
Left = label shown; right = vPIC key from `DecodeVinValues`. Show a row only if the value is non-empty (N2). **S2 must verify every key against a live call for the fixture VIN (§4.11) and correct any that differ — report corrections in the session report.**

**Identity**
- Year — `ModelYear` · Make — `Make` · Model — `Model` · Trim — `Trim` · Series — `Series` · Body — `BodyClass` · Type — `VehicleType` · Doors — `Doors`

**Powertrain**
- Engine — `EngineModel` · Cylinders — `EngineCylinders` · Displacement (L) — `DisplacementL` · Fuel — `FuelTypePrimary` (+ `FuelTypeSecondary` if present) · Horsepower — `EngineHP` · Turbo — `Turbo` · Drive — `DriveType` · Transmission — `TransmissionStyle` (+ `TransmissionSpeeds`)

**Weight & class**
- GVWR — `GVWR` (if `GVWR_to` present and different, show as a range) · Axles — `Axles` · Brakes — `BrakeSystemType` · Cab — `CabType` · Bed — `BedType` (+ `BedLengthIN`)

**Manufacturing**
- Manufacturer — `Manufacturer` · Plant — `PlantCity`, `PlantState`, `PlantCountry` joined with ", " · Plant company — `PlantCompanyName`

**Notice** (only when non-empty): `ErrorText`, `AdditionalErrorText`, `Note`

Everything else vPIC returns is stored in `decode.fields` untouched and viewable under a collapsed **"All fields"** section, sorted by key.

### 4.9 Handoff payload codec (v1)
Compact JSON, then UTF-8 → **base64url** (no padding). Two carriers:
- **URL** (QR and links): `https://<host>/#/i?d=<base64url>` — the fragment never reaches a server.
- **Text prefix** (clipboard, messages): `VINRELAY1:<base64url>`

Fields (all optional except `v` and `vin`):

```json
{ "v": 1, "vin": "1HGCM82633A004352",
  "y": "2003", "mk": "HONDA", "md": "Accord", "tr": "", "bc": "Sedan/Saloon",
  "en": "…", "fu": "Gasoline", "dr": "…", "gv": "…",
  "at": "2026-09-03T14:12:00-08:00", "u": "UNIT-42", "n": "…", "by": "Zach's iPhone" }
```
- `y mk md tr bc en fu dr gv` mirror the sheet (§4.8): ModelYear, Make, Model, Trim, BodyClass, EngineModel, FuelTypePrimary, DriveType, GVWR.
- `at` = `lastScannedAt`, `u` = unit/asset tag, `n` = notes, `by` = device label (Settings).
- **Hard cap: 700 bytes of URL.** If exceeded, drop fields in this order until it fits: `n`, `en`, `dr`, `fu`, `bc`, `tr`, `gv`. Never drop `vin`, `v`, `y`, `mk`, `md`.
- Importing (§S3) validates with zod, then upserts by VIN (§5.3). The receiver runs its own vPIC decode to fill the full sheet; the payload's summary fields are used immediately so the receiver is useful offline too.

**Share text** (human-readable, sent alongside the JSON file via Web Share):
```
2003 HONDA Accord (Sedan/Saloon)
VIN 1HG CM826 3 3 A 004352
Engine … · Gasoline · … · GVWR …
Plant: …
Unit UNIT-42 · Scanned 2026-09-03 14:12 · VIN Relay
```
Rows with no data are omitted.

### 4.10 Enums (locked)
```ts
type Symbology   = "code_39" | "code_128" | "data_matrix" | "qr_code" | "manual" | "import";
type DecodeStatus = "pending" | "ok" | "partial" | "unsupported" | "failed";
type ScanState   = "idle" | "requesting" | "streaming" | "candidate" | "confirmed" | "error";
type ScanError   = "permission_denied" | "no_camera" | "insecure_context" | "stream_lost";
type Region      = "Africa" | "Asia" | "Europe" | "North America" | "Oceania" | "South America";
type SyncStatus  = "signed_out" | "synced" | "pending" | "syncing" | "offline" | "error";
type OutboxKind  = "scan_event" | "vehicle_meta" | "vehicle_delete";
```

### 4.11 Test fixtures
| VIN | Expect |
|---|---|
| `1HGCM82633A004352` | Grammar ok; **check digit valid** (weighted sum 311, 311 mod 11 = 3). Year code `3`, pos 7 = `2` (digit) → candidates 2003/2033 → 2033 > current+1 → resolved 2003. WMI `1HG`, United States. vPIC expected: `Make` HONDA, `Model` Accord, `ModelYear` 2003 — verify live in S2. |
| `11111111111111111` | Check digit valid (sum 89, 89 mod 11 = 1). Structural-only fixture. |
| `1HGCM82633A004353` | Grammar ok; **check digit invalid**: sum 313, 313 mod 11 = 5, so the expected check char is **5** and position 9 holds **3**. |
| `1HGCM826X3A004350` | Check digit **X** (sum 307, 307 mod 11 = 10). The only fixture exercising the `X` branch. |
| `1FUJGLDR49SAV1234` · `1HTMMAAL67H412345` · `4V4NC9TJ98N412345` · `1FUJA6CK14LM12345` | Heavy trucks; all check-digit valid (sums 378, 358, 361, 265 → 4, 6, 9, 1). Position 7 is a letter and the late candidate fails the §4.4 cap, so they resolve to **2009, 2007, 2008, 2004** — not 2039/2037/2038/2034. |
| `I1HGCM82633A004352` | Normalizes to `1HGCM82633A004352` via §4.2. |
| `1HGCM82633A00435` (16) / `1HGCM82633A0043521` (18, no I) | `NO_VIN` / extracts the valid 17-window. |
| `1HGCM8263IA004352` | Contains `I` → `NO_VIN` (window breaks on I). |
| Synthetic year tests | pos10 `K` + pos7 letter → 2019 resolved. pos10 `T` + pos7 digit → candidates [1996, 2026], unresolved. pos10 `Z` → invalid year code. |

### 4.12 Cloud sync & merge (S4)

**Model.** Local-first stays true (P1, N7). The account is a merge point shared by one user's devices, not an authority over the device: signed out, nothing changes; signed in, an outbox pushes local changes and a pull cursor brings down what other devices did. Server-side, `scan_events` are the source of truth and `vehicles` aggregates are derived by trigger (P8).

**Schema** — `supabase/migrations/0001_init.sql`. The skeleton below is authoritative for names, keys, and merge semantics. Claude Code completes it; it never renames anything in it.

```sql
create table public.vehicles (
  user_id          uuid not null references auth.users(id) on delete cascade,
  vin              text not null check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  unit             text,
  notes            text,
  meta_updated_at  timestamptz not null,                 -- client clock at last unit/notes edit (LWW)
  structural       jsonb not null default '{}'::jsonb,
  decode           jsonb not null default '{}'::jsonb,   -- { status, source, fetchedAt, fields }
  first_scanned_at timestamptz,
  last_scanned_at  timestamptz,
  scan_count       integer not null default 0,
  deleted_at       timestamptz,
  updated_at       timestamptz not null default now(),   -- server clock; the pull cursor
  primary key (user_id, vin)
);
create index vehicles_user_updated on public.vehicles (user_id, updated_at);

create table public.scan_events (
  id                 uuid primary key,                   -- client-generated; makes pushes idempotent
  user_id            uuid not null references auth.users(id) on delete cascade,
  vin                text not null,
  at                 timestamptz not null,
  symbology          text not null,
  check_digit_valid  boolean not null,
  device_label       text,
  origin             text not null,
  inserted_at        timestamptz not null default now()  -- server clock; the pull cursor
);
create index scan_events_user_inserted on public.scan_events (user_id, inserted_at);

alter table public.vehicles    enable row level security;
alter table public.scan_events enable row level security;
create policy own_vehicles on public.vehicles    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_events   on public.scan_events for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger vehicles_touch before update on public.vehicles
  for each row execute function public.touch_updated_at();

-- events are the truth; the vehicles row is created/aggregated from them
create or replace function public.apply_scan_event() returns trigger language plpgsql as $$
begin
  insert into public.vehicles (user_id, vin, meta_updated_at, first_scanned_at, last_scanned_at, scan_count)
  values (new.user_id, new.vin, new.at, new.at, new.at, 1)
  on conflict (user_id, vin) do update set
    first_scanned_at = least(vehicles.first_scanned_at, excluded.first_scanned_at),
    last_scanned_at  = greatest(vehicles.last_scanned_at, excluded.last_scanned_at),
    scan_count       = vehicles.scan_count + 1,
    deleted_at       = null;
  return new;
end $$;
create trigger scan_events_apply after insert on public.scan_events
  for each row execute function public.apply_scan_event();

create or replace function public.decode_rank(d jsonb) returns int language sql immutable as $$
  select case d->>'status' when 'ok' then 3 when 'partial' then 2 when 'unsupported' then 1 else 0 end $$;

create or replace function public.better_decode(a jsonb, b jsonb) returns jsonb language sql immutable as $$
  select case
    when public.decode_rank(b) > public.decode_rank(a) then b
    when public.decode_rank(b) = public.decode_rank(a)
     and coalesce((b->>'fetchedAt')::timestamptz, '-infinity') > coalesce((a->>'fetchedAt')::timestamptz, '-infinity') then b
    else a end $$;

create or replace function public.upsert_vehicle_meta(
  p_vin text, p_unit text, p_notes text, p_meta_updated_at timestamptz, p_structural jsonb, p_decode jsonb
) returns void language plpgsql security invoker as $$
begin
  insert into public.vehicles (user_id, vin, unit, notes, meta_updated_at, structural, decode)
  values (auth.uid(), p_vin, p_unit, p_notes, p_meta_updated_at, coalesce(p_structural, '{}'), coalesce(p_decode, '{}'))
  on conflict (user_id, vin) do update set
    unit            = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.unit  else vehicles.unit  end,
    notes           = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.notes else vehicles.notes end,
    meta_updated_at = greatest(vehicles.meta_updated_at, excluded.meta_updated_at),
    structural      = case when vehicles.structural = '{}'::jsonb then excluded.structural else vehicles.structural end,
    decode          = public.better_decode(vehicles.decode, excluded.decode);
end $$;

create or replace function public.delete_vehicle(p_vin text) returns void language sql security invoker as $$
  update public.vehicles set deleted_at = now() where user_id = auth.uid() and vin = p_vin $$;

create or replace function public.delete_my_data() returns void language sql security invoker as $$
  delete from public.scan_events where user_id = auth.uid();
  delete from public.vehicles    where user_id = auth.uid(); $$;
```
Edge Function `delete-account`: verifies the caller's JWT, deletes the auth user with the service-role key (rows cascade). The service-role key exists only there.

**Merge rules (identical on server and client):**
- `unit`, `notes`: last-writer-wins by `meta_updated_at` (device clock at edit time, ISO 8601 with offset). Ties keep the existing value.
- `decode`: rank `ok` 3 > `partial` 2 > `unsupported` 1 > `pending`/`failed` 0. Higher rank wins; equal rank → newer `fetchedAt`.
- `structural`: first non-empty wins (it is deterministic per VIN anyway).
- `first_scanned_at` = min, `last_scanned_at` = max, `scan_count` = number of events. Derived only; clients never push them.
- `deleted_at`: set by `delete_vehicle`; any later scan event clears it. Pulled rows with `deleted_at` are removed locally.

**Client protocol:**
- Every local write in the S0–S3 paths (scan, manual, import, unit/notes edit, delete) also appends an outbox row (§5.7). Push in insertion order, batches of 50 per kind: `scan_event` → `from("scan_events").upsert(rows, { onConflict: "id", ignoreDuplicates: true })` · `vehicle_meta` → `rpc("upsert_vehicle_meta", …)` · `vehicle_delete` → `rpc("delete_vehicle", …)`. Remove on success. On failure back off 5 s → 30 s → 2 min → 10 min cap, attempts persisted, never dropped.
- Pull after every successful push and on: sign-in, app start, `online`, tab becomes visible, a realtime notification, and every 5 min while visible. `vehicles where updated_at >= cursor`, `scan_events where inserted_at >= cursor`, pages of 500, dedupe by key, cursor = max timestamp received (§5.8).
- Apply pulled rows with the merge rules. A local vehicle that still has an unpushed `vehicle_meta` newer than the server's `meta_updated_at` keeps its local unit/notes until pushed.
- Realtime: `postgres_changes` on `vehicles` filtered `user_id=eq.<uid>`. The event is only a signal to pull; it is never applied directly (one apply path).
- Locked names: `vehicles`, `scan_events`, `upsert_vehicle_meta`, `delete_vehicle`, `delete_my_data`, `delete-account`.

**Auth:** Supabase Auth, email + 6-digit code (`signInWithOtp` with `shouldCreateUser: true`; the email template must include the token). No passwords, no OAuth in v1 (§12). Session persisted by supabase-js and refreshed when online; the app never blocks on auth.

**Security posture:** RLS `user_id = auth.uid()` on every table with `with check` on writes; only the anon key ships in the client; no PII beyond the sign-in email; nothing is shared across accounts in v1.

---

## 5. Data model (Dexie)

### 5.1 `vehicles` — keyed by `vin`
```ts
interface VehicleRecord {
  vin: string;                      // primary key
  structural: {
    wmi: string; vds: string; checkDigit: string; checkDigitValid: boolean;
    yearCode: string; modelYear: { candidates: number[]; resolved: number | null };
    plantCode: string; serial: string;
    region: Region; country: string | null;
    manufacturerFromWmi: string | null;        // from wmi cache/seed
  };
  decode: {
    status: DecodeStatus; source: "nhtsa_vpic"; fetchedAt: string | null;
    attempts: number; lastError: string | null;
    fields: Record<string, string>;            // Results[0], empties removed
  };
  unit: string | null;              // fleet unit / asset tag (user-entered)
  notes: string | null;
  firstScannedAt: string;           // ISO 8601 with offset
  lastScannedAt: string;
  scanCount: number;
  origin: "scan" | "manual" | "import" | "cloud";
  metaUpdatedAt: string;            // device clock at last unit/notes edit — the LWW clock (§4.12)
  deletedAt: string | null;
}
```
Indexes: `vin`, `lastScannedAt`, `unit`, `decode.status`, `deletedAt`.

### 5.2 `scanEvents` — append-only log, keyed by `id`
`{ id: string /* crypto.randomUUID() */, vin: string, at: string, symbology: Symbology, raw: string, checkDigitValid: boolean, deviceLabel: string | null }` — indexes: `vin`, `at`.

### 5.3 Upsert rule (P4)
On scan/manual/import/cloud-pull of VIN *x*: if absent → create with `scanCount = 1`, `firstScannedAt = lastScannedAt = now`. If present → `scanCount++`, `lastScannedAt = now`; keep existing `unit`/`notes` unless the incoming payload has non-empty values and the user confirms overwrite; keep existing `decode` if `status ∈ {ok, partial, unsupported}`, else take the incoming one if better. Always append a `scanEvents` row.

### 5.4 Decode queue
`decode.status = "pending"` rows are retried: on app start, on the `online` event, and every 60 s while the app is visible and online. Serial, one at a time, oldest first. Max `attempts` before `failed` = 10 (still retried on manual "Refresh details").

### 5.5 `wmi` cache — keyed by `wmi`
`{ wmi, manufacturer, make: string | null, source: "seed" | "vpic", updatedAt }`. Seeded from `wmi-seed.json` on first run; upserted from every successful decode.

### 5.6 `settings` — single row
`{ deviceLabel: string; sound: boolean; haptics: boolean; autoDecode: boolean /* default true */; syncEnabled: boolean /* default true once signed in */; uploadPromptDismissed: boolean }`

### 5.7 `outbox` — keyed by `id` (S4)
`{ id: string; kind: OutboxKind; vin: string; payload: object; createdAt: string; attempts: number; nextAttemptAt: string | null; lastError: string | null }` — indexes: `createdAt`, `kind`. Pending count = number of rows; it drives the sync chip.

### 5.8 `syncState` — single row (S4)
`{ id: "cursor"; vehiclesCursor: string | null; eventsCursor: string | null; lastPushAt: string | null; lastPullAt: string | null; lastError: string | null }`

---

## 6. UX spec

### 6.1 Field constraints & tokens
Reality: gloves, cold hands, snow glare, darkness, night shift, one hand free.
- Dark theme default; light theme available. Contrast ≥ 7:1 for body text.
- Targets: ≥ 48 px everything; ≥ 56 px for Scan, Use as-is, Share, Copy, Sign in.
- No long-press, no swipe-to-reveal, no pinch. Taps and visible buttons only.
- VIN display: monospace, ≥ 28 px on phone, grouped per §4.1, letter-spaced.
- Torch button on the scanner **when** the video track's capabilities report `torch`; hidden otherwise (iOS Safari does not expose it).
- Feedback on confirmed scan: short beep (Web Audio, off if `settings.sound` false) + `navigator.vibrate(60)` where available. Never rely on either — the screen change is the primary feedback.
- Portrait and landscape both work; the scan guide is a wide horizontal box (~90% width × ~22% height) because the target is a 1D barcode.

`tokens.css` (CSS variables; Tailwind consumes them): `--bg`, `--bg-elev`, `--fg`, `--fg-muted`, `--accent`, `--ok`, `--warn`, `--danger`, `--radius: 12px`, `--tap: 48px`, `--tap-lg: 56px`, `--vin-font: ui-monospace, SF Mono, Menlo, Consolas, monospace`.

### 6.2 Screens & routes (HashRouter)
| Route | Screen | Purpose |
|---|---|---|
| `/#/` → `/#/scan` | **Scan** | Default screen. Camera, guide box, torch, "Type VIN instead". |
| `/#/v/:vin` | **Sheet** | Structural block at top (always), vPIC groups below (§4.8), unit/notes fields, sync chip (S4), actions: Copy VIN · Copy summary · Copy link · Copy JSON · Copy row (S4) · Share · QR · Download JSON · Refresh details · Delete (S4). |
| `/#/history` | **History** | List sorted by `lastScannedAt`, search by VIN/unit/make/model, decode-status chips, sync chip (S4), multi-select → Copy TSV / Copy CSV (S4), Export all (JSON/CSV). Table + side pane on wide screens (§6.6). |
| `/#/i?d=…` | **Import** | Parses a payload URL (§4.9); also accepts pasted text, a pasted bare VIN, or a `.json` file (single record or export bundle). Shows what will be imported, then upserts. |
| `/#/settings` | **Settings** | Device label, sound, haptics, auto-decode, Account (S4), Clear all data (typed confirmation). |
| `/#/account` | **Account** (S4) | Signed out: email → 6-digit code. Signed in: email, sync status and pending count, "Add N local records", Sign out (keep this phone's records) / Sign out & clear this phone, Delete my cloud data, Delete account. |

Bottom nav: Scan · History · Settings. Sheet and Import are pushed screens.

### 6.3 Scanner behavior (state machine — §4.10 `ScanState`)
- `idle → requesting`: on screen mount. Insecure context → `error(insecure_context)` immediately, no permission prompt.
- `requesting → streaming`: `getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } })`. Denied → `error(permission_denied)`; none → `error(no_camera)`.
- `streaming`: ZXing continuous decode. Each result runs `extractVin` (§4.2). `NO_VIN` → stay.
- `streaming → candidate`: first VIN seen; store it with a timestamp.
- `candidate → confirmed`: a **second identical** normalized VIN within **1.5 s**. A different VIN replaces the candidate. (Two-read agreement kills most misreads on curved, scuffed labels.)
- `confirmed`: stop the stream, feedback (§6.1), upsert (§5.3), kick decode if online and `autoDecode`, navigate to Sheet. If `checkDigitValid` is false: show the mismatch banner with **Rescan** (primary) and **Use as-is** (secondary) before navigating.
- Cooldown: the same VIN confirmed again within **10 s** is ignored (prevents double-logging on return to Scan).
- `stream_lost` (track ended, tab hidden > 30 s): return to `idle` and re-request on next visibility.
- Manual entry: 17-char input, uppercase forced, live grammar + check-digit validation, same downstream path with `symbology = "manual"`.

### 6.4 Microcopy (terse, plain, never blames the user)
- Scan prompt: *"Point at the barcode on the door-jamb sticker."*
- Candidate: *"Reading… hold steady."*
- Confirmed: *"Got it ✓"*
- Check digit: *"Check digit doesn't match. Usually a misread — try again."* Buttons: **Rescan** / **Use as-is**
- Permission denied: *"Camera is blocked. Allow camera for this site in your browser settings, or type the VIN."*
- Insecure context: *"Camera needs a secure (https) connection."*
- Offline at scan: *"Offline — VIN saved. Details will fill in when you're back on signal."*
- Decode pending: *"Fetching details from NHTSA…"*
- Decode partial: *"NHTSA returned partial data: {ErrorText}"*
- Decode unsupported: *"This looks like an off-highway machine PIN. NHTSA can't decode it — showing what the number itself tells us."*
- Decode failed: *"Couldn't reach NHTSA after several tries. Tap Refresh details to retry."*
- Ambiguous year: *"1996 or 2026 — will confirm when details load"*
- Share fallback (no Web Share): *"Sharing isn't available here. Copy or download instead."*
- Import preview: *"Import 2003 HONDA Accord · 1HG CM826 3 3 A 004352?"* → **Import** / **Cancel**
- Copied: *"Copied ✓"*
- Sign in (S4): *"Enter your email. We'll send a 6-digit code."* → *"Check your email for the code."* → *"That code didn't match. Try again or resend."*
- Sync chip (S4): *"Synced"* / *"3 pending"* / *"Offline — will sync"* / *"Sync error — tap for details"*
- First sign-in with local data (S4): *"Add the 14 records on this phone to your account?"* → **Add** / **Not now**
- Sign out (S4): *"Keep the records on this phone?"* → **Keep** / **Clear this phone**
- Delete cloud data / account (S4): typed confirmation `DELETE`; *"This removes your VIN history from your account on every device. It can't be undone."*

### 6.5 Copy & paste rules (any device, one tap)
- Every copy action is a visible button (long-press is banned, N5), one tap, confirmed by a *"Copied ✓"* toast (1.5 s).
- Formats: **VIN** — 17 characters, no spaces, pasteable into any lookup form · **Summary** — the §4.9 share text · **Link** — the `VINRELAY1:` carrier (imports into another VIN Relay) · **JSON** — the `VehicleRecord` · **Row** — one tab-separated line in the S3 CSV column order · **TSV / CSV** (History, multi-select) — header + rows, pastes into Excel or Google Sheets as columns.
- `navigator.clipboard.writeText` runs **synchronously inside the tap handler**, from data already in memory. Never `await` a Dexie read before the write — iOS Safari drops the clipboard permission once the user gesture ends. If the Clipboard API is unavailable, fall back to a pre-selected read-only textarea with a prompt to copy.
- On the wide layout every row has a copy button and the VIN cell copies on click.

### 6.6 Wide screens (≥ 900 px — laptops and desktops)
History becomes a table (VIN · Year · Make · Model · Unit · Last scanned · Status · Copy) with the Sheet in a right-hand pane; History is the default route at this width (Scan still works with a webcam). Everything is keyboard-reachable: Tab / Enter / Escape, visible focus ring, no hover-only controls.

---

## 7. Definition of done (every slice)
1. `bun run typecheck`, `bun run lint`, `bun run test` all pass; zero console errors in a clean run.
2. Works **offline** for everything the slice claims (test by toggling airplane mode after the app is installed).
3. No regression in prior slices (re-run their manual checklists).
4. **Manual device matrix** executed and recorded in the session report: iPhone Safari (browser tab **and** installed to home screen), Android Chrome, desktop Chrome. Camera slices use **real door-jamb labels**, not screen images, including one worn or glared label.
5. Constants from §4 are covered by tests; no constant is defined in more than one place in the code.
6. Session report delivered (§0 rule 5); `CLAUDE.md` version record updated.
7. **Hardened** — when Zach has run `harden S<n>`: §13.6 exit criteria met and the §13.8 report delivered. Automated hardening never substitutes for item 4; *built*, *hardened*, and *done* are three different states (§13.7).

---

## 8. Ask before assuming (open questions that gate slices)
1. **Product name / host domain** (gates S0 manifest and payload URLs). Default until answered: "VIN Relay", host placeholder in `.env`.
2. **Unit / asset tag field** — is it required at scan time, optional, or absent? Default: optional, editable on the Sheet.
3. **Off-highway equipment in scope?** (loaders, dozers — PINs vPIC can't decode). Default: handled per §4.7 `unsupported`; no extra work.
4. **Order of S3 and S4** — accounts (S4) are wanted. Default: S3 (no-account handoff) still ships first, then S4 on explicit `start S4`. Say so if S4 should come before S3.
5. **Hosting choice** and whether there is an existing Supabase project to reuse for S4.
6. **Label photo** — attach a photo of the sticker to the record? Default: not in v1 (§12).
7. **Shared fleet history** — should a crew see one shared history, or is it strictly per account? v1 is per account; teams need orgs, roles and membership-based RLS and are a v2 decision (§12).
8. **Sign-in method** — email + 6-digit code is the default (works in an installed PWA without redirect trouble). Password or Google/Apple sign-in only if asked.
9. **Retention** — cloud history is kept until the user deletes it. Any purge or export-and-delete requirement?

---

## 9. Slices (thick, vertical — each leaves a working, installable app)

### S0 — Foundations + manual VIN + structural decode
**Leaves:** an installable PWA where you can type a VIN and get the structural sheet, saved locally, offline.
- Repo per Appendix A. Bun + Vite + React + TS strict + Tailwind + `tokens.css` + ESLint/Prettier + Vitest.
- `vite-plugin-pwa`: manifest (`display: standalone`, `orientation: any`, dark theme colors, icons 192/512 + maskable), `registerType: "prompt"` with an in-app "Update available — Reload" toast (never auto-reload; a reload mid-scan is unacceptable in the field). Precache the app shell only; vPIC requests are **network-only** in the SW (caching lives in Dexie, not the SW).
- `src/lib/vin/`: `grammar.ts`, `extractVin.ts`, `checkDigit.ts`, `modelYear.ts`, `wmi.ts`, `types.ts` — pure, fully tested against §4.11.
- `scripts/build-wmi-seed.ts` + committed `wmi-seed.json` (§4.5).
- Dexie schema §5 (all tables), upsert §5.3, settings row.
- Screens: Scan (manual-entry mode only — camera comes in S1), Sheet (structural block + empty vPIC area with "Details in a later step" placeholder), History (list + search), Settings (device label, sound, haptics, clear all). Bottom nav.
- HTTPS dev setup documented in `README.md` (basic-ssl and tunnel options).
- **DoD extras:** installs to home screen on iOS and Android; opens offline; typed fixture VINs produce the §4.11 structural results.

### S1 — Camera scanning
**Leaves:** point the phone at a door-jamb label and get the VIN.
- ZXing `BrowserMultiFormatReader` with §4.6 hints; full state machine §6.3; guide box; torch; tap-to-refocus only if the platform supports `focusMode` constraints (otherwise nothing).
- Two-read confirmation, cooldown, check-digit banner, feedback (§6.1).
- Scan events logged (§5.2) with `symbology` from ZXing's `BarcodeFormat`.
- Performance target: confirmed read within ~2 s on a clean label in daylight on a mid-range Android phone. If real-label decode rate is poor, crop the video frame to the guide box on a canvas before decoding (optimization is allowed inside this slice; report it).
- **DoD extras:** device matrix with real labels including the `I`-prefixed style; installed-PWA camera on iOS verified separately from the Safari tab.

### S2 — vPIC decode + readable sheet
**Leaves:** the sheet fills in with year/make/model/engine/GVWR/plant, cached forever, queued offline.
- `src/lib/vpic/client.ts` per §4.7 (timeouts, retries, status mapping, unsupported detection). `fields.ts` = the §4.8 map as data, not scattered JSX.
- Decode queue §5.4; "Refresh details" on the Sheet; status chips in History.
- Sheet renders groups from the map; empties omitted; "All fields" collapsed section; notice area; WMI cache upsert from successful decodes.
- Ambiguous year resolves in place when `ModelYear` arrives.
- **DoD extras:** verify every §4.8 key against a live call on the fixture VIN and correct the map (report corrections); airplane-mode scan → back online → sheet fills without user action.

### S3 — Handoff: share, QR, copy, export, import
**Leaves:** any record reaches any phone or computer in one tap; the receiver imports it in one tap.
- `src/lib/payload/`: codec §4.9 (encode/decode, size cap with field dropping, zod schema, version check) — pure, tested round-trip.
- Sheet actions: **Share** (Web Share: text §4.9 + attached `vin-relay-<vin>.json` when `navigator.canShare({ files })`; text-only fallback; when Web Share is absent, show Copy/Download instead) · **QR** (full-screen, max brightness hint, the URL carrier) · **Copy link** (text-prefix carrier) · **Download JSON**.
- Import screen: `/#/i?d=` auto-parse on open; paste box (payload URL, `VINRELAY1:` text, or bare VIN); `.json` file picker (single record or export bundle); preview → confirm → upsert (§5.3) → kick decode.
- Scan screen: a scanned **QR that is a VIN Relay payload URL** imports directly (so phone-to-phone is "show QR, scan QR"). A computer with a webcam can do the same on `/#/scan`.
- History: **Export all** as JSON bundle `{ app: "vin-relay", v: 1, exportedAt, vehicles: [...] }` and CSV (columns: vin, year, make, model, trim, body, engine, fuel, drive, gvwr, plant, unit, notes, firstScannedAt, lastScannedAt, scanCount, decodeStatus).
- **DoD extras:** iPhone → AirDrop → Mac opens JSON → import on `/#/i` works; Android → Nearby Share works; phone QR → second phone scan → imported; 700-byte cap verified with a long-notes record.

### S4 — Accounts & cloud history (`start S4`; optional to the user, not to the build)
**Leaves:** sign in on any phone or computer, see the same VIN history, copy any record in one tap. Signed out, nothing changes.
- **Backend:** Supabase project; `supabase/migrations/0001_init.sql` exactly per §4.12 (tables, triggers, RPCs, RLS); Edge Function `delete-account`. Local dev and CI use `supabase start`.
- **Auth:** `src/lib/auth/` — email → 6-digit code → session; resend after 30 s; session persisted; auth state exposed as a hook. Never blocks scanning (N7).
- **Sync engine:** `src/lib/sync/` — outbox (§5.7) fed by every local write; push / pull / merge / realtime / status exactly per §4.12; `SyncStatus` drives the chip on History and Sheet. Sign-out with "keep this phone's records" leaves Dexie and clears the outbox; "clear this phone" wipes Dexie and the session.
- **First sign-in merge:** if the device already has local records, prompt to add them to the account (§6.4). Accepted → everything goes through the outbox. Declined → local stays local until "Add N local records" on the Account screen.
- **Account screen** (§6.2).
- **Copy everywhere** (§6.5): Sheet — Copy VIN · Copy summary · Copy link · Copy JSON · Copy row. History — multi-select → Copy TSV / Copy CSV; Copy all. Clipboard writes happen synchronously in the tap handler.
- **Wide layout** (§6.6): table + side pane, keyboard-reachable; History is the default route at ≥ 900 px.
- **Delete:** soft-delete a vehicle (propagates to other devices) · Delete my cloud data (RPC, typed confirmation) · Delete account (Edge Function, typed confirmation, then signs out and clears the device).
- **DoD extras:** scan on the phone over cellular → row appears on a signed-in laptop within seconds, no reload · airplane-mode scans plus a unit edit sync on reconnect, in order · two devices editing the same unit converge on the later edit · a second test user cannot read or write the first user's rows (RLS test in CI) · "Copy TSV" pasted into Google Sheets and Excel lands in the right columns · "Sign out & clear" leaves no records or session on the device · all of S0–S3 still pass signed out.

### S5 — Native wrapper for Bluetooth (optional; only if iPhone Bluetooth becomes a requirement)
- Wrap the same web app with **Capacitor** and a BLE plugin. Web Bluetooth is not available in Safari on iOS, so a browser-only build cannot do Bluetooth on iPhones; this slice exists only if that requirement becomes real. Scope to be written when triggered — not part of v1.

---

## 10. Routing table (bounded context per session)
| Slice | Read from this doc | Also read |
|---|---|---|
| S0 | §0–§8, §9/S0, §4.1–§4.5, §4.10–§4.11, §5, §6.1–§6.2, Appendix A | `CLAUDE.md`, `S0_DECISIONS.md` |
| S1 | §0–§8, §9/S1, §4.2, §4.6, §6.1, §6.3, §6.4 | `CLAUDE.md`, S0 session report |
| S2 | §0–§8, §9/S2, §4.7, §4.8, §5.4–§5.5 | `CLAUDE.md`, S1 session report |
| S3 | §0–§8, §9/S3, §4.9, §5.3, §6.2 (Import), §6.4 | `CLAUDE.md`, S2 session report |
| S4 | §0–§8, §9/S4, §4.12, §5.1, §5.3, §5.6–§5.8, §6.2 (Account · History · Sheet), §6.4–§6.6 | `CLAUDE.md`, S3 session report |
| `harden spec` | the whole document, then §13 | `CLAUDE.md`, `hardening/HARDENING_SPEC.md` if it exists |
| `harden S<n>` | §0–§8, §13, and the S<n> row above | `CLAUDE.md`, S<n> session report, `hardening/HARDENING_S<n>.md` if it exists, `.claude/agents/*` |

---

## 11. Risks & known platform limits
- **Web Bluetooth is absent in Safari on iOS/iPadOS.** Not a v1 path (S5 covers it if ever needed). Chrome on Android/desktop has it; irrelevant unless S5 happens.
- **Torch and focus constraints** are inconsistent across browsers; features degrade to hidden buttons, never errors.
- **Installed-PWA camera on iOS** has historically behaved differently from the Safari tab — test both, every camera slice.
- **1D barcodes on curved, scuffed, glared labels** are the hard part of this whole product. Two-read agreement (§6.3), a wide guide box, torch, and manual entry are the mitigations; ROI cropping is the next lever.
- **vPIC availability**: a government API that is sometimes slow or down. Everything degrades to structural + queue (N1).
- **Heavy-truck model-year ambiguity** (§4.4) is real and must stay visible until vPIC resolves it (N2).
- **Handoff URL size** vs. QR readability on a phone screen — the 700-byte cap is the guard.
- **The hardening loop can only be as good as this spec.** Agents converge on *conformance*, not on truth: a wrong constant or a missing state passes every gate. That is why `harden spec` exists and why constants are human-only.
- **Clock skew between devices** decides unit/notes conflicts (last-writer-wins, §4.12). Rare and visible — the later edit shows — acceptable for v1; the adversary tests it.
- **Sign-in codes arrive by email**, which can be slow on a weak link. The screen tolerates delay and offers resend after 30 s; nothing else in the app waits on it.
- **Shared phones.** "Sign out & clear this phone" exists for exactly this reason; it must be obvious, not buried.
- **iOS clipboard** only allows the write inside the tap gesture (§6.5). Any refactor that adds an `await` before `writeText` breaks copy on iPhone silently.

## 12. Not doing in v1
OCR of the label text · label photo attachment (local or cloud) · native BarcodeDetector fast path · shared / team fleet history and orgs · password or OAuth sign-in · room-code live desk broadcast (superseded by account sync) · license-plate lookup · paid VIN-history services · editing vPIC data · Web NFC · light-theme polish beyond "usable".

---

## 13. Hardening loop — agents test, fix, and re-test until convergence

> "Perfect" needs a definition or the loop never ends. Here it is: **no open findings against this spec within everything that can be exercised automatically, two clean rounds in a row, every gate green, and an explicit list of what only a human with a truck can verify.** The loop reaches that state or stops at its budget and reports. It never runs unbounded and it never widens scope.

### 13.1 Two modes, two triggers
| Trigger | Target | What the agents work on |
|---|---|---|
| `harden spec` | this document, before S0 | contradictions, ambiguities, untestable statements, missing states or error paths, constants that look wrong (flagged, never changed by agents) |
| `harden S<n>` | the code of slice *n*, after its initial build passes §7 items 1–3 and 5 | defects, missing tests, robustness, field-usability, spec conformance |

Both run only on their trigger and stop at the budget (§13.6). `harden S<n>` never touches another slice's scope; a regression in an earlier slice found along the way is a defect and gets fixed — a new feature is not and goes to NEEDS-ZACH.

In `harden spec` mode agents **do not edit this file**. They write proposed edits as diffs into `hardening/HARDENING_SPEC.md`; Zach approves or rejects each; the orchestrator applies only approved diffs. (This is the Fuel Relay pattern: audit rounds against the spec, fixes applied by decision, not by drift.)

### 13.2 Roles (Claude Code subagents)
Each role is a markdown file in `.claude/agents/` — `name` and `description` in frontmatter, body = its system prompt, tools restricted so auditors are read-only. Reference: https://code.claude.com/docs/en/sub-agents (agents load at session start; subagents report to the main session and do not talk to each other, so every brief must be self-contained: file paths, § numbers, ledger path, slice id).

| Agent | May write | Brief |
|---|---|---|
| **orchestrator** (the main session) | ledger, reports | Runs rounds, triages, enforces budget and exit criteria. Never edits `src/` itself. |
| **spec-auditor** | ledger | Line by line: does the code do what the slice section + §4 + N-rules say? Every finding cites a §. In `harden spec` mode, audits the document instead. |
| **test-author** | `tests/`, `*.test.ts` | Unit + property-based tests (`fast-check`) for `src/lib/*`; branch coverage; every finding gets a failing test before the fixer sees it. |
| **adversary** | `tests/` | Hostile input: malformed / unicode / oversized scans, corrupted Dexie rows, vPIC oddities (empty `Results`, non-`"0"` `ErrorCode`, 5xx, timeouts, malformed JSON), payloads with wrong `v`, the 700-byte edge, clock skew, double-taps, tab hidden mid-scan, storage quota errors; from S4: duplicate and out-of-order outbox pushes, pull during push, sign-out mid-sync, expired session, clock skew on `meta_updated_at`, and a second test user trying to read or write the first user's rows (must fail under RLS). Each repro becomes a test. |
| **field-auditor** | ledger | §6.1, §6.4, N1, N2 via Playwright + `axe-core`: target sizes, contrast, every error state has its microcopy, offline flows complete, no guessed value rendered as fact. |
| **scan-bench** (S1+) | `bench/`, bench report | Owns the synthetic corpus (§13.4); runs it; proposes hint / ROI / confirmation changes as findings with numbers attached. |
| **fixer** | `src/` | The only agent that edits source. One finding (or one tight category) per commit; runs the full gate; commit message links the finding id. |
| **reviewer** | ledger | Reviews every fixer diff: spec conformance, P3 purity, no duplicated constants, no scope creep, no constant changes. Rejection sends it back to the fixer. |

### 13.3 The round
```
harden S<n>   (round r = 1 … R_MAX)
  1. audit   spec-auditor · field-auditor · adversary · test-author · scan-bench run in parallel
             → findings appended to hardening/HARDENING_S<n>.md
  2. triage  orchestrator dedupes, sets severity, buckets each finding:
             FIX (in scope) · NEEDS-ZACH (spec / constant / scope change) · WONTFIX (with reason)
  3. fix     fixer works FIX items in order S1 → S2 → S3 → S4; reviewer approves each diff
  4. gate    full gate (§13.5) must be green before the round closes
  5. check   exit criteria (§13.6) met → final report
             not met and r < R_MAX      → next round
             otherwise                  → stop, report, wait for Zach
```
Ledger row: `| id | sev | area | spec ref | description | repro / test | bucket | status | commit |`
Severity: **S1** blocker (data loss, wrong VIN accepted, crash, N-rule violation) · **S2** major (spec deviation, missing error state, offline break) · **S3** minor (UX, perf, microcopy) · **S4** nit.

### 13.4 Scan-robustness bench (what makes "extensive testing" mean something for a scanner)
- **Corpus:** every §4.11 fixture plus 200 synthetic grammar-valid VINs with computed check digits, rendered by `bwip-js` as Code 39 (with and without the leading `I`), Code 128, Data Matrix, and QR at label-realistic sizes. Deterministic seed; committed under `bench/corpus/` or regenerated by `bun run bench:corpus` if too large to commit.
- **Degradation tiers** (`sharp` / canvas, deterministic): **clean** · **moderate** (blur σ≈1.5, rotation ±15°, 70% scale, light noise) · **severe** (cylindrical / perspective warp for curved door jambs, a glare band across the code, 50% scale, low light, JPEG artifacts).
- **Two runs:** (a) `extractVin` over ZXing decodes of every image — fast, runs every round; (b) end-to-end in Playwright with Chromium's fake camera (`--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<corpus>.y4m`, built with `ffmpeg`) so the real §6.3 state machine, two-read confirmation and cooldown are exercised.
- **Report:** decode rate per symbology × tier, mean time-to-confirm, and above all **false accepts** — a wrong VIN confirmed. Thresholds in §13.6.
- Synthetic is not real. The bench tunes hints, ROI cropping and confirmation logic; it does not close §7 item 4.

### 13.5 The gate (every round, and every fixer commit)
`bun run typecheck` · `bun run lint` · `bun run test` (unit + property) · `bun run test:e2e` (Playwright, Chromium; includes offline via `context.setOffline(true)`, the fake-camera scan flow, import, and share fallbacks) · `bun run bench` (S1+) · coverage **≥ 95%** lines and branches on `src/lib/*`, **100%** on `checkDigit.ts`, `modelYear.ts`, `extractVin.ts`, `codec.ts` · mutation score **≥ 80%** on `src/lib/*` via StrykerJS (`bun run mutate`; optional in S0/S1, required from S2). A suite that kills mutants is the only proof the tests are real. From S4: RLS tests run against a local Supabase (`supabase start`) with two test users; the gate fails if any cross-user read or write succeeds.

### 13.6 Exit criteria ("perfect", defined) and budget
Converged when **all** hold:
1. Zero open S1/S2. Open S3 is zero or unchanged for two rounds (remaining S3 listed in the report).
2. Two **consecutive** rounds produced no new S1/S2 findings.
3. Gate green; coverage and mutation thresholds met.
4. Bench (S1+): decode rate per symbology ≥ **99%** clean · ≥ **90%** moderate · ≥ **70%** severe; **false accepts = 0** across the whole corpus.
5. The NEEDS-ZACH bucket is delivered as a list. The loop never resolves those itself.

Hard stops: `R_MAX = 6` rounds per slice (Zach can raise it) · a finding reopened twice → stop and escalate · any proposal to change a §4 constant, an N-rule, or slice scope → NEEDS-ZACH immediately, no action · after round 2 the orchestrator reports estimated cost so Zach can stop early · the loop never starts itself and never continues into the next slice.

### 13.7 What the loop cannot verify (stays human — §7 item 4)
Real door-jamb labels on real trucks · iOS installed-PWA camera · torch and focus on specific phones · AirDrop and Nearby Share · QR readability on a phone screen in sunlight · gloved cold-hands usability · vPIC live behavior over time · sign-in email delivery on real North Slope links. Every final report ends with this list plus anything else the agents could not exercise.

A slice is **built** when §7 items 1–3, 5, 6 pass · **hardened** when §13.6 is met · **done** when §7 item 4 (the human device matrix) passes as well.

### 13.8 Final report (per `harden` run)
Rounds run · findings by severity (found / fixed / open) · gate numbers (coverage, mutation, bench table) · commits · NEEDS-ZACH list · §13.7 list · what the agents would do next with more rounds. Written to `hardening/HARDENING_S<n>_REPORT.md`; the ledger stays as history.

---

## Appendix A — Repo layout
```
vin-relay/
├─ CLAUDE.md                      # anchor (short) + version record
├─ VIN_RELAY_BOOTSTRAP.md         # this file
├─ README.md                      # dev setup incl. HTTPS-on-device
├─ package.json  bun.lock  vite.config.ts  tsconfig.json  index.html  .env.example
├─ public/                        # icons, manifest assets
├─ scripts/build-wmi-seed.ts
├─ .claude/agents/              # subagent definitions for §13 (orchestrator brief lives in CLAUDE.md)
├─ hardening/                   # HARDENING_SPEC.md, HARDENING_S<n>.md ledgers, *_REPORT.md
├─ bench/                       # corpus generator, degradation tiers, runner, reports (§13.4)
├─ tests/e2e/                   # Playwright specs: offline, fake-camera scan, import, share fallbacks, sync, RLS
├─ supabase/                    # migrations/0001_init.sql (§4.12), functions/delete-account/, seed with two test users
└─ src/
   ├─ main.tsx  app/router.tsx  app/Shell.tsx  app/nav.tsx
   ├─ lib/vin/        grammar.ts extractVin.ts checkDigit.ts modelYear.ts wmi.ts types.ts wmi-seed.json  (+ *.test.ts)
   ├─ lib/vpic/       client.ts fields.ts types.ts  (+ tests)
   ├─ lib/payload/    codec.ts schema.ts shareText.ts  (+ tests)
   ├─ lib/storage/    db.ts upsert.ts decodeQueue.ts settings.ts
   ├─ lib/auth/       client.ts session.ts otp.ts useAuth.ts          (S4)
   ├─ lib/sync/       outbox.ts push.ts pull.ts merge.ts realtime.ts status.ts  (+ tests)  (S4)
   ├─ features/scan/  ScanScreen.tsx useScanner.ts scanMachine.ts ManualEntry.tsx
   ├─ features/sheet/ SheetScreen.tsx StructuralBlock.tsx DecodeGroups.tsx Actions.tsx
   ├─ features/history/  features/import/  features/settings/  features/account/ (S4)
   ├─ ui/             tokens.css primitives (Button, Chip, Banner, VinDisplay, QrView)
   └─ pwa/            registerSW.ts UpdateToast.tsx
```

## Appendix B — Fixture reference (copy into tests verbatim)
```ts
export const FIX = {
  VALID:        "1HGCM82633A004352",   // check digit 3 (sum 311)
  VALID_ONES:   "11111111111111111",   // check digit 1 (sum 89)
  BAD_CHECK:    "1HGCM82633A004353",   // pos 9 is 3, expected 5 (sum 313)
  CHECK_IS_X:   "1HGCM826X3A004350",   // check digit X (sum 307)
  I_PREFIXED:   "I1HGCM82633A004352",
  TOO_SHORT:    "1HGCM82633A00435",
  TRAILING:     "1HGCM82633A0043521", // 18 chars, no I — window 1 wins on the check digit
  HAS_I:        "1HGCM8263IA004352",
  // §4.4 cap: position 7 is a letter but the late candidate is impossible
  TRUCK_2009:   "1FUJGLDR49SAV1234",
  TRUCK_2007:   "1HTMMAAL67H412345",
  TRUCK_2008:   "4V4NC9TJ98N412345",
  TRUCK_2004:   "1FUJA6CK14LM12345",
};
```
