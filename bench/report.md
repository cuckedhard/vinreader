# §13.4 scan-robustness bench

**FAIL** — 5 §13.6 thresholds missed.

## Run

| | |
|---|---|
| Run seed | `0x5eed1a7c` |
| VINs | 8 (--quick) |
| Symbologies | code_39, code_39_i, code_128, data_matrix, qr_code |
| Tiers | clean, moderate, severe |
| Attempts | 120 |
| Decoder hints (§4.6) | CODE_39, CODE_128, DATA_MATRIX, QR_CODE; TRY_HARDER |
| ZXing per-reader warnings swallowed | 213 |

Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")`, so this run reproduces exactly, and any single row below reproduces on its own.

## Headline: false accepts (§13.6 requires 0)

**0 false accepts** in 120 attempts. Threshold 0.

## Decode rate per symbology × tier

| Symbology | clean (>= 99.0%) | moderate (>= 90.0%) | severe (>= 70.0%) |
|---|---|---|---|
| code_39 | 100.0% PASS | 87.5% FAIL | 75.0% PASS |
| code_39_i | 100.0% PASS | 75.0% FAIL | 50.0% FAIL |
| code_128 | 100.0% PASS | 100.0% PASS | 100.0% PASS |
| data_matrix | 100.0% PASS | 100.0% PASS | 25.0% FAIL |
| qr_code | 100.0% PASS | 100.0% PASS | 0.0% FAIL |

Decode rate is end to end: the fraction of frames that produced the **correct** VIN
through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.

### Detail

| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Threshold | Margin | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| code_39 | clean | 8 | 8 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39 | moderate | 8 | 7 | 1 | 0 | 0 | 87.5% | 90.0% | -2.5 pp | FAIL |
| code_39 | severe | 8 | 6 | 2 | 0 | 0 | 75.0% | 70.0% | +5.0 pp | PASS |
| code_39_i | clean | 8 | 8 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39_i | moderate | 8 | 6 | 2 | 0 | 0 | 75.0% | 90.0% | -15.0 pp | FAIL |
| code_39_i | severe | 8 | 4 | 4 | 0 | 0 | 50.0% | 70.0% | -20.0 pp | FAIL |
| code_128 | clean | 8 | 8 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128 | moderate | 8 | 8 | 0 | 0 | 0 | 100.0% | 90.0% | +10.0 pp | PASS |
| code_128 | severe | 8 | 8 | 0 | 0 | 0 | 100.0% | 70.0% | +30.0 pp | PASS |
| data_matrix | clean | 8 | 8 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| data_matrix | moderate | 8 | 8 | 0 | 0 | 0 | 100.0% | 90.0% | +10.0 pp | PASS |
| data_matrix | severe | 8 | 2 | 6 | 0 | 0 | 25.0% | 70.0% | -45.0 pp | FAIL |
| qr_code | clean | 8 | 8 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| qr_code | moderate | 8 | 8 | 0 | 0 | 0 | 100.0% | 90.0% | +10.0 pp | PASS |
| qr_code | severe | 8 | 0 | 8 | 0 | 0 | 0.0% | 70.0% | -70.0 pp | FAIL |

### Why the misses missed

| Symbology | Tier | no_decode | no_vin | carrier |
|---|---|---:|---:|---:|
| code_39 | clean | 0 | 0 | 0 |
| code_39 | moderate | 1 | 0 | 0 |
| code_39 | severe | 2 | 0 | 0 |
| code_39_i | clean | 0 | 0 | 0 |
| code_39_i | moderate | 2 | 0 | 0 |
| code_39_i | severe | 4 | 0 | 0 |
| code_128 | clean | 0 | 0 | 0 |
| code_128 | moderate | 0 | 0 | 0 |
| code_128 | severe | 0 | 0 | 0 |
| data_matrix | clean | 0 | 0 | 0 |
| data_matrix | moderate | 0 | 0 | 0 |
| data_matrix | severe | 6 | 0 | 0 |
| qr_code | clean | 0 | 0 | 0 |
| qr_code | moderate | 0 | 0 | 0 |
| qr_code | severe | 8 | 0 | 0 |

`no_decode` — ZXing found no symbol. `no_vin` — text decoded but §4.2 named no VIN. `carrier` — a §4.9 handoff payload, which §6.3 never extracts; nothing in this corpus is one, so any non-zero value here is itself a finding.

## Decode time

| Scope | Decodes | Mean ms | p95 ms |
|---|---:|---:|---:|
| all | 120 | 9.5 | 31.0 |
| clean | 40 | 4.3 | 10.5 |
| moderate | 40 | 7.7 | 60.3 |
| severe | 40 | 16.6 | 36.4 |

Times cover the ZXing pipeline only — luminance packing, binarisation and the read — because the app hands ZXing canvas pixels and never parses a PNG. Timings are the one part of this report that is not bit-reproducible; no threshold rides on them.

## §13.6 verdict

- code_39 moderate: 87.5% < 90.0% (7/8 correct, -2.5 pp)
- code_39_i moderate: 75.0% < 90.0% (6/8 correct, -15.0 pp)
- code_39_i severe: 50.0% < 70.0% (4/8 correct, -20.0 pp)
- data_matrix severe: 25.0% < 70.0% (2/8 correct, -45.0 pp)
- qr_code severe: 0.0% < 70.0% (0/8 correct, -70.0 pp)

Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.
