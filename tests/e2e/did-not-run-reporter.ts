/**
 * [G6-a] A skipped e2e leg must not read like a small failure (§13.5).
 *
 * `playwright.config.ts` gives the `desktop` project `dependencies: ["light", "pages"]`, and
 * `package.json`'s `test:e2e` is `--project=desktop`. The edge is deliberate: it is the only
 * thing that puts the light-theme and Pages-service-worker guards inside §13.5's e2e leg. Its
 * cost is that **any** red in either dependency stops Playwright before the desktop project
 * runs at all — the fake-camera scan flows, offline, import and the share fallbacks — and the
 * summary for that is `1 failed · 43 did not run · 3 passed`, three yellow words in a line
 * whose first token is a small number. `G6` and `R6-SA-2` were the same defect filed twice,
 * and both times what made it costly was not the flaky assertion (since removed) but this:
 * the run that measured 4 of 47 tests looked like the run that measured 47.
 *
 * So the edge stays and the skip gets a voice. `didNotRunReport` counts the tests Playwright
 * itself counts as "did not run" — the identical rule from `generateSummary`, so this can
 * never disagree with the number beside it — and `onEnd` prints a banner naming the projects
 * that lost tests, the projects that went red, and what the run therefore does *not* certify.
 * It also returns `status: "failed"`, so a run with unexecuted tests cannot exit green by any
 * route: not through `--max-failures`, not through an interrupted dependency, not through a
 * future config where the failing project is `ignoreErrors`-ish.
 *
 * The counting is a pure function over a plain shape rather than over `TestCase`, so
 * `tests/did-not-run-reporter.test.ts` can construct the states — a dependency failure, a
 * deliberate `test.skip`, a clean run — without a browser.
 */

import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";

/** The part of a Playwright `TestCase` this count needs, and nothing else. */
export interface CountedTest {
  /** The project the case belongs to. `""` when Playwright could not name one. */
  project: string;
  /** `titlePath().join(" › ")`, for naming a file in the banner. */
  title: string;
  outcome: "skipped" | "expected" | "unexpected" | "flaky";
  expectedStatus: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  results: readonly { status: string }[];
}

export interface DidNotRunReport {
  /** How many cases never executed. */
  didNotRun: number;
  /** How many cases produced a result of any kind. */
  executed: number;
  /** `project → cases that never executed`, in first-seen order. */
  byProject: ReadonlyMap<string, number>;
  /** Projects that had at least one unexpected failure — the reason the rest stopped. */
  redProjects: readonly string[];
  /** The banner, ready to print. */
  banner: string;
}

/**
 * Playwright's own rule, from `lib/runner/index.js` `generateSummary`: a case counts as "did
 * not run" when its outcome is `skipped`, it was not interrupted, and either it produced no
 * result at all or it was never *expected* to be skipped. A `test.skip(...)` case has a
 * result and `expectedStatus: "skipped"`, so it is not one of these.
 */
function neverExecuted(test: CountedTest): boolean {
  if (test.outcome !== "skipped") return false;
  if (test.results.some((result) => result.status === "interrupted")) return false;
  return test.results.length === 0 || test.expectedStatus !== "skipped";
}

const RULE = "═".repeat(78);

/**
 * `null` when every case ran. Otherwise the report, whose `banner` is what the reporter
 * prints and what a human reading a red gate is meant to be unable to skim past.
 */
export function didNotRunReport(tests: readonly CountedTest[]): DidNotRunReport | null {
  const missed = tests.filter(neverExecuted);
  if (missed.length === 0) return null;

  const byProject = new Map<string, number>();
  for (const test of missed) {
    byProject.set(test.project, (byProject.get(test.project) ?? 0) + 1);
  }
  const redProjects = [
    ...new Set(tests.filter((test) => test.outcome === "unexpected").map((test) => test.project)),
  ];
  const executed = tests.length - missed.length;

  const lines = [
    RULE,
    `  [G6-a] ${missed.length} of ${tests.length} e2e tests NEVER RAN.`,
    "",
    "  This is not a partial pass. Playwright stops a project when a project it",
    "  depends on goes red, so the tests below produced no measurement at all and",
    "  §13.5's e2e leg did not certify what it names: the fake-camera scan flows,",
    "  offline, import, the share fallbacks.",
    "",
    ...[...byProject].map(
      ([project, count]) =>
        `    ${project || "(no project)"} — ${count} test${count === 1 ? "" : "s"} did not run`,
    ),
    "",
    redProjects.length === 0
      ? "  No project reported a failure, so the skip came from the run being cut short" +
        " (--max-failures, an interrupt, or a dependency that could not start)."
      : `  Red dependency: ${redProjects.map((p) => p || "(no project)").join(", ")}.` +
        " Fix that, then run the leg again — a green light project is not a green gate.",
    `  ${executed} test${executed === 1 ? "" : "s"} did execute; that is the whole of this run's evidence.`,
    RULE,
  ];

  return { didNotRun: missed.length, executed, byProject, redProjects, banner: lines.join("\n") };
}

/** Flatten a reporter `Suite` into the shape `didNotRunReport` counts. */
export function countedTests(suite: Suite): CountedTest[] {
  return suite.allTests().map((test: TestCase) => ({
    project: test.parent.project()?.name ?? "",
    title: test
      .titlePath()
      .filter((part) => part !== "")
      .join(" › "),
    outcome: test.outcome(),
    expectedStatus: test.expectedStatus,
    results: test.results.map((result) => ({ status: result.status })),
  }));
}

export default class DidNotRunReporter implements Reporter {
  private suite: Suite | null = null;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  /** `async` because the interface's return type is a promise; nothing here awaits. */
  async onEnd(): Promise<{ status?: FullResult["status"] } | undefined> {
    await Promise.resolve();
    if (this.suite === null) return undefined;
    const report = didNotRunReport(countedTests(this.suite));
    if (report === null) return undefined;
    process.stdout.write(`\n${report.banner}\n\n`);
    return { status: "failed" };
  }

  /** The banner is the point; print it even under a quiet reporter set. */
  printsToStdio(): boolean {
    return true;
  }
}
