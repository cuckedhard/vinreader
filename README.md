# VIN Relay

A mobile-first, installable PWA for reading a vehicle's VIN in the field: it validates the VIN
and decodes it structurally on the device — offline, with no network round trip — and hands the
record to another phone or computer. Local storage (IndexedDB via Dexie) is the source of truth;
the network is only ever an enhancement.

This slice, **S0**, ships manual VIN entry plus the structural decode (grammar, check digit,
model year, WMI region and manufacturer), the local database, and the Scan / Sheet / History /
Settings screens. **Camera scanning arrives in S1.** **NHTSA vPIC details — make, model, engine,
GVWR, plant — arrive in S2**, so the Sheet's details area is a placeholder until then.

## Requirements

- **Bun** (runtime, package manager and script runner). A separate Node install is not required;
  Bun runs Vite, Vitest and the scripts.
- A **browser**. Chrome or Safari; a phone for anything camera-, install- or share-related.
- Optional, for the tunnel route below: **cloudflared**.

## Commands

| Command                 | What it does                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install`           | Installs dependencies from `bun.lock`.                                                                                                                                                  |
| `bun run dev`           | Vite dev server on `https://localhost:5173` and on the LAN (`--host` plus `@vitejs/plugin-basic-ssl`). Hot reload; **no service worker and no manifest** — those exist only in a build. |
| `bun run typecheck`     | `tsc --noEmit` under `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`.                                                                    |
| `bun run lint`          | ESLint over the repo, including the purity rules that keep `src/lib/vin` and `src/lib/payload` free of DOM, React, I/O and the clock.                                                   |
| `bun run test`          | The test gate: Vitest, one run, no watch.                                                                                                                                               |
| `bun run test:coverage` | The same run with v8 coverage against the thresholds in `vitest.config.ts` (95% lines and branches over `src/lib`, 100% on `checkDigit.ts`, `modelYear.ts` and `extractVin.ts`).        |
| `bun run build`         | Typecheck, then `vite build` into `dist/` — app shell, manifest and the Workbox service worker.                                                                                         |
| `bun run preview`       | Serves the built `dist/` on `https://localhost:4173`, also over HTTPS and `--host`. This is what you tunnel.                                                                            |
| `bun run seed:wmi`      | Regenerates `src/lib/vin/wmi-seed.json` by calling vPIC `DecodeWMI` once per candidate WMI.                                                                                             |
| `bun run format`        | Prettier over the repo (100 columns, double quotes, semicolons, trailing commas).                                                                                                       |

### `bun test` is not the test command

Run `bun run test`. Running `bun test` invokes **Bun's own test runner**, which rewrites `vitest`
imports to `bun:test`, ignores `vitest.config.ts` entirely (so the setup file and every coverage
threshold are skipped) and reports no branch coverage — a suite that passes there can fail the
real gate. The repository blocks it on purpose: `bunfig.toml` preloads `scripts/no-bun-test.ts`,
which throws with that explanation.

### `bun run seed:wmi` and the committed seed

`src/lib/vin/wmi-seed.json` is the committed artifact and is never hand-edited. It ships as `{}`
here, because the environment this slice was built in refuses outbound connections to
`vpic.nhtsa.dot.gov:443` and the script could not run. Regenerate it from a machine that can reach
vPIC and commit the result; until then manufacturer names are simply absent — never guessed — and
the sheet omits the row.

## HTTPS on device

The camera (S1), the share sheet (S3) and service-worker registration all require a **secure
context**. `http://localhost` counts as one — but only on the machine that is serving. As soon as
the app is opened on a phone the origin is a LAN address or a public hostname, and it must be
HTTPS. There are two supported routes and they are not interchangeable.

### Route 1 — LAN over basic-ssl (quick checks)

`bun run dev` already loads `@vitejs/plugin-basic-ssl` and passes `--host`, so nothing extra is
needed:

```
bun run dev
```

It prints both URLs:

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.1.23:5173/   ← open this one on the phone
```

Put the phone on the same Wi-Fi, open the Network URL, and accept the certificate warning (iOS:
_Show Details → visit this website_). The certificate is **self-signed**, and that is the limit of
this route: iOS refuses to register a service worker or offer _Add to Home Screen_ on an origin
with an untrusted certificate, so you get hot reload and camera checks and nothing else. If a
browser still refuses the camera after you accept the warning, switch to route 2.

### Route 2 — cloudflared tunnel (install and offline)

A quick tunnel puts a **Cloudflare-issued, publicly trusted certificate** in front of your local
server, which is what iOS wants before it will install the app or run a service worker. It needs
no Cloudflare account and the URL is new on every run.

```
brew install cloudflared          # macOS; other platforms: Cloudflare's cloudflared downloads
bun run build                     # the service worker and manifest exist only in a build
bun run preview                   # https://localhost:4173
cloudflared tunnel --url https://localhost:4173 --no-tls-verify
```

`--no-tls-verify` is required because the local origin cloudflared connects to is the basic-ssl
self-signed one. The public URL it prints, `https://<random-words>.trycloudflare.com`, is still
fully trusted; open that one on the phone.
(No Vite `allowedHosts` entry is needed: Vite skips its host check when the server is HTTPS, which
basic-ssl makes it.)

