import { expect, describe, it, vi } from "vitest";
import type { FullConfig, Suite, TestCase } from "@playwright/test/reporter";
import playwrightConfig from "../playwright.config";
import DidNotRunReporter, { didNotRunReport } from "./e2e/did-not-run-reporter";
import type { CountedTest } from "./e2e/did-not-run-reporter";

/**
 * [G6-a] The `dependencies` edge that makes §13.5's e2e leg skippable must announce itself.
 *
 * `playwright.config.ts` gives `desktop` `dependencies: ["light", "pages"]` and `test:e2e` is
 * `--project=desktop`, so a red light or pages spec stops the whole desktop project before it
 * starts. That edge is load-bearing — without it those two guards are outside the gate — and
 * it is not what is under test here. What is under test is that when it fires, the run says
 * so: `G6` and `R6-SA-2` were one defect filed twice, and both times the damage came from
 * `1 failed · 43 did not run · 3 passed` being read as a small failure.
 *
 * The states below are the three the reporter has to tell apart, and only the middle one is a
 * defect: a run where everything executed, a run stopped by a red dependency, and a run with
 * a deliberate `test.skip`. The counting rule is copied from Playwright's own
 * `generateSummary`, so the last case matters — a `test.skip` case *has* a result and
 * `expectedStatus: "skipped"`, and calling it "did not run" would make this reporter cry
 * wolf on every conditional skip in the suite.
 */

function ran(project: string, title: string): CountedTest {
  return {
    project,
    title,
    outcome: "expected",
    expectedStatus: "passed",
    results: [{ status: "passed" }],
  };
}

function failed(project: string, title: string): CountedTest {
  return {
    project,
    title,
    outcome: "unexpected",
    expectedStatus: "passed",
    results: [{ status: "failed" }],
  };
}

/** What a dependency failure leaves behind: outcome `skipped`, and no result at all. */
function neverRan(project: string, title: string): CountedTest {
  return { project, title, outcome: "skipped", expectedStatus: "passed", results: [] };
}

/** `test.skip(...)`: a result exists and the skip was expected. Not a defect. */
function deliberatelySkipped(project: string, title: string): CountedTest {
  return {
    project,
    title,
    outcome: "skipped",
    expectedStatus: "skipped",
    results: [{ status: "skipped" }],
  };
}

describe("[G6-a] a skipped e2e leg is reported as a skipped e2e leg", () => {
  it("says nothing when every test executed", () => {
    expect(didNotRunReport([ran("light", "a"), ran("pages", "b"), ran("desktop", "c")])).toBeNull();
  });

  it("counts, names and shouts about the desktop leg a red dependency skipped", () => {
    const tests = [
      failed("light", "light-theme.spec.ts › the stored theme is already in force"),
      ran("light", "light-theme.spec.ts › the banner palette"),
      ran("light", "light-theme.spec.ts › the focus ring"),
      ran("pages", "pages-service-worker.spec.ts › the worker registers"),
      ...Array.from({ length: 43 }, (_unused, i) => neverRan("desktop", `desktop spec ${i}`)),
    ];

    const report = didNotRunReport(tests);
    expect(report, "43 unexecuted tests is a report, not null").not.toBeNull();
    expect(report?.didNotRun).toBe(43);
    expect(report?.executed).toBe(4);
    expect([...(report?.byProject ?? [])]).toEqual([["desktop", 43]]);
    expect(report?.redProjects).toEqual(["light"]);

    // The banner is the whole point of the row: the number, the project, the cause, and the
    // fact that the leg certified nothing. All four, or a reader skims it like the summary.
    const banner = report?.banner ?? "";
    expect(banner).toContain("43 of 47 e2e tests NEVER RAN");
    expect(banner).toContain("desktop — 43 tests did not run");
    expect(banner).toContain("Red dependency: light");
    expect(banner).toContain("4 tests did execute");
    expect(banner, "not a partial pass, in those words").toContain("This is not a partial pass");
  });

  it("does not call a deliberate test.skip a test that did not run", () => {
    expect(didNotRunReport([ran("desktop", "a"), deliberatelySkipped("desktop", "b")])).toBeNull();
  });

  /**
   * A `test.skip`-declared case *in the project that never started*: no result at all, and an
   * `expectedStatus` of `skipped`. Playwright's rule counts it — `!results.length` comes first
   * — and so does this, or the banner's number would be one short of the summary's on any
   * skipped leg that happens to contain a declared skip.
   */
  it("counts a declared skip that belongs to a project which never started", () => {
    const declaredButNeverReached: CountedTest = {
      project: "desktop",
      title: "insecure-context.spec.ts › needs a non-loopback address",
      outcome: "skipped",
      expectedStatus: "skipped",
      results: [],
    };
    const report = didNotRunReport([ran("light", "a"), declaredButNeverReached]);
    expect(report?.didNotRun).toBe(1);
    expect([...(report?.byProject ?? [])]).toEqual([["desktop", 1]]);
  });

  /**
   * The other half of Playwright's rule, and the reason it is not just `results.length === 0`:
   * a case can carry a `skipped` result it never asked for — a setup fixture or a `beforeAll`
   * that bailed — and `expectedStatus` stays `passed`. Playwright counts that as "did not
   * run"; so does this, or the two numbers in the same output would disagree.
   */
  it("counts a test skipped without ever expecting to be", () => {
    const bailed: CountedTest = {
      project: "desktop",
      title: "a fixture skipped it",
      outcome: "skipped",
      expectedStatus: "passed",
      results: [{ status: "skipped" }],
    };
    const report = didNotRunReport([ran("desktop", "a"), bailed]);
    expect(report?.didNotRun).toBe(1);
    expect(report?.banner).toContain("1 of 2 e2e tests NEVER RAN");
  });

  /**
   * An interrupted case is Playwright's third state — the run was killed while that test was
   * executing — and it is already reported as `interrupted`. Counting it again here would
   * double-report a Ctrl-C.
   */
  it("does not count an interrupted test twice", () => {
    const interrupted: CountedTest = {
      project: "desktop",
      title: "interrupted",
      outcome: "skipped",
      expectedStatus: "passed",
      results: [{ status: "interrupted" }],
    };
    expect(didNotRunReport([ran("desktop", "a"), interrupted])).toBeNull();
  });

  /**
   * A run cut short with no red project at all — `--max-failures`, a killed worker, a
   * dependency whose `webServer` never came up. There is no dependency to name, so the
   * banner has to say that rather than name an empty one.
   */
  it("explains a skip that no failure accounts for", () => {
    const report = didNotRunReport([ran("desktop", "a"), neverRan("desktop", "b")]);
    expect(report?.redProjects).toEqual([]);
    expect(report?.banner).toContain("No project reported a failure");
  });
});

