# Spec addendum — read a printed VIN with the camera (S6)

Triggered 2026-09-11, after a field report: a 2019 Chevrolet Silverado 2500HD carried **no
scannable VIN barcode**. The only barcode on the vehicle was a QR on the driver's door glass,
which is a dealer or plant tag and not a VIN. The number itself was printed as text — on the
door-jamb certification label, the glovebox SPID label, and the windshield plate.

S1 reads barcodes. S5 reads a paint code with OCR. **S6 reads a printed VIN with the same OCR
engine**, with a switch on the scan screen to swap between the two.

The user's framing, verbatim, and it is a design constraint rather than a caveat:
*"if it doesn't work we can get rid of it."* §4 below is written to make that true.

---

## 0. Why this is different from S5, and better

A paint code cannot be checked by anything. It has no check digit, no grammar shared across
manufacturers, and nothing downstream that can contradict it (§4.9 `pc`). That is why S5 never
stores a read without a person confirming it.

**A VIN can be checked**, three ways, all of them already built:

1. **§4.1's alphabet excludes `I`, `O` and `Q`.** Those are three of the six OCR confusion
   classes. Excluding them from `tessedit_char_whitelist` means the engine *cannot emit them*
   and must choose `1`, `0` or `0` instead. This is accuracy S5 can never have, for free.
2. **§4.2 already reads a VIN out of arbitrary text**, and since `extractVinExplained` it says
   *why* when it refuses. OCR output is arbitrary text. The plumbing exists.
3. **§4.3's check digit** validates the whole 17 characters — where `checkDigitApplies` is true,
   i.e. position 9 is a digit or `X`. The 2019 Chevrolet in the field report qualifies.

## 1. The charset, and what it does to the confusion model

`OCR_CHAR_WHITELIST` today is `A–Z 0–9 -` (`src/lib/ocr/constants.ts:94`), because a paint code
can contain any of it — Honda `NH-731P`, VW `LC9X`. **S6's whitelist drops `I`, `O`, `Q` and the
hyphen**, leaving the §4.1 alphabet exactly.

The consequence is the useful part. `OCR_CONFUSION_SETS` (`src/lib/ocr/confusion.ts:43`) is:

| set | under S5's charset | under S6's charset |
|---|---|---|
| `B 8` | pair | **pair** |
| `0 O D Q` | four-way | **`0 D` — pair** |
| `1 I L` | three-way | **`1 L` — pair** |
| `5 S` | pair | **pair** |
| `2 Z` | pair | **pair** |
| `6 G` | pair | **pair** |

Every confusion class collapses to a **pair**. Each ambiguous character has exactly one
alternative, which is what makes §2's search bounded rather than combinatorial.

**The space stays allowed**, for the reason `constants.ts:123-127` already gives: withholding it
tells the engine a gap it can see cannot exist, which costs the word boundaries *and* the glyph
next to the gap. `keepable` in `runtime.ts` still keeps only whitelist characters.

## 2. The check-digit repair search — and the arithmetic that bounds it

**The idea.** When the read fails §4.3, flip characters within their confusion pair and keep the
candidates whose check digit validates.

**The trap, stated plainly.** This is a multiple-comparisons problem. The check digit is mod 11,
so *any* wrong string matches the read check character about **1 in 11** times. A search that
tries N candidates and keeps the passing ones does not get 11× protection — it gets 11/N.

Let `k` be the number of the 17 characters that sit in a confusion pair.

- **Searching every subset** is `2^k` candidates. At `k = 8` that is 256 candidates and about
  **23 expected spurious passes**. This design does not do that, and no future version should.
- **Searching Hamming distance 1** is `k` candidates. That is the bound S6 adopts.

Even at distance 1 the arithmetic forbids auto-accepting, and this is the number that decides
the interaction:

- If the true error **is** one of those flips, survivors are 1 true + `Binomial(k−1, 1/11)`.
  A unique survivor happens `(10/11)^(k−1)` of the time — about **51%** at `k = 8` — and when it
  is unique it is the right one.
- If the true error is **not** a confusion flip — a dropped character, a `4`/`A` misread, a
  smudge — every survivor is wrong, and a *unique* one still appears
  `k × (1/11) × (10/11)^(k−1)` of the time: about **37%** at `k = 8`.

**So roughly a third of the time, a failed read produces exactly one confident-looking,
checksum-valid, wrong VIN.** That is the same hazard as ledger rows `R4-F` and `SB-1`, where a
degraded Code 128 read decoded to a *different* mod-103-valid VIN.

**Therefore: the repair proposes, and never asserts.** It is a way of putting the likely-right
string in front of a person, not a way of deciding. Which is also §0 rule 6 and N2.

