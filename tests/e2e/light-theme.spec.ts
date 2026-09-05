import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The light theme, rendered. Until this file existed nothing in the gate had ever painted
 * it: §13.5 runs the whole suite in one palette, `tokens.css` is checked as text by
 * `src/ui/stylesheets.test.ts`, and vitest has no DOM — so the eight light body-text pairs
 * that failed 7:1 before Z4 could have come back at any commit and no run would have said
 * so. It runs under the `light` project in `playwright.config.ts`, which is where the
 * `colorScheme: "light"` that makes the "System" case mean something is set.
 *
 * Three things are guarded here, all §6.1:
 *  - the palette follows the §5.6 setting, *and so does the browser's own chrome*;
 *  - a stored light theme is in force on the first painted frame, not 63–441 ms later;
 *  - rendered body text clears 7:1 and the focus ring stays visible.
 *
 * The last one is the reason this measures the *page* rather than the tokens. A token can
 * clear 7:1 against both grounds and still be put on a third by a component — the primary
 * button's fill is `--accent`, the theme radio's is too — and only a rendered tree knows
 * which pairs actually occur.
 */

/** §4.11: valid, and the same VIN with position 9 wrong so §4.3's banner fires. */
const VIN = "1HGCM82633A004352";
const MISMATCH_VIN = "1HGCM82633A004353";

/**
 * §5.4 kicks a decode on save, and this suite must not depend on reaching NHTSA — the
 * egress policy here refuses that host, and the sheet's decode block is text this file
 * measures. Stubbed so the same rows are on screen every run (as `smoke.spec.ts` does).
 */
const VPIC = "**/api/vehicles/DecodeVinValues/**";
const VPIC_BODY = {
  Results: [{ Make: "HONDA", Model: "Accord", ModelYear: "2003", ErrorCode: "0", ErrorText: "" }],
};

async function chooseTheme(page: Page, label: "Dark" | "Light" | "System"): Promise<void> {
  await page.goto("/#/settings");
  const option = page.getByRole("radio", { name: label, exact: true });
  await option.click();
  await expect(option).toHaveAttribute("aria-checked", "true");
}

/**
 * Both sides of a colour comparison go through the browser, because the two writers spell
 * the same colour differently and neither is wrong: the pre-paint bootstrap in index.html
 * writes the literal `#ffffff`, while `applyTheme` reads `--bg` back out of the stylesheet,
 * where the production build's CSS minifier has already shortened it to `#fff`. Asserting
 * on the string would fail on a build setting rather than on the app.
 */
async function asRgb(page: Page, color: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, color);
}

async function themeColor(page: Page): Promise<string> {
  const content = await page.locator('meta[name="theme-color"]').first().getAttribute("content");
  expect(content).not.toBeNull();
  return asRgb(page, content as string);
}

async function backgroundToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  );
  return asRgb(page, token);
}

/**
 * FINDING 1. Android Chrome paints its toolbar from `theme-color`, and index.html could only
 * ever say one thing, so the light palette got a dark toolbar above a white page. The
 * assertion is "the chrome is the colour the page actually painted", not a literal, so a
 * palette edit cannot desync the two without also failing here.
 */
test("the palette and the browser's own chrome change together", async ({ page }) => {
  await chooseTheme(page, "Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const light = await themeColor(page);
  expect(light).toBe(await backgroundToken(page));

  await chooseTheme(page, "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await themeColor(page);
  expect(dark).toBe(await backgroundToken(page));

  // Not the same colour twice: a writer that always wrote the dark value would satisfy every
  // assertion above except this one.
  expect(light).not.toBe(dark);

  // This project runs with `colorScheme: "light"`, so "System" is the third state — the one
  // two media-scoped `theme-color` tags would have covered and the other two would not.
  await chooseTheme(page, "System");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await themeColor(page)).toBe(light);
});

interface FirstFrame {
  theme: string | undefined;
  background: string;
}

/** One write of `data-theme`, and how much of the document existed when it happened. */
interface ThemeWrite {
  value: string | null;
  /** `#root`'s child count, or -1 when there is no `#root` in the document yet. */
  rendered: number;
}

/**
 * Records two things about a load, from an init script that runs before any script of the
 * page's own — including the pre-paint bootstrap in `index.html`:
 *
 *  - the document as it stood for the first frame the browser drew (`requestAnimationFrame`
 *    from here runs before that frame is painted);
 *  - every write of `data-theme`, in order, with the state of `#root` at each one.
 *
 * The second is what proves the theme was not the post-hydration writer in `Shell`, and it
 * replaces the guard that used to do it — `#root`'s child count at the first frame, asserted
 * to be 0 (G6 / R6-SA-2). That was a race between the browser's first paint and React's
 * mount, not a property of the app: with the bundle warm in the HTTP cache React sometimes
 * won, and the assertion failed with "React had already rendered, so this proves nothing".
 * Measured 2 failures in 12 repeats before this change, 0 in 40 after. `desktop` lists
 * `light` in its `dependencies` (playwright.config.ts), so each of those failures skipped
 * the whole of `bun run test:e2e` — scan, offline, import and share included.
 *
 * The replacement is not a race: `index.html`'s bootstrap is an inline script in `<head>`,
 * so at the moment it writes `data-theme` the parser has not reached `<body>` and `#root`
 * does not exist. A theme that arrived from React instead would carry a count of 0 or more,
 * on any machine, at any cache temperature.
 */
async function recordLoad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __firstFrame: FirstFrame | null;
      __themeWrites: ThemeWrite[];
    };
    target.__firstFrame = null;
    target.__themeWrites = [];
    // `document`, not `documentElement`, which does not exist yet this early; a subtree
    // observer on the document sees the attribute wherever `<html>` turns up.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName !== "data-theme") continue;
        target.__themeWrites.push({
          value: document.documentElement.getAttribute("data-theme"),
          rendered: document.getElementById("root")?.childElementCount ?? -1,
        });
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme"] });
    requestAnimationFrame(() => {
      target.__firstFrame = {
        theme: document.documentElement.dataset.theme,
        background: getComputedStyle(document.body).backgroundColor,
      };
    });
  });
}

