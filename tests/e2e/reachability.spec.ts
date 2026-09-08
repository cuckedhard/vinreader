import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * [RCH] Can the user reach the control, and does the app's answer land where they are looking?
 *
 * Four rows in this ledger are one defect wearing four coats — F7 (a camera error's escape
 * routes pushed out of the scroll view), F8 (the armed delete confirmation below the fold,
 * with the confirming tap landing on the bottom nav), R3-F1 (the carrier rejection banner at
 * 0 visible pixels) and SH-4 (the share failure at 0 of 107 px) — and a fifth came from a
 * real user who could not find the paint capture entry at all. Each was fixed on its own.
 * Nothing measured whether the *next* control landed somewhere a user could reach, so the
 * next one landed badly too.
 *
 * This is that measurement. It walks every route at two phone viewports, enumerates every
 * tabbable control, and measures **rendered boxes against the scroll clip** — never a class
 * string, and never Playwright's `isVisible()`, which R3-F1 recorded answering `true` at
 * zero visible pixels.
 *
 * ## What "reachable" is taken to mean here, and why
 *
 * "Above the fold" is the wrong bar: the sheet is legitimately 2,000 px long and §6.2 puts
 * Delete at the end of it on purpose. "Reachable by scrolling" is the wrong bar too — that
 * is true of the paint entry today, and a user still could not find it. So the rule is
 * split, because the five defects are two different failures:
 *
 * **1. An answer lands where the question was asked.** A notice that appears *because the
 * user did something* — tapped Share, armed Delete, pointed the camera at a payload the app
 * refuses, was refused the camera — must be whole inside its scroll container's clip and
 * hit-test to itself **at the scroll offset the user was already at**. No scrolling
 * allowance at all: nothing on screen changed, so the user has no reason to believe anything
 * happened, and "they could scroll to it" is not a route. That is F7, F8, R3-F1 and SH-4.
 * `role="alert"` is the mark of such an answer — a thing worth interrupting for is a thing
 * worth putting on screen — and `role="status"` furniture that is simply part of a long
 * screen is not held to it.
 *
 * **2. A door is where a user looks.** A *door* — a control whose activation is the only way
 * into another screen — must be visible at one of the two offsets a user of an unfamiliar
 * screen actually visits: the offset the screen loads at, or the end of the scroll. Or else
 * it must be **announced**: a control that is itself visible at the top, that names the door
 * in ARIA (`aria-controls`) and takes the user to it. Nothing else earns a pass, and
 * "somewhere in the middle, findable by reading the whole screen" in particular does not.
 *
 * Delete passes rule 2, and should: it is the last control on the sheet, and flicking to the
 * end of a screen is a thing people do. The paint entry failed it at both viewports with
 * **0 of 48 px at both ends** — `#/v/:vin/paint` has exactly one door in the whole app, it
 * sat ~1,000 px down a 2,000 px sheet, and nothing above it said a paint code existed. That
 * gap is the whole point of the rule.
 *
 * The rule is deliberately silent about controls that are not doors: "Refresh details",
 * "Unit", "Notes" and "All fields" all sit mid-scroll and are logged below as observations
 * rather than failures. A control that only changes the screen you are already reading is
 * found by reading it; a door into a screen you have never seen is not. If you do not find
 * the door, the feature does not exist for you — which is what the user reported.
 *
 * ## How a door is identified
 *
 * Not from a list: a list is exactly what lets the *next* control land badly. Every control
 * that fails the visibility test is activated on a throwaway page load, and if the route
 * changed it was a door. A button added anywhere, by anyone, is measured the day it lands.
 */

const VIN = "1FUJGLDR49SAV1234";
const HONDA = "1HGCM82633A004352";

/** vPIC is never reached from a test (§9-S0 network-only); stubbed as `decode.spec.ts` does. */
const VPIC = "**/api/vehicles/DecodeVinValues/**";

/** A full §4.8 answer, so the sheet is the long one the findings are written about. */
const FIELDS: Record<string, string> = {
  ErrorCode: "0",
  Make: "FREIGHTLINER",
  Model: "Cascadia",
  ModelYear: "2009",
  Manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC",
  PlantCity: "CLEVELAND",
  PlantState: "NORTH CAROLINA",
  PlantCountry: "UNITED STATES (USA)",
  BodyClass: "Truck-Tractor",
  VehicleType: "TRUCK",
  GVWR: "Class 8: 33,001 lb and above",
  EngineModel: "DD15",
  EngineCylinders: "6",
  FuelTypePrimary: "Diesel",
  DriveType: "6x4",
  Series: "Cascadia 125",
  Trim: "Sleeper",
  BrakeSystemType: "Air",
  NumberOfSeats: "2",
  TransmissionStyle: "Automated Manual",
};