/**
 * The teeth. Playwright already exits 1 when a dependency fails, so the banner alone would be
 * cosmetic; `onEnd` returning `status: "failed"` is what makes an unexecuted test unable to
 * coexist with a green exit by any route — `--max-failures`, a killed worker, or a later
 * config in which the failing project no longer fails the run.
 */
function fakeSuite(tests: readonly CountedTest[]): Suite {
  const cases = tests.map(
    (test) =>
      ({
        parent: { project: () => ({ name: test.project }) },
        titlePath: () => ["", test.project, test.title],
        outcome: () => test.outcome,
        expectedStatus: test.expectedStatus,
        results: test.results,
      }) as unknown as TestCase,
  );
  return { allTests: () => cases } as unknown as Suite;
}

describe("[G6-a] the run cannot exit green having skipped a project", () => {
  it("forces the run to fail and prints the banner", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const reporter = new DidNotRunReporter();
      reporter.onBegin({} as FullConfig, fakeSuite([ran("light", "a"), neverRan("desktop", "b")]));
      await expect(reporter.onEnd()).resolves.toEqual({ status: "failed" });
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "1 of 2 e2e tests NEVER RAN",
      );
    } finally {
      write.mockRestore();
    }
  });

  it("leaves a clean run's status alone and prints nothing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const reporter = new DidNotRunReporter();
      reporter.onBegin({} as FullConfig, fakeSuite([ran("light", "a"), ran("desktop", "b")]));
      await expect(reporter.onEnd()).resolves.toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});

/**
 * And the reporter is wired in, because a guard nobody runs is the defect this row is about.
 * Asserted against the config object Playwright itself loads, not against the file's text.
 */
describe("[G6-a] the reporter is inside the run it guards", () => {
  it("playwright.config.ts names the did-not-run reporter", () => {
    const reporter = playwrightConfig.reporter;
    expect(Array.isArray(reporter), "a list of reporters, so `list` survives beside it").toBe(true);
    const names = (reporter as readonly (string | readonly [string, unknown?])[]).map((entry) =>
      typeof entry === "string" ? entry : entry[0],
    );
    expect(names).toContain("./tests/e2e/did-not-run-reporter.ts");
    expect(names, "the default reporter this list replaces").toContain("list");
  });

  /**
   * The edge is why the reporter exists. If it ever goes, this test is the note that says the
   * banner is now dead code and the two guards it carried need another way into the gate —
   * not a licence to delete the reporter quietly.
   */
  it("desktop still depends on the two projects that can skip it", () => {
    const desktop = playwrightConfig.projects?.find((project) => project.name === "desktop");
    expect(desktop?.dependencies).toEqual(["light", "pages"]);
  });
});
