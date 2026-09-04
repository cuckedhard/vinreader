# HARDENING_S1 — ledger

The §13 hardening loop against slice S1 (camera scanning). Rows follow §13.3.

**Severity** (§13.3): **S1** blocker — data loss, wrong VIN accepted, crash, N-rule violation · **S2** major — spec deviation, missing error state, offline break · **S3** minor — UX, perf, microcopy · **S4** nit.

**Buckets**: **FIX** in scope for this loop · **NEEDS-ZACH** touches a §4 constant, an N-rule, or slice scope, and is never applied by an agent · **WONTFIX** with a stated reason.

**Budget**: `R_MAX = 6` rounds. The loop stops at §13.6 or the budget, whichever comes first, and never continues into another slice.

## Scope

S1 is the camera scanner: `useScanner.ts`, `scanMachine.ts`, `CameraView.tsx`, `feedback.ts`, and the §6.3 state machine, §4.6 symbologies, §4.2 extraction as the scanner uses it, and the §6.1 and §6.4 field rules that govern the scan screen. A regression found in an earlier slice is a defect and gets fixed; a new feature is not, and goes to NEEDS-ZACH.

## Rounds

| id | sev | area | spec ref | description | repro / test | bucket | status | commit |
|---|---|---|---|---|---|---|---|---|
| B1 | S2 | bench | §13.4, §13.6 | The degradation tiers are **not ordered**. `moderate` applies a σ1.5 blur; `severe` applies none. Measured over 200 VINs, moderate is harder than severe on every 1D symbology: code_39 77.5% moderate vs 80.5% severe, code_39_i 79.0% vs 73.5%, code_128 81.0% vs 85.5%. §13.6's 99/90/70 ladder assumes severe ⊃ moderate, so the thresholds cannot mean what they intend. The implementation matches §13.4 exactly — the gap is in the spec's tier definitions, so no agent may change it. | `bun run bench --count 200` | NEEDS-ZACH | open | — |
| B2 | S2 | bench | §13.4 | `bench/decode.ts` is **not the app's decode path** and produces false negatives. It decodes a pristine PNG through `RGBLuminanceSource`; the app decodes a camera frame through a canvas, after YUV conversion and rescaling that smooth module edges. Verified: a §4.9 payload QR the harness scores as a miss is read correctly by the real scanner in Chromium through the fake camera. Every QR cell in the report is therefore unreliable as a statement about the app. | harness miss → browser reads it; see round-1 notes | FIX | open | — |
| B3 | S3 | bench | §13.4, §13.6 | `qr_code` severe measures 0/200. The glare band is sized as a fraction of the image **diagonal**, so it covers a far larger share of a square 2D symbol than of a wide 1D one, erasing more than ECC-M can recover. Physically arguable — a real highlight of fixed size does cover more of a smaller code — but it makes the severe threshold unreachable for 2D by construction. Compounded by B2. | `bun run bench`; sample images under the scratch dir | NEEDS-ZACH | open | — |
| B4 | — | scanner | §13.6 crit. 4 | **Zero false accepts across 3,000 attempts**, every symbology and tier. No wrong VIN was ever confirmed. All 573 misses were `no_decode`; not one was a case where the decoder read a symbol and `extractVin` mishandled it. This is the §13.6 criterion the loop exists to protect and it holds. | `bun run bench --count 200` | — | pass | — |

## NEEDS-ZACH

_None yet._

## Gate history

| round | typecheck | lint | unit | e2e | coverage (lines/branches) | bench | notes |
|---|---|---|---|---|---|---|---|
| baseline | pass | pass | 548 | 16 | 100% / 98.7% | not yet built | state at the end of S3 |
| 1 | pass | pass | 548 | 16 | 100% / 98.7% | 0 false accepts; 6 threshold cells missed | bench thresholds are not yet a trustworthy verdict — see B1 and B2 |
