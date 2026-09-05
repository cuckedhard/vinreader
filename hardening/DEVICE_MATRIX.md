# Device matrix — §7 item 4

The standing record of the one gate in the definition of done that no agent can close.
§13.7 says it plainly: **built ≠ hardened ≠ done.** Hardening is automated; this document is
human testimony, and it is only ever as good as the specificity of what was reported.

Each cell needs the app opened on that surface and a **real door-jamb label** put through the
camera — not a screen, not a printout, not typed entry. Typed entry exercises `useVinCommit`
and the §4.3 gate, which is worth having, but it is not the scanner.

| surface | camera, real label | reported by | when |
|---|---|---|---|
| **Android Chrome** | ✅ **pass** | Zach | 2026-09-05 |
| iPhone Safari — tab | open | — | — |
| iPhone — installed PWA | open | — | — |
| Desktop Chrome | open | — | — |

## 2026-09-05 — Android Chrome, first real label

Served from GitHub Pages at `https://cuckedhard.github.io/vinreader/` (commit `6e902b6`), the
first deployment of this app to a real origin. A real vehicle door-jamb label was scanned through
the camera and decoded correctly. A VIN was also entered by hand on the same device.

**This is the first evidence of any kind that the camera path works against reality.** Everything
the project knew about scanning before this came from `bench/`, which synthesises its own
barcodes, and from Playwright's fake-camera Y4M feed. Both emulate the surface; neither is a lens
pointed at a curved, dirty, badly-lit sticker.

### What it does not establish

Three things, recorded here so the pass is not read as more than it is.

**It is not evidence against R4-F.** The bench measures **1 false accept in 3,000** decodes on
`code_128` / severe — a genuine Code 128 checksum collision reading `EH8U2YHX60HU8VGWD` as
`EH8U2YHX60HU7VAWD`. A handful of correct real-world scans is close to zero evidence against a
1-in-3,000 rate: you would expect to scan on the order of 3,000 labels before seeing one, and a
false accept is silent by definition — the wrong VIN is simply saved as fact. R4-F stays open, and
no amount of successful field scanning will close it. Only a §4.6 or §13.4 change can.

**The symbology is unrecorded.** `buildScanHints()` enables CODE_39, CODE_128, DATA_MATRIX and
QR_CODE. A door-jamb label is usually Code 39 or Code 128, but which one this label carried was
not captured, so exactly one of those four formats gained real-world evidence and the record
cannot say which. Worth capturing on the next run: the sheet shows the symbology on the saved
record.

**One device is not the Android surface.** Android Chrome spans an enormous range of camera
hardware, autofocus behaviour and screen density. The e2e suite emulates eight profiles from a
2012 Galaxy S III at 360 px to a Pixel 10 Pro XL at 448 px, but emulation covers layout, not
optics.

### Why this cell was the right one to bank first

It had the least prior evidence. The e2e suite runs two Android projects, which is what caught
R4-H (the handoff QR unscannable at devicePixelRatio > 1) — but it emulates the *surface*, never
the engine. ZXing against a real Android camera had never run anywhere in this project.

## What is still open, by risk

**iPhone, installed — highest risk, and it is two hazards, not one.**

1. **§6.5 clipboard.** `navigator.clipboard.writeText` must run synchronously inside the tap
   handler; iOS Safari silently drops the permission if a Dexie read is awaited first. The code is
   written for this and the constraint is documented, but written-for and verified-on-an-iPhone
   are different claims, and the failure mode is silent.
2. **Standalone vs. tab.** iOS handles camera and Web Share differently in an installed PWA than
   in a Safari tab. That is exactly why §7 lists them as two cells rather than one.

**Desktop Chrome — lowest risk, cheapest to close.** Mostly confirms nothing regressed for the
wide layout (§6.6, ≥ 900 px, where History rather than Scan is the default route).

## How to report a run

Name the surface, whether the app was installed or in a tab, what was scanned, and the symbology
off the saved record. "Works" closes nothing; "Android Chrome, tab, real door-jamb Code 128,
decoded correctly" closes a cell.