async function firstFrame(page: Page): Promise<FirstFrame> {
  const frame = await page.evaluate(
    () => (window as unknown as { __firstFrame: FirstFrame | null }).__firstFrame,
  );
  expect(frame, "no frame was drawn before the page was inspected").not.toBeNull();
  return frame as FirstFrame;
}

/** The first write of `data-theme` on the load being inspected — the one that must be ours. */
async function firstThemeWrite(page: Page): Promise<ThemeWrite> {
  const writes = await page.evaluate(
    () => (window as unknown as { __themeWrites: ThemeWrite[] }).__themeWrites,
  );
  expect(writes.length, "nothing ever wrote data-theme on this load").toBeGreaterThan(0);
  return writes[0] as ThemeWrite;
}

/**
 * FINDING 2. The choice lives in Dexie (§5.6), which cannot answer before the first paint,
 * so a light-theme user was shown the dark palette on every launch until it did. Both
 * directions are asserted: the stored choice arrives in time, and the dark default — the
 * majority who never open the setting — is not made to flash by the machinery that fixes it.
 */
test("the stored theme is already in force on the first painted frame", async ({ page }) => {
  await recordLoad(page);

  await chooseTheme(page, "Light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const cold = await firstFrame(page);
  expect(cold.theme).toBe("light");
  expect(cold.background).toBe(await backgroundToken(page));
  // And it was in force before there was anything for React to have rendered into, so the
  // two assertions above cannot be satisfied by `Shell` re-applying the row after Dexie
  // answers 63–441 ms later.
  expect(await firstThemeWrite(page), "the first write was not the pre-paint bootstrap").toEqual({
    value: "light",
    rendered: -1,
  });

  await chooseTheme(page, "Dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const back = await firstFrame(page);
  expect(back.theme).toBe("dark");
  expect(back.background).toBe(await backgroundToken(page));
  expect(await firstThemeWrite(page), "the first write was not the pre-paint bootstrap").toEqual({
    value: "dark",
    rendered: -1,
  });
});

interface ContrastFailure {
  text: string;
  color: string;
  background: string;
  ratio: number;
}

interface RingMeasurement {
  on: string;
  style: string;
  width: number;
  ratio: number;
}

interface ThemeReport {
  /** Every visible run of body text measured below §6.1's 7:1 floor. Empty is the pass. */
  belowFloor: ContrastFailure[];
  /** The focus ring on `document.activeElement`, or null if nothing is focused. */
  ring: RingMeasurement | null;
}

/**
 * One pass over the rendered page, measuring both things §6.1 states as ratios.
 *
 * Both come back from a single `page.evaluate` because Playwright ships the callback's source
 * to the browser and closures do not travel with it: anything the measurement needs has to be
 * defined inside. Two evaluates would mean two copies of the same colour arithmetic, and the
 * copy that drifts is the one that stops failing.
 *
 * Inactive controls are skipped: WCAG 1.4.3 exempts them, and `Button` fades them on purpose,
 * so including them would assert something §6.1 does not ask for.
 */
async function measure(page: Page): Promise<ThemeReport> {
  return page.evaluate(() => {
    interface Rgba {
      r: number;
      g: number;
      b: number;
      a: number;
    }

    const parse = (value: string): Rgba | null => {
      const parts = (value.match(/-?[\d.]+/g) ?? []).map(Number);
      if (parts.length < 3) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };

    const over = (top: Rgba, bottom: Rgba): Rgba => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });

    const luminance = (c: Rgba): number => {
      const [r, g, b] = [c.r, c.g, c.b].map((channel) => {
        const s = channel / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const ratio = (a: Rgba, b: Rgba): number => {
      const [la, lb] = [luminance(a), luminance(b)];
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    // The nearest opaque ancestor background, compositing anything translucent on the way —
    // the element's own fill counts first, which is what puts the primary button's label on
    // `--accent` rather than on the page.
    const backgroundOf = (start: Element): Rgba => {
      let node: Element | null = start;
      let stack: Rgba | null = null;
      while (node !== null) {
        const layer = parse(getComputedStyle(node).backgroundColor);
        if (layer !== null && layer.a > 0) {
          stack = stack === null ? layer : over(stack, layer);
          if (stack.a >= 0.999) return stack;
        }
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };

    const belowFloor: ContrastFailure[] = [];
    for (const element of document.querySelectorAll("body *")) {
      if (element.closest("[disabled], [aria-disabled='true']") !== null) continue;
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => (node.textContent ?? "").trim())
        .join(" ")
        .trim();
      if (text === "") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      const color = parse(style.color);
      if (color === null || color.a === 0) continue;
      const background = backgroundOf(element);
      const measured = ratio(over(color, background), background);
      if (measured < 7) {
        belowFloor.push({
          text: text.slice(0, 60),
          color: style.color,
          background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
          ratio: Math.round(measured * 100) / 100,
        });
      }
    }

    // The focus ring is drawn outside the control, so it sits on whatever is behind the
    // control — the parent's fill if it has one, the first opaque ancestor otherwise.
    const focused = document.activeElement;
    let ring: RingMeasurement | null = null;
    if (focused !== null && focused !== document.body && focused !== document.documentElement) {
      const style = getComputedStyle(focused);
      const outline = parse(style.outlineColor);
      const ground = backgroundOf(focused.parentElement ?? document.body);
      if (outline !== null) {
        ring = {
          on: (focused.textContent ?? "").trim().slice(0, 30),
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
          ratio: Math.round(ratio(over(outline, ground), ground) * 100) / 100,
        };
      }
    }

    return { belowFloor, ring };
  });
}

/**
 * FINDING 3, the part §6.1 states as a number. The screens are the ones that carry banners
 * and chips, because those are where a token lands on `--bg-elev` — the harder of the two
 * grounds, and the one every light value cleared by the smallest margin.
 */
test("light body text clears the 7:1 floor where banners and chips live", async ({ page }) => {
  await page.route(VPIC, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(VPIC_BODY),
    }),
  );

  await chooseTheme(page, "Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect((await measure(page)).belowFloor, "settings").toEqual([]);

  // §4.3's mismatch banner, plus the check-digit chips beside the entry field.
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill(MISMATCH_VIN);
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();
  await expect(page.getByRole("button", { name: /use as-is/i })).toBeVisible();
  expect((await measure(page)).belowFloor, "check-digit mismatch banner").toEqual([]);

  // The sheet: the warn chip the mismatch leaves behind, plus a settled decode block. Scoped
  // to the §4.8 Identity group because the raw vPIC field list repeats every value.
  await page.getByRole("button", { name: /use as-is/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/v/${MISMATCH_VIN}`));
  await expect(page.getByLabel("Identity").getByText("Accord")).toBeVisible();
  expect((await measure(page)).belowFloor, "sheet").toEqual([]);

  // A second, clean VIN so History shows both an ok chip and a warn one.
  await page.goto("/#/scan");
  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.locator("input[type=text], input:not([type])").first().fill(VIN);
  await page
    .getByRole("button", { name: /save|add|decode/i })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`#/v/${VIN}`));

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
  expect((await measure(page)).belowFloor, "history").toEqual([]);
});

/**
 * FINDING 3, the other half. §6.6 requires a visible focus ring and R4-E already found it
 * absent once — over live video, in both themes. The ring is `--accent`, which moved a long
 * way in the light palette (6.24 → 7.96 on `--bg`), so it is worth holding to WCAG 2.4.11's
 * 3:1 for a non-text indicator here as well.
 *
 * Reached with Tab rather than `focus()`: `:focus-visible` does not match a scripted focus in
 * Chromium, and a test that focuses the wrong way measures an outline that is never drawn.
 */
test("the focus ring stays visible in the light palette", async ({ page }) => {
  await chooseTheme(page, "Light");
  // Focus is on the option just clicked, so one Tab lands on the next one — a bordered
  // control on `--bg-elev`, which is the ring's worse ground of the two in this palette.
  await page.keyboard.press("Tab");

  const { ring } = await measure(page);
  expect(ring, "Tab moved focus nowhere").not.toBeNull();
  expect(ring?.style).not.toBe("none");
  expect(ring?.width).toBeGreaterThanOrEqual(2);
  expect(ring?.ratio).toBeGreaterThanOrEqual(3);
});
