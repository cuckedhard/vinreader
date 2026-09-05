import { execSync } from "node:child_process";

/**
 * [G4] The year this build was made, injected as `__BUILD_YEAR__` by every config that
 * builds the app (`vite.config.ts`, `vite.pages.config.ts` and, so the same value reaches
 * the unit tests, `vitest.config.ts`). One definition, imported by all three (§7 item 5).
 *
 * §4.4 step 0 caps the model year at "the current year + 1", and §4.4 says the current
 * year is an explicit input, never read from a clock inside the function. Every caller
 * read it off the device clock, which on a phone that lost its RTC, was left flat in the
 * cold, or was factory-reset with no signal to fetch time from can read years earlier than
 * the truck being scanned — and then the cap written to refuse a *future* year refuses the
 * real one and §4.4 resolves a 2023 truck to 1993, as a fact (N2).
 *
 * A device with no network cannot learn the date, but it does hold one thing it can trust
 * about time: itself. It cannot be running before it was built. So the build year is a
 * lower bound on "now" that no clock can drag below, and flooring the caller's year at it
 * makes a stale clock behave exactly as a correct one does.
 *
 * The commit date and not the wall clock: it is the date the artifact demonstrably existed
 * on, and it does not move if the build machine's own clock is wrong. Without git — a
 * source tarball — the builder's clock is the next best lower bound, and a build that
 * cannot establish either falls back to `0`, which floors nothing and leaves §4.4 reading
 * the clock exactly as it did before.
 */
export function buildYear(): number {
  const committed = gitCommitYear();
  if (committed !== null) return committed;
  const wall = new Date().getFullYear();
  return Number.isInteger(wall) ? wall : 0;
}

function gitCommitYear(): number | null {
  try {
    const out = execSync("git log -1 --format=%cd --date=format:%Y", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const year = Number(out);
    return Number.isInteger(year) && year > 0 ? year : null;
  } catch {
    return null;
  }
}
