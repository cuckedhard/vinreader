/**
 * [F2-a] The one line of the §4.9 URL carrier that no behavioural test can reach.
 *
 * `buildPayloadUrl(payload, base)` is thoroughly tested for what it does with the base it is
 * handed — `codec.test.ts` covers a scheme, a port and a sub-path. What it is *handed* is a
 * different question, and it is the one F2 was: the QR pointed at `location.origin`, which
 * is scheme + host + port and nothing else, so on the GitHub Pages deployment
 * (`https://<user>.github.io/vinreader/`) the second phone opened the site root and the
 * handoff §4.9 exists for was dead. The fix was one argument. Reverting it leaves the whole
 * unit suite green — vitest runs in `node`, where there is no `window` at all — and the
 * Playwright harness only ever serves the root build, where the two strings are identical
 * by construction. The ledger's own words: "the derivation is well tested; the wiring is
 * not."
 *
 * So this reads the source, in the same spirit as `auth/client.test.ts`'s "no behavioural
 * test can catch that; reading the source can". Two rules:
 *
 *  1. Nothing under `src/`, outside `appBase.ts`'s own prose, may read `location.origin`.
 *  2. `buildCopyTexts` — the single entry point that turns a record into §4.9's carriers,
 *     the QR among them — is called from exactly one place, and that call passes the app
 *     base.
 *
 * Rule 2 is written as an exhaustive list rather than a spot check because a *second* call
 * site is precisely how this comes back: the next screen that wants a QR will pass whatever
 * is nearest to hand.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Comments are where this rule is *explained*, in three files, so they cannot be where it
 * is measured. Block comments go whole; line comments go only when the line is nothing but
 * a comment, which leaves regex literals such as `/#\/?i\?…/` alone.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function relative(path: string): string {
  return path.slice(SRC.length).replace(/^\//, "");
}

describe("[F2-a] §4.9's URL carrier is built from the app's base, not the bare origin", () => {
  const files = sourceFiles(SRC).map((path) => ({ path, code: withoutComments(readFileSync(path, "utf8")) }));

  it("finds the source tree it means to read", () => {
    // A scan that found nothing would satisfy every assertion below.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((file) => relative(file.path))).toContain("features/sheet/Actions.tsx");
  });

  it("reads `location.origin` nowhere in the app", () => {
    const readers = files
      .filter((file) => /location\s*\.\s*origin/.test(file.code))
      .map((file) => relative(file.path));

    // `appBase.ts` is allowed `location.href` — resolved against `import.meta.env.BASE_URL`,
    // which is what carries the deployment's sub-path — and that is the only reading of the
    // running document's URL the app makes.
    expect(readers).toEqual([]);
  });

  it("builds every §4.9 carrier through one call site, and that call passes the app base", () => {
    const callers = files
      .filter((file) => /\bbuildCopyTexts\s*\(/.test(file.code))
      .map((file) => relative(file.path));

    // `copyTexts.ts` is the definition; `Actions.tsx` is the caller. A third name here is a
    // new place where the base can be wrong, and it should fail until it is looked at.
    expect(callers.sort()).toEqual(["features/sheet/Actions.tsx", "features/sheet/copyTexts.ts"]);

    const actions = files.find((file) => relative(file.path) === "features/sheet/Actions.tsx")!;
    expect(actions.code).toMatch(/buildCopyTexts\([^)]*appBaseUrl\(\)\)/);
    expect(actions.code).toMatch(/import\s*\{\s*appBaseUrl\s*\}\s*from\s*"\.\.\/\.\.\/app\/appBase"/);
  });
});