function record(vin: string, fields: Record<string, string>, unit: string) {
  return {
    vin,
    structural: {},
    decode: {
      status: "ok",
      source: "nhtsa_vpic",
      fetchedAt: "2026-01-01T00:00:00.000+00:00",
      attempts: 1,
      lastError: null,
      fields,
    },
    unit,
    notes: "",
    firstScannedAt: "2026-01-01T00:00:00.000+00:00",
    lastScannedAt: "2026-01-02T00:00:00.000+00:00",
    scanCount: 2,
    origin: "scan",
    metaUpdatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

/** One long record and one short: the sheet's height is the vPIC answer's, not a constant. */
const ROWS = [
  record(VIN, FIELDS, "TRUCK-118"),
  record(HONDA, { Make: "HONDA", Model: "Accord", ModelYear: "2003", ErrorCode: "0" }, "TRUCK-A"),
];

async function seed(page: Page): Promise<void> {
  // Settings first, so Dexie has opened the database before the rows are written.
  await page.goto("/#/settings");
  await page.evaluate(async (rows) => {
    const open = indexedDB.open("vinrelay");
    const dbh: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const tx = dbh.transaction("vehicles", "readwrite");
    for (const row of rows) tx.objectStore("vehicles").put(row);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }, ROWS);
}

/**
 * Everything a thumb or a Tab can land on. `[tabindex="-1"]` is excluded on purpose: it is
 * the mark of a region made focusable as the target of a jump, not of a control.
 */
const CONTROLS =
  'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

interface Measured {
  index: number;
  name: string;
  tag: string;
  height: number;
  /** §6.1's `--tap`, read from the token, or the control's own height if it is shorter. */
  need: number;
  visibleTop: number;
  blockedAtTop: string | null;
  visibleEnd: number;
  blockedAtEnd: string | null;
  scrollHeight: number;
  clientHeight: number;
  seen: boolean;
  announced: boolean;
}

/**
 * Measures every control at the two offsets rule 2 names — the one the screen loads at and
 * the end of the scroll — then puts the scroll back where it was.
 *
 * The hit test is taken at the centre of the control's **visible band**, not of its box: a
 * row taller than what the clip shows has its own centre off screen, and a thumb aims at
 * what it can see. Measuring the box centre instead reads a plainly visible row as unseen.
 */
async function measure(page: Page, controlSelector: string): Promise<Measured[]> {
  return page.evaluate((selector) => {
    const tap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap"));

    function label(el: Element): string {
      const aria = el.getAttribute("aria-label");
      if (aria !== null && aria !== "") return aria;
      const id = el.getAttribute("id");
      if (id !== null && id !== "") {
        const tag = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const text = (tag?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text !== "") return text;
      }
      const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      return own !== "" ? own.slice(0, 60) : `<${el.tagName.toLowerCase()}>`;
    }

    /** The nearest ancestor that actually clips this control, or the document. */
    function scroller(el: Element): Element {
      let node: Element | null = el.parentElement;
      while (node !== null && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
          return node;
        }
        node = node.parentElement;
      }
      return document.scrollingElement ?? document.documentElement;
    }

    const controls: Element[] = [];
    for (const el of document.querySelectorAll(selector)) {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      if ((el as HTMLInputElement).disabled) continue;
      controls.push(el);
    }

    const scrollers = [...new Set(controls.map(scroller))];
    const saved = scrollers.map((node) => node.scrollTop);

    function snap() {
      return controls.map((el) => {
        const box = el.getBoundingClientRect();
        const frame = scroller(el).getBoundingClientRect();
        const top = Math.max(frame.top, 0);
        const bottom = Math.min(frame.bottom, window.innerHeight);
        const visible = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
        const cx = box.left + box.width / 2;
        const cy = (Math.max(box.top, top) + Math.min(box.bottom, bottom)) / 2;
        const hit = visible > 0 ? document.elementFromPoint(cx, cy) : null;
        return {
          visible: Math.round(visible * 100) / 100,
          hitsSelf: hit !== null && (hit === el || el.contains(hit)),
          hit: hit === null ? null : label(hit),
        };
      });
    }

    for (const node of scrollers) node.scrollTop = 0;
    const atTop = snap();
    for (const node of scrollers) node.scrollTop = node.scrollHeight;
    const atEnd = snap();
    scrollers.forEach((node, i) => (node.scrollTop = saved[i]));

    /** A control visible at the top whose `aria-controls` names a region holding this one. */
    function announcedAt(el: Element): boolean {
      for (let j = 0; j < controls.length; j += 1) {
        const box = controls[j].getBoundingClientRect();
        if (atTop[j].visible < Math.min(box.height, tap) - 0.5 || !atTop[j].hitsSelf) continue;
        const ids = (controls[j].getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const region = document.getElementById(id);
          if (region !== null && (region === el || region.contains(el))) return true;
        }
      }
      return false;
    }

    return controls.map((el, i) => {
      const frame = scroller(el);
      const box = el.getBoundingClientRect();
      const need = Math.min(box.height, tap);
      return {
        index: i,
        name: label(el),
        tag: el.tagName.toLowerCase(),
        height: Math.round(box.height * 10) / 10,
        need: Math.round(need * 10) / 10,
        visibleTop: atTop[i].visible,
        blockedAtTop: atTop[i].hitsSelf ? null : atTop[i].hit,
        visibleEnd: atEnd[i].visible,
        blockedAtEnd: atEnd[i].hitsSelf ? null : atEnd[i].hit,
        scrollHeight: frame.scrollHeight,
        clientHeight: frame.clientHeight,
        seen:
          (atTop[i].visible >= need - 0.5 && atTop[i].hitsSelf) ||
          (atEnd[i].visible >= need - 0.5 && atEnd[i].hitsSelf),
        announced: announcedAt(el),
      };
    });
  }, controlSelector);
}

/**
 * How much of an element sits inside its scroll clip right now, and what a tap at the centre
 * of that band would actually hit. One shared measurement for both halves of rule 1.
 */
async function clippedNow(page: Page, selector: string, onlyFresh: boolean): Promise<string[]> {
  return page.evaluate(
    ([controlSelector, fresh]) => {
      function scroller(el: Element): Element {
        let node: Element | null = el.parentElement;
        while (node !== null && node !== document.body) {
          const style = getComputedStyle(node);
          if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
            return node;
          }
          node = node.parentElement;
        }
        return document.scrollingElement ?? document.documentElement;
      }
      function say(el: Element): string {
        return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 44);
      }

      const regions = [...document.querySelectorAll('[role="alert"]')];
      const targets: Element[] = [];
      for (const region of regions) {
        for (const el of [region, ...region.querySelectorAll(controlSelector as string)]) {
          if ((fresh as boolean) && el.hasAttribute("data-rch-standing")) continue;
          targets.push(el);
        }
      }
      if (fresh as boolean) {
        for (const el of document.querySelectorAll(controlSelector as string)) {
          if (!el.hasAttribute("data-rch-standing") && !targets.includes(el)) targets.push(el);
        }
      }

      const bad: string[] = [];
      for (const el of targets) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const frame = scroller(el).getBoundingClientRect();
        const top = Math.max(frame.top, 0);
        const bottom = Math.min(frame.bottom, window.innerHeight);
        const visible = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
        const cy = (Math.max(box.top, top) + Math.min(box.bottom, bottom)) / 2;
        const hit = visible > 0 ? document.elementFromPoint(box.left + box.width / 2, cy) : null;
        const hitsSelf = hit !== null && (hit === el || el.contains(hit));
        if (visible >= box.height - 0.5 && hitsSelf) continue;
        bad.push(
          `"${say(el)}": ${Math.round(visible)} of ${Math.round(box.height)} px inside the clip, ` +
            `a tap there hits ${hit === null ? "nothing" : `"${say(hit)}"`}`,
        );
      }
      return bad;
    },
    [selector, onlyFresh] as const,
  );
}

