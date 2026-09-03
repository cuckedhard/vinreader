# S3 session report

Slice S3, handoff: share, QR, copy, export and import. Read this before starting S4 (§10 routes S4 here).

## State

**Built**, per §7 items 1, 2, 3, 5 and 6. Not hardened, not done — the device matrix for this slice is AirDrop, Nearby Share and a QR read off a real phone screen in sunlight, none of which exists here.

## Gate

| Check                   | Result                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| `bun run typecheck`     | clean                                                                        |
| `bun run lint`          | clean                                                                        |
| `bun run test`          | 548 passing, 20 files (was 457)                                              |
| `bun run test:coverage` | 100% lines, 98.7% branches; `codec.ts` on the §13.5 100% list and meeting it |
| `bun run build`         | 986 kB, 285 kB gzipped                                                       |
| `bun run test:e2e`      | 16 passing in Chromium                                                       |

## The handoff actually round-trips

Not asserted only in unit tests. The end-to-end suite builds a payload with the real §4.9 codec, opens it as a URL, and checks the preview appears with nothing written; then imports and confirms the record carries the sender's unit and notes, not just the VIN. Export produces a real download whose JSON bundle has the §9-S3 shape and whose CSV header matches `CSV_COLUMNS` exactly. The QR renders to a canvas of real size.

**Phone-to-phone works.** `bench/make-qr-camera.mjs` renders a QR of a payload URL to a y4m, Chromium's fake camera plays it, and the app routes it to the import preview — writing nothing. That is the §9-S3 "show QR, scan QR" claim, and it is also the D14 hazard closed in both directions: the carrier is recognised before `extractVin` ever sees it, so no VIN is fabricated out of the base64url body, and the payload now reaches the screen that can use it.

## Wired during integration

The scan-side agent stopped rather than half-wire the carrier route, and said so precisely: `useScanner` dropped a carrier inside a private callback with no way for the screen to see it, and faking a callback that never fired would have compiled while doing nothing. That was the right call. I added the callback: the hook takes an optional `onCarrier`, held in a ref updated in an effect (assigning a ref during render is what React 19's purity rule rejects, and taking the callback as an effect dependency would restart the camera on every render), and `ScanScreen` re-encodes either carrier into the single `d` the import route reads.

Also cleaned up: `shareText` accepted a `deviceLabel` it deliberately ignored, because §4.9's block ends at "VIN Relay" and the label rides in the payload's `by` field. The reasoning was right and the signature was mine, so the parameter is gone rather than documented — one that is accepted and ignored reads as a bug to the next author.

## Decisions taken under §0 rule 4

- The codec omits empty fields entirely rather than emitting the empty `"tr"` the §4.9 example shows. An empty string spends bytes against a 700-byte cap and renders nothing at the far end. Decoding still accepts one, so the example round-trips verbatim.
- When the model year is still ambiguous, `y` is omitted rather than filled with a candidate (N2).
- Over the cap after every droppable field is gone, the URL is returned as it stands and the caller is told what was dropped. §4.9 leaves this open, and a truncated VIN would be worse than a long URL.
- The URL is measured in **bytes**, not characters, which is what §4.9 caps and what a multi-byte note makes differ.
- CSV quoting is RFC 4180 with CRLF, and any value starting with `=`, `+`, `-` or `@` is prefixed with an apostrophe. A notes field is free text, and a spreadsheet treats a leading `=` as a formula.
- The share text prints the scan time in the record's own offset by reading the ISO string literally, never by constructing a `Date`. Re-zoning a late-evening scan would move it to a different day — and the pure-core lint bans the clock there anyway.

## Open items

- **The bundle is 986 kB, 285 kB gzipped**, up from 355 kB at S0. ZXing and now `qrcode` dominate. It is precached, so it is an install-time cost, but this is the third slice in a row where it grew and it is worth a code-split before S4 adds Supabase.
- vPIC egress and hosting are unchanged.
- Three commits remain unsigned on GitHub, needing a force-push the sandbox blocks.

## What only you can verify (§7 item 4, §13.7)

iPhone to Mac over AirDrop, and the Mac opening the JSON. Android Nearby Share. A QR held up on one phone and read by another in daylight — the 700-byte cap exists precisely so that stays scannable, and only a real screen in real sun settles it. Whether "Copy link" pasted into a text message survives the recipient's client. And whether the clipboard actually writes on a real iPhone: the synchronous-write rule is honoured in the code, but §11 calls this out as failing silently, so it needs a real device.

## For S4

Every local write already funnels through `upsertVehicle` and `setVehicleMeta`, which is where the §5.7 outbox rows will attach. `metaUpdatedAt` already starts at the epoch sentinel and moves only on a real unit or notes edit (D11), so the last-writer-wins clock is ready for sync. §5.3's "cloud-pull" wording is an erratum — pull needs its own apply path (D12), or it will inflate `scanCount` on every pull and fabricate scan events.