For hot reload on a trusted origin, tunnel the dev server instead
(`cloudflared tunnel --url https://localhost:5173 --no-tls-verify`) — but remember dev serves no
service worker, so install and offline still need the build.

### Which route for which task

| Task                                                 | Route                                         |
| ---------------------------------------------------- | --------------------------------------------- |
| UI work, layout, glove-sized targets on a real phone | 1                                             |
| Camera and torch checks (S1)                         | 1, falling back to 2 if the camera is refused |
| Add to Home Screen on iOS or Android                 | 2                                             |
| Service worker, update toast, offline behaviour      | 2                                             |
| Web Share, AirDrop, Nearby Share (S3)                | 2                                             |

## Installing to a home screen, and verifying offline

Serve a build over route 2, then:

- **iOS Safari:** Share → _Add to Home Screen_. Launch from the icon, not the tab.
- **Android Chrome:** menu → _Install app_ / _Add to Home screen_.

Open the installed app **once while online** so the service worker precaches the shell. Only then
turn on **airplane mode** and launch it again from the icon: type a fixture VIN, confirm the Sheet
and History still work, and confirm nothing hangs waiting on the network. Offline has to be
verified _after_ installing and _in the installed app_ — a browser tab with a warm HTTP cache
proves nothing, and on iOS the installed app has its own storage, so records typed in the Safari
tab do not appear in it.

Updates never apply themselves. The service worker is registered with `registerType: "prompt"`, so
a new build surfaces an in-app _Update available — Reload_ toast; a reload in the middle of a scan
is not acceptable in the field.

## Project layout

| Path                     | Contents                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`               | Router (`HashRouter`), app shell, bottom nav.                                                                                                                                                         |
| `src/features/scan/`     | Scan screen. Manual entry in S0; the camera and its state machine land in S1.                                                                                                                         |
| `src/features/sheet/`    | The per-VIN sheet: structural block, unit and notes, actions.                                                                                                                                         |
| `src/features/history/`  | History list and search.                                                                                                                                                                              |
| `src/features/settings/` | Device label, sound, haptics, auto-decode, clear all data.                                                                                                                                            |
| `src/lib/vin/`           | The pure core: `grammar`, `checkDigit`, `modelYear`, `extractVin`, `wmi`, `structural`, shared `types`, `wmi-seed.json`, and the tests that pin the §4 constants. No DOM, no React, no I/O, no clock. |
| `src/lib/storage/`       | Dexie database, the VIN-keyed upsert, the settings row.                                                                                                                                               |
| `src/pwa/`               | Service-worker registration and the update toast.                                                                                                                                                     |
| `src/ui/`                | `tokens.css` and the shared primitives (Button, Chip, Banner, VinDisplay).                                                                                                                            |
| `scripts/`               | `build-wmi-seed.ts` and the `bun test` guard.                                                                                                                                                         |
| `public/`                | Icons and manifest assets.                                                                                                                                                                            |
| `tests/e2e/`             | Playwright specs (offline, scan, import, sync) — filled in from S1 on.                                                                                                                                |
| `bench/`                 | Scan-robustness corpus and runner — arrives with the camera in S1.                                                                                                                                    |
| `hardening/`             | The hardening ledgers and reports.                                                                                                                                                                    |

## Where the rules live

- **`CLAUDE.md`** — the anchor. Read it first: the rules that never bend, the locked stack, the
  triggers, the definition of done, and the version record.
- **`VIN_RELAY_BOOTSTRAP.md`** — the full specification. **Section 4 is authoritative**: check-digit
  weights and transliteration, the model-year table, symbologies, the vPIC field map, the payload
  codec and the enums are copied, never re-derived and never quietly corrected. Section 9 defines
  the slices, section 10 says what each slice's session is allowed to read.
- **`S0_DECISIONS.md`** — the decisions taken before this slice was built (D01–D19), including the
  ones that changed behaviour: persistence gated on the check-digit banner, the current-year cap on
  both model-year branches, and check-digit rules for VINs that carry no check digit.

## What is not built yet

- **S1 — Camera scanning.** ZXing, guide box, torch, two-read confirmation, cooldown, scan events.
- **S2 — vPIC decode.** The readable sheet (year, make, model, engine, GVWR, plant), the decode
  queue, cached forever per VIN, filled in whenever the network returns.
- **S3 — Handoff.** Share sheet, QR, copy link/JSON/summary, JSON and CSV export, and the import
  screen that receives all of it.
- **S4 — Accounts and cloud history.** Optional email sign-in, Supabase with RLS, an outbox-based
  sync, and the wide-screen desk layout. Everything keeps working signed out.
- **S5 — Native wrapper.** Only if iPhone Bluetooth ever becomes a requirement.
