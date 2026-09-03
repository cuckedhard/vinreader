# S0 session report

Slice S0, Foundations plus manual VIN entry and the structural decode. Read this before starting S1 (§10 routes S1 here).

## State

**Built**, per §7 items 1, 2, 3, 5 and 6. Not hardened (§13 has not been run) and not done (the device matrix in §7 item 4 is yours). The three states are different (§13.7).

## Gate

| Check                   | Result                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`     | clean                                                                                                                         |
| `bun run lint`          | clean                                                                                                                         |
| `bun run test`          | 307 passing, 9 files                                                                                                          |
| `bun run test:coverage` | 100% statements, lines and functions; 97.5% branches; 100% on checkDigit.ts, modelYear.ts and extractVin.ts as §13.5 requires |
| `bun run build`         | 355 kB JS, 114 kB gzipped; service worker precaches 13 entries                                                                |
| `bun run test:e2e`      | 3 passing in Chromium                                                                                                         |

The end-to-end run is a smoke suite, not the §13.5 e2e gate; that arrives with hardening.

## What works

Type or paste a VIN and get the structural sheet, saved locally, offline. Verified in a real browser, not only in unit tests:

- The reference VIN resolves to 2003, and the four heavy trucks resolve to 2009, 2007, 2008 and 2004 rather than to years in the 2030s.
- The I-prefixed door-label form and the grouped display form both paste in and normalize.
- A check-digit mismatch shows the banner and writes **nothing** until Use as-is. Edit leaves no vehicle row and no scan event. This is asserted end to end because it is the §13.3 S1-severity case.
- A VIN that carries no check digit reads normally with a neutral note, no warning.
- Clear all data stays disabled until DELETE is typed.

## Deviations from the spec, and why

1. **`src/lib/vin/structural.ts` is a new file** not in Appendix A. Something has to assemble the §5.1 structural block from the pure functions, and putting it in any existing file would have mixed concerns. Pure, tested.
2. **`@playwright/test` installed in S0**, which §9-S0 does not list. Four agents wrote four screens; shipping them unexercised was not defensible. The dependency is dev-only and §13.5 requires it later anyway.
3. **`test:e2e` needs `CHROMIUM_PATH`** on this machine, because the image's Chromium build predates the installed Playwright. On a normal machine the variable is unnecessary.
4. **`bench` and `mutate` scripts are absent.** They belong to S1 and the hardening loop. `test:e2e` exists because it now does something real.
5. **`wmi-seed.json` ships as `{}`.** vPIC is refused by this environment's egress policy, so `bun run seed:wmi` could not run. The script is written and defensive about the response shape. Every sheet therefore omits the manufacturer row until you generate the seed locally (D09).
6. **`@eslint/js` added** after the scaffold; the flat config needs it and I had left it out.

## Decisions taken under §0 rule 4

- TypeScript strictness is `strict` plus `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride` and `verbatimModuleSyntax`. `noUncheckedIndexedAccess` was left off deliberately: it would have added friction across twelve parallel authors for little gain here.
- ESLint enforces P3 directly. DOM globals, `fetch` and the clock are banned inside `src/lib/vin`, so §4.4's current-year argument cannot quietly become a `Date.now()` call.
- An invalid model-year code (`I O Q U Z 0`) yields `{ candidates: [], resolved: null }` and the sheet omits the Year row rather than showing a guess (N2). The spec does not say.
- `transliterate` throws on a character outside the alphabet; `isCheckDigitValid` returns false rather than throwing, because the scanner will call it on garbage reads in S1.
- Timestamps are written with an explicit offset. `lastScannedAt` is re-sorted by instant after the index read, because offset strings do not sort lexicographically across time zones.
- History reads the clock through a hook that snapshots on mount and refreshes each minute. Reading it during render is impure and React's compiler rule rejects it.
- The Dexie database is named `vinrelay` and the manifest `id` is `/`, neither tracking the display name, so a rename orphans no data (D01).

## Open items

- **vPIC egress.** Allow-list `vpic.nhtsa.dot.gov` or run `bun run seed:wmi` locally and commit the result. Until then no manufacturer appears offline.
- **Hosting.** The install and offline parts of the device matrix need a trusted certificate. The self-signed dev certificate cannot register a service worker — confirmed in the browser, where that is the only console error the smoke run sees.
- **Three commits are unsigned** on GitHub (6f4c315, 31a3612, 11bba18). Re-signing needs a force-push, which the sandbox blocks.

## What only you can verify (§7 item 4, §13.7)

Installing to an iPhone home screen and opening it offline; the same on Android; desktop Chrome; and whether the field-usability choices hold up with gloves in glare. None of that is closed by anything above.

## For S1

The scanner's downstream path already exists and is tested: `extractVin` then `upsertVehicle` then navigate to the sheet. S1 supplies frames and a symbology; it should not reimplement any of it. Three decisions in `S0_DECISIONS.md` bind S1 directly: D14 routes a payload-carrier QR to import before `extractVin` runs, D03 keeps the banner in front of the write, and D17 keeps the banner off identifiers that carry no check digit.