**Where it lives.** `src/lib/vin/` takes no DOM and no I/O (rule 8), and the confusion sets are in
`src/lib/ocr/`. The repair is a pure function over `(text, confusionSets)` returning candidates —
so it belongs in `src/lib/vin/`, taking the sets as an argument rather than importing upward, and
`src/lib/ocr/` keeps owning what the sets *are* (§7 item 5: one definition).

Repair runs **after** §4.2 finds a 17-character run and **before** anything is offered. It never
edits §4.2's rules, and `checkDigitApplies` gates it: where position 9 is a letter other than `X`
there is no check digit, so there is nothing to repair against and the raw read is offered as-is.

## 3. The interaction — the value lives inside the button

S5's pattern, unchanged, because it was right: the characters live **inside the primary control**
— `Save 1GC4YPEY0KF123456`, at VIN size on a ≥56 px button — so the tap target and the reading
target are the same pixels. A pre-filled field with a Save button beside it is auto-accept with
extra steps.

Three outcomes:

| the read | what the screen offers |
|---|---|
| check digit passes | the VIN, in the Save button. Confident, still confirmed. |
| fails, exactly one repair survives | that VIN, **with the changed character marked** — S5's `markedPositions` / *"Check the marked characters."* already do this |
| fails, several survive | all of them, as S5's `offeredCandidates` already offers alternates |
| fails, none survive | the raw read at §6.1's VIN size plus §4.2's own refusal sentence, which `RefusedRead.tsx` already renders |

**Nothing is written without a tap.** A VIN is the primary key of every record (rule 9); an
auto-accepted OCR VIN would silently create or merge a vehicle.

## 4. Removability — what "get rid of it" costs

Deliberate constraints, so removal is deletion rather than surgery:

- **No schema change.** No new `VehicleRecord` field, no migration, no §4.12 column.
- **No §4 constant altered.** The whitelist is an S6 constant beside the S5 one, not an edit to it.
- **No new `ScanState`.** §4.10 is a §4 enum and S6 adds nothing to it, exactly as FR-3/FR-4/FR-6
  added no state to the same machine.
- **The reader returns a VIN string** and hands it to the existing `useVinCommit`, so everything
  downstream — check-digit gate, §5.3 upsert, §5.4 decode, §6.3 cooldown — is untouched code.

Removal is then: delete `src/features/vinread/`, delete the S6 constants, remove one mode from the
scan screen, delete the specs. The shared OCR core in `src/lib/ocr/` stays, because S5 needs it.

**The cost this design accepts:** `session.ts`, `cropBox.ts` and `vote.ts` are paint-shaped today
(12, 7 and 6 paint references). S6 needs them generalised over a *target*. That generalisation
outlives S6's removal — the paint path would keep a two-target abstraction with one target. That
is the honest price, and it is small.

## 5. The camera handoff — the sharpest risk in the slice

S5's reader refuses to start while the barcode scanner holds the camera (`scannerLive.ts`,
`failureText.ts`'s `SCANNER_LIVE`). **S6's reader is on the scan screen, where the scanner is live
by definition.** Switching modes must stop the ZXing decode loop and release the track before the
OCR worker asks for frames, and §6.3's machine needs a defined state while that happens.

This is the most likely source of a black preview on a real phone — more likely than a wrong read.
It is called out here so it is designed rather than discovered.

## 6. What I expect it to be bad at

Stated in advance so the field test means something:

- **Door-jamb certification label** — flat, printed, high contrast. Expected to work.
- **Glovebox SPID label** — flat, but dense and small. Expected to work, needs a tight crop.
- **Windshield plate through angled glass** — reflections, a shallow angle, small glyphs.
  **Expected to fail.** `preprocess.ts`'s binarisation is built for a flat label under diffuse
  light. If it works it is a bonus; the design does not depend on it.

---

## D. Decisions for Zach

1. **Auto-accept on a unique check-digit-valid repair — no.** Taken as the smallest reasonable
   decision under §0 rule 4, on §2's arithmetic: about a third of failed reads yield exactly one
   wrong-but-valid candidate. Reversible if the field says otherwise, and this is the line to
   revisit first if the reader feels slow.
2. **Where the switch lives** — a third mode on the scan screen beside **Type VIN instead**,
   rather than a route, because S6 has no vehicle yet: it *creates* the record, so it cannot hang
   off `/#/v/:vin` the way S5 does.
3. **§6.4 copy.** §6.4 has been the copy of record since `a77d958`. S5's reader already supplies
   the camera faults, the reader faults, the download offer and the proposal wording; S6 reuses
   them with the remedy clause naming the VIN keyboard route. Genuinely new sentences will be
   listed and brought to Zach rather than invented.

## §13.7 — what no agent can settle

Whether a real door-jamb label, in real light, at arm's length, reads correctly. There is no
corpus of photographed VIN plates in this project, so any accuracy figure S6 reports is measured
against synthetic renderings and is a ceiling, exactly as §13.4's bench is for barcodes.
