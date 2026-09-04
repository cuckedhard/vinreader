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

_Round 1 pending._

## NEEDS-ZACH

_None yet._

## Gate history

| round | typecheck | lint | unit | e2e | coverage (lines/branches) | bench | notes |
|---|---|---|---|---|---|---|---|
| baseline | pass | pass | 548 | 16 | 100% / 98.7% | not yet built | state at the end of S3 |