/**
 * Is control #i a door? Activated on a throwaway load — `reload()` because `goto` to the URL
 * already showing is a same-document no-op, which would leave the previous probe's state
 * standing and can read a focused input as a door.
 */
async function doorTo(page: Page, url: string, index: number): Promise<string | null> {
  await page.goto(url);
  await page.reload();
  await expect(page.locator("main")).toBeAttached();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => location.hash);
  await page.evaluate(
    ([selector, at]) => {
      const controls: Element[] = [];
      for (const el of document.querySelectorAll(selector as string)) {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (box.width === 0 || box.height === 0) continue;
        if (style.visibility === "hidden" || style.display === "none") continue;
        if ((el as HTMLInputElement).disabled) continue;
        controls.push(el);
      }
      // `element.click()`, never Playwright's: Playwright scrolls a control into view before
      // clicking it, which is the one thing a reachability measurement must not do (F8).
      (controls[at as number] as HTMLElement | undefined)?.click();
    },
    [CONTROLS, index] as const,
  );
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => location.hash);
  return after === before ? null : after;
}

const ROUTES = [
  { label: "scan", url: "/#/scan" },
  { label: "history", url: "/#/history" },
  { label: "sheet (20 vPIC fields)", url: `/#/v/${VIN}` },
  { label: "sheet (4 vPIC fields)", url: `/#/v/${HONDA}` },
  { label: "paint capture", url: `/#/v/${VIN}/paint` },
  { label: "settings", url: "/#/settings" },
  { label: "import", url: "/#/i" },
  { label: "account", url: "/#/account" },
];

