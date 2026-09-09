import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodePayload } from "../../src/lib/payload/codec";

/**
 * [SHT-1] Two fields, one phone, one save in flight (§5.3, D11, §4.12, N2, P7).
 *
 * The sheet saves unit, paint and notes together and then mirrors what storage kept back
 * into the boxes — deliberately, so a trimmed value cannot leave the box and the record
 * disagreeing. The defect is that the mirror wrote all three fields from a response
 * computed before the other two were typed: blur Unit, type a paint code and a note while
 * that save is still in flight, and the mirror puts both boxes back to empty and then
 * chips *"Saved"* over the loss. Measured on the unfixed tree:
 * `unit= "TRK-204" paint= "" notes= ""`, chip *"Saved"*, record `{"notes":"","paint":""}`.
 *
 * A paint code has no check digit and no grammar (§4.9), so nothing downstream can notice
 * a wrong or a missing one — which is why §5.3 protects it hardest and why this spec
 * always types one.
 *
 * The race is run in **one page task**: `blur()` starts the save synchronously, and the two
 * `input` events that follow are dispatched before the task yields, so no IndexedDB request
 * can have completed. That is deterministic rather than timing-dependent.
 *
 * A run where the save was *not* in flight would pass every assertion below for the wrong
 * reason, so the flight is proved at the storage seam rather than assumed: every write to
 * the `vehicles` store is recorded, and the spec asserts that the write the blur produced
 * carried the unit **and two nulls** — the response the mirror then ran from could not have
 * known about the paint code or the note, because the request that fetched it did not.
 */

const VIN = "1HGCM82633A004352";

const UNIT = "TRK-204";
const PAINT = "NH-731P";
const NOTES = "left brake light out";

/** §6.4's two chips for this block, written out — a test that imports them cannot see the
 * screen render the wrong one. */
const NOT_SAVED = "Not saved yet";
const SAVED = "Saved";

/**
 * A §4.8 field only the vPIC answer carries: §4.9's summary has no slot for the plant, so
 * this string on the sheet is the decode's own write to this row having landed. The seed
 * waits for it, and every write recorded after that is a save this spec asked for.
 */
const PLANT = "MARYSVILLE";

const PLAIN = encodePayload({ v: 1, vin: VIN, y: "2003", mk: "HONDA", md: "Accord" });

/** What a recorded `vehicles` write is reduced to: the three fields this row is about. */
interface MetaWrite {
  unit: string | null;
  paint: string | null;
  notes: string | null;
}

/**
 * Record every write to the `vehicles` store, so the spec can say which values the save in
 * flight actually carried. The same `IDBObjectStore.prototype` seam the storage-failure
 * specs inject at, used here to watch rather than to break.
 */
async function recordWrites(page: Page) {
  await page.addInitScript(() => {
    const writes: MetaWrite[] = [];
    (window as unknown as { metaWrites: MetaWrite[] }).metaWrites = writes;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: never) {
      if (this.name === "vehicles") {
        const row = value as MetaWrite;
        writes.push({ unit: row.unit ?? null, paint: row.paint ?? null, notes: row.notes ?? null });
      }
      return put.call(this, value, key);
    };
  });
}

/** The `vehicles` writes since the last {@link forgetWrites}. */
function writes(page: Page): Promise<MetaWrite[]> {
  return page.evaluate(() => (window as unknown as { metaWrites: MetaWrite[] }).metaWrites);
}

/** Drops the seed's own write, so what is left is the save under test. */
function forgetWrites(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { metaWrites: MetaWrite[] }).metaWrites.length = 0;
  });
}

async function stubVpic(page: Page) {
  await page.route("**/api/vehicles/DecodeVinValues/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        Count: 1,
        Message: "synthetic",
        SearchCriteria: null,
        Results: [
          {
            ErrorCode: "0",
            Make: "HONDA",
            Model: "Accord",
            ModelYear: "2003",
            PlantCity: PLANT,
          },
        ],
      }),
    }),
  );
}

