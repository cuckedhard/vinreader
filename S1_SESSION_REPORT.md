# S1 session report

Slice S1, camera scanning. Read this before starting S2 (§10 routes S2 here).

## State

**Built**, per §7 items 1, 2, 3, 5 and 6. Not hardened, and not done: §9-S1's device matrix wants real door-jamb labels including a worn or glared one, and an iPhone check in the Safari tab and again installed. Nothing below substitutes for that.

## Gate

| Check                   | Result                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `bun run typecheck`     | clean                                                                                |
| `bun run lint`          | clean                                                                                |
| `bun run test`          | 370 passing, 11 files (was 307)                                                      |
| `bun run test:coverage` | 100% statements, lines, functions; 98.4% branches; `scanMachine.ts` at 100% branches |
| `bun run build`         | 825 kB, 234 kB gzipped                                                               |
| `bun run test:e2e`      | 5 passing in Chromium, two of them driving a real camera stream                      |

## It actually scans

The scanner is not asserted only through unit tests. `bench/make-fake-camera.py` renders a Code 39 symbol directly to YUV4MPEG2, which is what Chromium's fake camera consumes, encoding the ANSI door-label form `I` + VIN. The generator was validated on its own first, by decoding its raw luma through ZXing's pure-JS core, so a failing end-to-end run implicates the scanner rather than the fixture.

Against that stream the app reads the barcode, confirms it on the §6.3 two-read rule, writes the record, and lands on the sheet with the year resolved to 2003. A second test opens IndexedDB directly and checks the scan event stored `code_39` as its symbology and kept the raw `I`-prefixed text per §5.2.

The camera view was inspected visually: live preview, the wide guide box at roughly 90% by 22% with the surrounding area dimmed, the §6.4 prompt, and the typed fallback always on screen. The torch button correctly stays hidden when the device reports no torch capability.

## Decisions taken under §0 rule 4

- `getUserMedia` rejections outside §4.10: `NotAllowedError` and `SecurityError` map to `permission_denied`; `NotFoundError`, `OverconstrainedError`, `NotReadableError` and `AbortError` map to `no_camera`. A camera held by another app is indistinguishable from an absent one from where the user stands, and inventing an enum member would change a locked type.
- `idle` carries a `lost` flag. §4.10 lists `stream_lost` as a `ScanError` but §6.3 says a lost stream returns to idle; the flag keeps both facts without adding a state.
- Hiding the tab clears any pending candidate. A candidate that survived a pocket and confirmed on return would be a scan the user never took.
- Cooldown is recorded only on a persisted confirmation. A read rejected with Rescan was never written, so it must be immediately re-readable — otherwise Rescan looks dead for ten seconds.
- A repeat sighting after the 1.5 s window restarts the window rather than confirming.
- `requesting` and `no_camera` had no §6.4 microcopy. Both were written: silence during the 1–3 second black frame while iOS opens the camera reads as a broken app.
- ZXing reports not-found on nearly every frame; those are swallowed rather than surfaced.

## Deviations

1. **The e2e web server now builds first.** `vite preview` serves `dist/`, so the suite was silently testing the previous build. It cost a confusing failure where the scanner "did not work" and the page was S0's. Worth knowing.
2. **The smoke tests changed shape.** Scan opens on the camera now, so the typed path is reached through "Type VIN instead". The assertions are the same.
3. **ROI cropping is not implemented.** §9-S1 permits cropping the frame to the guide box if real-label decode rate is poor. Whether it is poor is not measurable here; that is what the S1 device matrix and the §13.4 bench are for. The hook decodes the full frame.

## Open items

- **Bundle grew from 355 kB to 825 kB**, 234 kB gzipped, almost entirely ZXing. It is precached, so it is a one-time install cost rather than a per-scan cost, but on a weak link the first install is now noticeably heavier. Code-splitting the scanner is the obvious lever if it matters.
- **vPIC egress and hosting** remain exactly as S0 left them.
- **Three commits are unsigned** on GitHub, needing a force-push the sandbox blocks.

## What only you can verify (§7 item 4, §13.7)

Whether it reads a real door-jamb label: curved, scuffed, sun-glared, in the dark, at arm's length, with gloves on. Whether the torch appears and helps on your phones. Whether the installed iOS PWA gets camera access at all, which has historically differed from the Safari tab. Whether two-read confirmation feels fast or fussy in the field. A clean synthetic barcode says nothing about any of it.

## For S2

The decode path is untouched and still ends at `upsertVehicle`, which writes `decode.status = "pending"`. S2 fills that in. `useVinCommit` is the single write path for both the camera and the keyboard, so anything S2 adds after a save belongs there rather than in either screen. `isPayloadCarrier` already recognises the §4.9 carriers and the scanner ignores them; S3 turns that into the import route.
