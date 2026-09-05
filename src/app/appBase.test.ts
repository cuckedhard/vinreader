/**
 * [F2] Where the §4.9 carrier says this app lives.
 *
 * `codec.ts` was already right about this — `baseUrl()` keeps a sub-path's trailing slash,
 * and `codec.test.ts` pins `https://vin.relay.test/app/`. The caller was not: the Sheet
 * passed `window.location.origin`, which is the bare scheme + host and drops the path
 * entirely. Under the GitHub Pages deployment at `https://<user>.github.io/vinreader/` the
 * QR therefore encoded `https://<user>.github.io/#/i?d=…` — the user's site root, not the
 * app — and §4.9's device-to-device handoff was dead on that deployment. Proven by decoding
 * the rendered canvas, not by reading the code: the QR read back as
 * `http://127.0.0.1:4173/#/i?d=…` while the page was at `/vinreader/`.
 *
 * This is the derivation that fixes it, kept in one place and tested here because the call
 * site is inside a `useMemo` in a component that needs a browser to render.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { appBaseUrl, resolveAppBase } from "./appBase";
import { buildPayloadUrl } from "../lib/payload/codec";

const PAGES = "https://cuckedhard.github.io/vinreader/";
const PAYLOAD = { v: 1 as const, vin: "1HGCM82633A004352" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolving the app's own base", () => {
  it("keeps the sub-path a project deployment is served from", () => {
    expect(resolveAppBase(`${PAGES}#/v/1HGCM82633A004352`, "/vinreader/")).toBe(PAGES);
  });

  it("is the origin, unchanged, at the root of a host", () => {
    // The shape the app has shipped under until now, so this fix moves nothing there.
    expect(resolveAppBase("https://vinrelay.example/#/scan", "/")).toBe(
      "https://vinrelay.example/",
    );
    expect(resolveAppBase("http://192.168.1.9:5173/#/scan", "/")).toBe("http://192.168.1.9:5173/");
  });

  it("resolves a relative base against the document that is open", () => {
    // `vite.demo.config.ts` builds with `base: "./"`, and `origin + "./"` would have made
    // the host itself wrong ("https://host./"). Resolution, not concatenation.
    expect(resolveAppBase("https://host.example/demo/index.html#/scan", "./")).toBe(
      "https://host.example/demo/",
    );
  });

  it("always ends in the slash §4.9's carrier is appended to", () => {
    for (const [href, base] of [
      [`${PAGES}#/scan`, "/vinreader/"],
      ["https://vinrelay.example/#/scan", "/"],
      ["https://host.example/demo/index.html", "./"],
    ] as const) {
      expect(resolveAppBase(href, base).endsWith("/")).toBe(true);
    }
  });
});

describe("the URL carrier the Sheet hands to a second phone (§4.9)", () => {
  it("points at the app under a sub-path, not at the site root", () => {
    const url = buildPayloadUrl(PAYLOAD, resolveAppBase(`${PAGES}#/v/x`, "/vinreader/")).url;
    expect(url.startsWith(`${PAGES}#/i?d=`)).toBe(true);
    // The bug, spelled out: the origin alone lands on the user's own Pages site.
    expect(url.startsWith("https://cuckedhard.github.io/#/i?d=")).toBe(false);
  });

  it("is unchanged at the root of a host", () => {
    const derived = buildPayloadUrl(PAYLOAD, resolveAppBase("https://vinrelay.example/#/v/x", "/"));
    const origin = buildPayloadUrl(PAYLOAD, "https://vinrelay.example");
    expect(derived.url).toBe(origin.url);
  });
});

describe("what the Sheet actually calls", () => {
  it("reads the running document and the build's own base", () => {
    vi.stubGlobal("window", { location: { href: `${PAGES}#/v/1HGCM82633A004352` } });
    vi.stubEnv("BASE_URL", "/vinreader/");
    expect(appBaseUrl()).toBe(PAGES);
  });
});