/**
 * Import a payload and land on its sheet — the shortest route to a stored record — then
 * wait for the vPIC decode to have landed, which is the last write on this row that the
 * spec did not ask for. Waiting for the *absence* of §6.4's pending line is not that wait:
 * the sheet renders nothing at all until the live query answers, so it passes before the
 * record has even been read, and the decode's write then lands in the middle of the race.
 */
async function seed(page: Page) {
  await page.goto(`/#/i?d=${PLAIN}`);
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));
  // `.first()`: §4.8 renders the plant in the Manufacturing group and again under "All
  // fields", and either one is the decode having landed.
  await expect(page.getByText(PLANT).first()).toBeVisible();
  await expect(page.getByLabel("Unit")).toHaveValue("");
  await expect(page.getByLabel("Paint code")).toHaveValue("");
}

/**
 * Type the unit, blur it, and type the other two fields before the save that blur started
 * can resolve. Returns the number of `vehicles` writes that had been issued at the moment
 * the paint code was typed — zero, or the save was not in flight and this spec measures
 * nothing.
 */
async function typeDuringTheFlight(page: Page): Promise<number> {
  const unit = page.getByLabel("Unit");
  await unit.fill(UNIT);
  // The blur below is a no-op on an element that is not focused, and a no-op here means
  // no save, no flight, and a spec that passes without testing anything.
  await expect(unit).toBeFocused();

  return page.evaluate(
    ({ paint, notes }) => {
      const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        // React tracks the last value it wrote; the native setter is what makes the
        // `input` event below read as a change rather than as a no-op.
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const byId = (id: string) => {
        const el = document.getElementById(id);
        if (el === null) throw new Error(`[SHT-1] no #${id} on the sheet`);
        return el as HTMLInputElement | HTMLTextAreaElement;
      };

      // One task, no `await`: an IndexedDB request cannot complete while this function is
      // on the stack, so the save is outstanding for both fields below.
      byId("sheet-unit").blur();
      const issued = (window as unknown as { metaWrites: MetaWrite[] }).metaWrites.length;
      setValue(byId("sheet-paint"), paint);
      setValue(byId("sheet-notes"), notes);
      return issued;
    },
    { paint: PAINT, notes: NOTES },
  );
}

/**
 * The mirror and the button's label are set in the same batch, so "Saving" leaving the
 * screen *is* the mirror having been applied. Asserted this way rather than by waiting for
 * an enabled Save, which is a claim about the fix and would move the failure off the
 * assertion that names the defect.
 */
async function theFlightHasLanded(page: Page) {
  await expect(page.getByRole("button", { name: /^saving$/i })).toHaveCount(0);
}

/**
 * What the save in flight carried. The unit, because that is the field that was blurred,
 * and two nulls, because the paint code and the note did not exist when the request was
 * built — which is exactly the response the mirror then had in its hands.
 */
const SENT_BY_THE_FLIGHT: MetaWrite = { unit: UNIT, paint: null, notes: null };

test.beforeEach(async ({ page }) => {
  await recordWrites(page);
  await stubVpic(page);
});

test("[SHT-1] a paint code and a note typed during a save in flight are still there after it lands", async ({
  page,
}) => {
  await seed(page);

  await forgetWrites(page);

  expect(await typeDuringTheFlight(page)).toBe(0);
  await theFlightHasLanded(page);
  // The proof that the race was run: one write, and it carried neither of the two fields
  // typed while it was outstanding.
  expect(await writes(page)).toEqual([SENT_BY_THE_FLIGHT]);

  // The field the save did carry: mirrored, as it always was.
  await expect(page.getByLabel("Unit")).toHaveValue(UNIT);
  // The two the save never read. On the unfixed tree both of these read "".
  await expect(page.getByLabel("Paint code")).toHaveValue(PAINT);
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(NOTES);
});

