# §13.4 scan-robustness bench

**FAIL** — 9 §13.6 thresholds missed.

## Run

| | |
|---|---|
| Run seed | `0x5eed1a7c` |
| VINs | 200 (full) |
| Symbologies | code_39, code_39_i, code_128, data_matrix, qr_code |
| Tiers | clean, moderate, severe |
| Attempts | 3000 |
| Decoder hints (§4.6) | CODE_39, CODE_128, DATA_MATRIX, QR_CODE; TRY_HARDER |
| ZXing per-reader warnings swallowed | 5528 |

Every degradation seed is `runSeed ^ fnv1a("vin|symbology|tier")`, so this run reproduces exactly, and any single row below reproduces on its own.

## Headline: false accepts (§13.6 requires 0)

**0 false accepts** in 3000 attempts. Threshold 0.

## Decode rate per symbology × tier

| Symbology | clean (>= 99.0%) | moderate (>= 90.0%) | severe (>= 70.0%) |
|---|---|---|---|
| code_39 | 100.0% PASS | 77.5% FAIL | 20.0% FAIL |
| code_39_i | 100.0% PASS | 79.0% FAIL | 11.5% FAIL |
| code_128 | 100.0% PASS | 81.0% FAIL | 56.5% FAIL |
| data_matrix | 100.0% PASS | 99.0% PASS | 55.5% FAIL |
| qr_code | 98.5% FAIL | 97.5% PASS | 0.0% FAIL |

Decode rate is end to end: the fraction of frames that produced the **correct** VIN
through ZXing and §4.2 `extractVin`, not the fraction that merely decoded.

### Detail

| Symbology | Tier | Attempts | Hits | Misses | Errors | False accepts | Rate | Threshold | Margin | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| code_39 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39 | moderate | 200 | 155 | 45 | 0 | 0 | 77.5% | 90.0% | -12.5 pp | FAIL |
| code_39 | severe | 200 | 40 | 160 | 0 | 0 | 20.0% | 70.0% | -50.0 pp | FAIL |
| code_39_i | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_39_i | moderate | 200 | 158 | 42 | 0 | 0 | 79.0% | 90.0% | -11.0 pp | FAIL |
| code_39_i | severe | 200 | 23 | 177 | 0 | 0 | 11.5% | 70.0% | -58.5 pp | FAIL |
| code_128 | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| code_128 | moderate | 200 | 162 | 38 | 0 | 0 | 81.0% | 90.0% | -9.0 pp | FAIL |
| code_128 | severe | 200 | 113 | 87 | 0 | 0 | 56.5% | 70.0% | -13.5 pp | FAIL |
| data_matrix | clean | 200 | 200 | 0 | 0 | 0 | 100.0% | 99.0% | +1.0 pp | PASS |
| data_matrix | moderate | 200 | 198 | 2 | 0 | 0 | 99.0% | 90.0% | +9.0 pp | PASS |
| data_matrix | severe | 200 | 111 | 89 | 0 | 0 | 55.5% | 70.0% | -14.5 pp | FAIL |
| qr_code | clean | 200 | 197 | 3 | 0 | 0 | 98.5% | 99.0% | -0.5 pp | FAIL |
| qr_code | moderate | 200 | 195 | 5 | 0 | 0 | 97.5% | 90.0% | +7.5 pp | PASS |
| qr_code | severe | 200 | 0 | 200 | 0 | 0 | 0.0% | 70.0% | -70.0 pp | FAIL |

### Why the misses missed

| Symbology | Tier | no_decode | no_vin | carrier |
|---|---|---:|---:|---:|
| code_39 | clean | 0 | 0 | 0 |
| code_39 | moderate | 45 | 0 | 0 |
| code_39 | severe | 145 | 15 | 0 |
| code_39_i | clean | 0 | 0 | 0 |
| code_39_i | moderate | 42 | 0 | 0 |
| code_39_i | severe | 165 | 12 | 0 |
| code_128 | clean | 0 | 0 | 0 |
| code_128 | moderate | 38 | 0 | 0 |
| code_128 | severe | 87 | 0 | 0 |
| data_matrix | clean | 0 | 0 | 0 |
| data_matrix | moderate | 2 | 0 | 0 |
| data_matrix | severe | 89 | 0 | 0 |
| qr_code | clean | 3 | 0 | 0 |
| qr_code | moderate | 5 | 0 | 0 |
| qr_code | severe | 200 | 0 | 0 |

`no_decode` — ZXing found no symbol. `no_vin` — text decoded but §4.2 named no VIN. `carrier` — a §4.9 handoff payload, which §6.3 never extracts; nothing in this corpus is one, so any non-zero value here is itself a finding.

## Decode time

| Scope | Decodes | Mean ms | p95 ms |
|---|---:|---:|---:|
| all | 3000 | 11.1 | 39.6 |
| clean | 1000 | 3.2 | 5.0 |
| moderate | 1000 | 10.7 | 67.3 |
| severe | 1000 | 19.4 | 35.1 |

Times cover the ZXing pipeline only — luminance packing, binarisation and the read — because the app hands ZXing canvas pixels and never parses a PNG. Timings are the one part of this report that is not bit-reproducible; no threshold rides on them.

## §13.6 verdict

- code_39 moderate: 77.5% < 90.0% (155/200 correct, -12.5 pp)
- code_39 severe: 20.0% < 70.0% (40/200 correct, -50.0 pp)
- code_39_i moderate: 79.0% < 90.0% (158/200 correct, -11.0 pp)
- code_39_i severe: 11.5% < 70.0% (23/200 correct, -58.5 pp)
- code_128 moderate: 81.0% < 90.0% (162/200 correct, -9.0 pp)
- code_128 severe: 56.5% < 70.0% (113/200 correct, -13.5 pp)
- data_matrix severe: 55.5% < 70.0% (111/200 correct, -14.5 pp)
- qr_code clean: 98.5% < 99.0% (197/200 correct, -0.5 pp)
- qr_code severe: 0.0% < 70.0% (0/200 correct, -70.0 pp)

Synthetic is not real (§13.4, §13.7). This bench tunes hints, ROI cropping and confirmation logic; real door-jamb labels on real trucks stay §7 item 4, and stay human.