/** 390×844 is §6.1's phone; 320×658 is the Galaxy S9+ profile `test:e2e:android` runs. */
const PHONES = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "320x658 Galaxy S9+", viewport: { width: 320, height: 658 } },
];

function line(row: Measured): string {
  return (
    `"${row.name}" [${row.tag}] h=${row.height}: ` +
    `${row.visibleTop} of ${row.need} px at the top` +
    (row.blockedAtTop === null ? "" : ` (a tap hits "${row.blockedAtTop}")`) +
    `, ${row.visibleEnd} of ${row.need} px at the end` +
    (row.blockedAtEnd === null ? "" : ` (a tap hits "${row.blockedAtEnd}")`) +
    `, scroll ${row.scrollHeight}/${row.clientHeight}`
  );
}

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use({ viewport: phone.viewport });

    test.beforeEach(async ({ page }) => {
      await page.route(VPIC, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ Results: [{ Make: "HONDA", Model: "Accord", ErrorCode: "0" }] }),
        }),
      );
    });

    for (const route of ROUTES) {
      test(`[RCH-1] every door on ${route.label} is where a user looks`, async ({ page }) => {
        await seed(page);
        await page.goto(route.url);
        await expect(page.locator("main")).toBeAttached();
        // Scan and paint capture both open a camera and both settle into their no-camera
        // state in headless Chromium; every screen is measured settled.
        await page.waitForTimeout(700);

        const rows = await measure(page, CONTROLS);
        expect(rows.length, `${route.label} has no controls at all`).toBeGreaterThan(0);

        const stranded: string[] = [];
        for (const row of rows) {
          if (row.seen || row.announced) continue;
          const door = await doorTo(page, route.url, row.index);
          if (door === null) console.log(`  [RCH] mid-scroll, not a door — ${line(row)}`);
          else stranded.push(`${line(row)} — and it is the only door to ${door}`);
          await page.goto(route.url);
          await page.waitForTimeout(300);
        }

        expect(stranded, `a door on ${route.label} is stranded mid-scroll`).toEqual([]);
      });
    }

    /**
     * Rule 1, at load. A `role="alert"` standing when the screen settles is an answer to
     * something — a refused camera, a write that failed — and it is not an answer at all if
     * it is outside the scroll clip. F7 is this on the two camera error states.
     *
     * What this measures is the alert and the controls **inside** it. `CameraView` renders
     * §6.4's escape routes as siblings of its Banner rather than as its actions, so the
     * other half of F7 — "Retry 0 of 56 px, Type VIN instead 0 of 48" — belongs to
     * `scan-error-fold.spec.ts`, which measures those two by name at three viewports. Both
     * halves are kept: this one generalises to any alert on any screen, that one knows
     * which controls answer the one notice §6.4 pairs them with.
     */
    test("[RCH-2] an alert standing at load is whole where it stands", async ({ page }) => {
      await seed(page);
      for (const route of ROUTES) {
        await page.goto(route.url);
        await expect(page.locator("main")).toBeAttached();
        await page.waitForTimeout(700);
        expect(
          await clippedNow(page, CONTROLS, false),
          `an alert is clipped on ${route.label}`,
        ).toEqual([]);
      }

      // §6.3's `permission_denied`, which headless Chromium never reaches on its own: the
      // browser has a camera and refuses it to this origin. It is the taller of the two
      // camera notices and the one F7 measured at 0 px on every profile.
      await page.addInitScript(() => {
        const devices = navigator.mediaDevices;
        if (!devices) return;
        devices.getUserMedia = () =>
          Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      });
      await page.goto("/#/scan");
      await expect(page.getByRole("alert")).toBeAttached();
      await page.waitForTimeout(500);
      expect(
        await clippedNow(page, CONTROLS, false),
        "the blocked-camera alert is clipped on scan",
      ).toEqual([]);
    });

    /**
     * Rule 1, after a tap, measured generically: everything the DOM *gained* is measured
     * rather than one named element, so a second banner added beside the first is covered
     * the day it lands. The scroll offset is the one the tap came from and nothing moves it
     * but the app itself — F8 and SH-4 were both invisible to tests that let Playwright
     * scroll first.
     */
    test("[RCH-3] the answer to a tap lands where the tap did", async ({ page }) => {
      // SH-4's stub: a share that fails for a reason that is not the user backing out.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: () => Promise.reject(new DOMException("no share target", "NotAllowedError")),
        });
      });
      await seed(page);
      await page.goto(`/#/v/${VIN}`);
      await expect(page.locator("#handoff-heading")).toBeAttached();
      await page.waitForTimeout(500);

      for (const label of ["Share", "Delete"]) {
        const found = await page.evaluate(
          ([selector, name]) => {
            const button = [...document.querySelectorAll("button")].find(
              (candidate) => candidate.textContent?.trim() === name,
            );
            if (button === undefined) return false;
            // Put the user where §6.2 puts the control, mark everything already standing,
            // and tap it in the page so nothing scrolls but the app.
            button.scrollIntoView({ block: "center" });
            for (const el of document.querySelectorAll(
              `${selector as string}, [role="alert"], [role="status"]`,
            )) {
              el.setAttribute("data-rch-standing", "");
            }
            button.click();
            return true;
          },
          [CONTROLS, label] as const,
        );
        expect(found, `no "${label}" button on the sheet`).toBe(true);
        await page.waitForTimeout(400);

        expect(
          await clippedNow(page, CONTROLS, true),
          `the answer to "${label}" did not land in the clip`,
        ).toEqual([]);
      }
    });

    /**
     * The other half of rule 2, and the half that keeps the rule honest.
     *
     * An announcement is the one thing that lets a door below the fold pass, so an
     * `aria-controls` attribute that pointed at the right id and did nothing would turn the
     * rule into a formality. This measures the announcement doing its job: the signpost is
     * a §6.1 target the user can see at the fold, the tap is `element.click()` in the page
     * so nothing but the app scrolls, and afterwards both routes into the paint code — the
     * field and the camera — are whole inside the clip with focus on the block.
     */
    test("[RCH-4] the fold's paint signpost puts both routes on screen", async ({ page }) => {
      await seed(page);
      await page.goto(`/#/v/${VIN}`);
      await expect(page.locator("#sheet-paint")).toBeAttached();
      await page.waitForTimeout(500);

      const jumped = await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main === null) throw new Error("no <main>");
        main.scrollTop = 0;
        const tap = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--tap"),
        );
        const signpost = [...document.querySelectorAll("button[aria-controls]")].find(
          (candidate) =>
            document
              .getElementById(candidate.getAttribute("aria-controls") ?? "")
              ?.contains(document.getElementById("sheet-paint")) === true,
        );
        if (signpost === undefined) return null;

        function inClip(el: Element) {
          const clip = main!.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          const top = Math.max(clip.top, 0);
          const bottom = Math.min(clip.bottom, window.innerHeight);
          const visible = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
          const cy = (Math.max(box.top, top) + Math.min(box.bottom, bottom)) / 2;
          const hit = visible > 0 ? document.elementFromPoint(box.left + box.width / 2, cy) : null;
          return {
            height: Math.round(box.height * 10) / 10,
            visible: Math.round(visible * 10) / 10,
            hitsSelf: hit !== null && (hit === el || el.contains(hit)),
          };
        }

        const before = inClip(signpost);
        (signpost as HTMLElement).click();

        const field = document.getElementById("sheet-paint");
        const camera = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Read the code with the camera",
        );
        if (field === null || camera === undefined) return null;
        const block = document.getElementById("sheet-paint-block");
        return {
          tap,
          signpost: before,
          field: inClip(field),
          camera: inClip(camera),
          focusInBlock: block !== null && block.contains(document.activeElement),
        };
      });

      expect(jumped, "no control at the fold announces the paint block").not.toBeNull();
      const seen = jumped!;
      // §6.1: the signpost is a target like any other, and it is the one the user must find.
      expect(seen.signpost.height).toBeGreaterThanOrEqual(seen.tap);
      expect(seen.signpost.visible).toBeCloseTo(seen.signpost.height, 1);
      expect(seen.signpost.hitsSelf).toBe(true);
      // Both routes to a paint code, whole and tappable, after one tap from the fold.
      expect(seen.field.visible).toBeCloseTo(seen.field.height, 1);
      expect(seen.field.hitsSelf).toBe(true);
      expect(seen.camera.visible).toBeCloseTo(seen.camera.height, 1);
      expect(seen.camera.hitsSelf).toBe(true);
      // §6.6: the same signpost has to work from a keyboard, so focus goes with the scroll.
      expect(seen.focusInBlock).toBe(true);
    });
  });
}