test("[SHT-1] the sheet does not chip Saved over text that reached neither the box nor the record", async ({
  page,
}) => {
  await seed(page);

  await forgetWrites(page);

  expect(await typeDuringTheFlight(page)).toBe(0);
  await theFlightHasLanded(page);
  expect(await writes(page)).toEqual([SENT_BY_THE_FLIGHT]);

  // P7 / N2: two fields are unsaved, so the screen says so. The unfixed tree said "Saved".
  await expect(page.getByText(NOT_SAVED)).toBeVisible();
  await expect(page.getByText(SAVED, { exact: true })).toHaveCount(0);

  // And the state the chip describes is one the user can act on, with the copy §6.4
  // already has: Save is live, and it lands all three fields.
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(SAVED, { exact: true })).toBeVisible();

  // The record, not the boxes: reloaded from Dexie after a full navigation.
  await page.reload();
  await expect(page.getByLabel("Unit")).toHaveValue(UNIT);
  await expect(page.getByLabel("Paint code")).toHaveValue(PAINT);
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(NOTES);
});

/**
 * The other half of the same line, and the reason the fix guards the mirror instead of
 * deleting it: storage trims (`upsert.ts` `meaningful`), and the box has to show what the
 * record kept or the two disagree about the paint code a body shop will read back.
 *
 * One field at a time, each save settled before the next box is touched — no race here, so
 * this test is green on the unfixed tree too. It is the guard that keeps the fix from
 * becoming "stop mirroring".
 */
test("[SHT-1] storage trims, and the boxes still show what it kept", async ({ page }) => {
  await seed(page);

  const field = (label: string) => page.getByLabel(label, { exact: true });

  for (const [label, value] of [
    ["Unit", UNIT],
    ["Paint code", PAINT],
    ["Notes", NOTES],
  ] as const) {
    await field(label).fill(`  ${value}  `);
    await page.getByRole("button", { name: /^save$/i }).click();
    await theFlightHasLanded(page);
    await expect(page.getByText(SAVED, { exact: true })).toBeVisible();
    // Trimmed by storage, and the box says so rather than keeping the spaces.
    await expect(field(label)).toHaveValue(value);
  }

  // Nothing is dirty: all three boxes hold exactly what the record holds.
  await expect(page.getByText(NOT_SAVED)).toHaveCount(0);
  await expect(field("Unit")).toHaveValue(UNIT);
  await expect(field("Paint code")).toHaveValue(PAINT);
  await expect(field("Notes")).toHaveValue(NOTES);
});

/**
 * [SHT-1-a] `saved` is a statement about storage, and the three tests above cannot see it
 * (§5.3, N2, P7).
 *
 * SHT-1's fix guards the three box mirrors on the value this request sent, and then sets
 * `saved = kept` **unconditionally**. The alternative — a per-field-*guarded* `saved`, which
 * is what was first prescribed — passes all three tests above: in every scenario they run,
 * the stale baseline and `kept` are both `""` for the fields that moved, so the two forms are
 * indistinguishable to that suite.
 *
 * They are not the same behaviour. A guarded `saved` keeps the *pre-save* baseline for the
 * field that moved, so typing that field back to its baseline makes `dirty` false while the
 * record holds the text the flight wrote: the block chips *"Saved"* over a record holding
 * different characters — SHT-1's own false success claim — and **Save** goes disabled, so
 * the user cannot even reconcile the two. Less recoverable than the defect it replaces.
 *
 * Which is why the unit is padded: storage trims (`upsert.ts` `meaningful`), so `kept` is
 * `"A"` where the baseline is `""`, and the two forms finally disagree. What the record holds
 * is the load-bearing half of the assertion and is read at the `put` seam rather than
 * inferred from the screen — the finding is not that a chip is wrong in the abstract, it is
 * that the chip contradicts storage.
 */

/** Padded, so `meaningful` trims it and `kept` is not what the box sent. */
const PADDED_UNIT = "  A  ";
/** What storage keeps of it, and what the record holds for the rest of this test. */
const TRIMMED_UNIT = "A";
/** Typed into the same box while that save is in flight — the value SHT-1's guard protects. */
const RETYPED_UNIT = "B";

/** The write the flight made: the unit as storage trimmed it, and two fields never sent. */
const WROTE_THE_TRIMMED_UNIT: MetaWrite = { unit: TRIMMED_UNIT, paint: null, notes: null };
/** The write the user's own Save then made, ending the disagreement. */
const CLEARED_THE_UNIT: MetaWrite = { unit: null, paint: null, notes: null };

/**
 * Type a padded unit, blur it, and retype *the same box* before the save that blur started
 * can resolve — the same one-page-task race as {@link typeDuringTheFlight}, aimed at the one
 * field the request did carry. Returns the number of `vehicles` writes issued at the moment
 * of the retype: zero, or the save was not in flight and this test measures nothing.
 */
async function retypeTheUnitDuringTheFlight(page: Page): Promise<number> {
  const unit = page.getByLabel("Unit");
  await unit.fill(PADDED_UNIT);
  // A blur is a no-op on an element that is not focused, and a no-op here means no save.
  await expect(unit).toBeFocused();

  return page.evaluate((retyped) => {
    const el = document.getElementById("sheet-unit");
    if (el === null) throw new Error("[SHT-1-a] no #sheet-unit on the sheet");
    const box = el as HTMLInputElement;

    // One task, no `await`: an IndexedDB request cannot complete while this function is on
    // the stack, so the save is still outstanding when the retype below lands.
    box.blur();
    const issued = (window as unknown as { metaWrites: MetaWrite[] }).metaWrites.length;
    // React tracks the last value it wrote; the native setter is what makes the `input`
    // event read as a change rather than as a no-op.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(box, retyped);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return issued;
  }, RETYPED_UNIT);
}

test("[SHT-1-a] the box returning to its pre-save baseline is not a save, because the record moved", async ({
  page,
}) => {
  await seed(page);

  await forgetWrites(page);

  expect(await retypeTheUnitDuringTheFlight(page)).toBe(0);
  await theFlightHasLanded(page);
  // The record holds "A" from here to the end of this test, whatever the box says.
  expect(await writes(page)).toEqual([WROTE_THE_TRIMMED_UNIT]);

  // SHT-1's guard on the field the save did carry: the retype survives the mirror. The
  // pre-fix mirror overwrote this box with "A".
  await expect(page.getByLabel("Unit")).toHaveValue(RETYPED_UNIT);
  await expect(page.getByText(NOT_SAVED)).toBeVisible();
  await expect(page.getByText(SAVED, { exact: true })).toHaveCount(0);

  // Back to the value the box held before the save — the baseline a guarded `saved` would
  // have kept. Nothing was written by this, and the record still holds "A", so the block
  // owes *"Not saved yet"*: a guarded `saved` chips *"Saved"* here instead.
  await page.getByLabel("Unit").fill("");
  await expect(page.getByLabel("Unit")).toHaveValue("");
  expect(await writes(page)).toEqual([WROTE_THE_TRIMMED_UNIT]);
  await expect(page.getByText(NOT_SAVED)).toBeVisible();
  await expect(page.getByText(SAVED, { exact: true })).toHaveCount(0);

  // And the disagreement is one the user can end, which is what a guarded `saved` takes
  // away: Save is live, and it clears the unit on the record.
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
  await page.getByRole("button", { name: /^save$/i }).click();
  await theFlightHasLanded(page);
  await expect(page.getByText(SAVED, { exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([WROTE_THE_TRIMMED_UNIT, CLEARED_THE_UNIT]);

  // The record, not the boxes: reloaded from Dexie after a full navigation.
  await page.reload();
  await expect(page.getByLabel("Unit")).toHaveValue("");
});
