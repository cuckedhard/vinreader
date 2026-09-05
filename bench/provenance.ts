/**
 * §13.4 bench — where a recorded measurement came from (SB-5 / SB-11).
 *
 * A number in `bench/report.md` that this run did not take is a **quote**, and a quote is
 * only worth something if a reader can tell whether it still describes the program. The
 * bench's own configuration is checked in `run.ts`; this module covers the other half — the
 * source tree the measurement was taken against.
 *
 * Both facts are recorded rather than described: the commit the probe ran at, and whether
 * the tree was dirty at the time (a dirty tree means the commit does not identify what was
 * measured, which is worth saying out loud rather than hiding). `run.ts` then asks git how
 * many commits have touched `src/` since, and prints the answer beside the quote.
 *
 * Everything degrades to `null` rather than throwing: git may not exist, the bench may be
 * running from a tarball, and a missing provenance line must never take a bench run down.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The tree a recorded measurement was taken against. `null` where git could not say. */
export interface Provenance {
  /** Full commit sha, or `null` if git was unavailable or this is not a repository. */
  commit: string | null;
  /** Whether the working tree carried uncommitted changes. `null` where unknown. */
  dirty: boolean | null;
}

function git(args: readonly string[], cwd: string = REPO): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read a tree's provenance. Cheap, and never throws.
 *
 * `cwd` is a parameter because the tree that was *measured* is not always the tree the bench
 * is running in: `confirm-probe` can be pointed at a build made from a clean checkout of a
 * commit while the working repository is mid-edit, and the recording has to describe the
 * build (SB-5).
 */
export function gitProvenance(cwd: string = REPO): Provenance {
  const commit = git(["rev-parse", "HEAD"], cwd);
  const status = git(["status", "--porcelain"], cwd);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

/**
 * How many commits have touched `paths` since `commit` — the question that decides whether a
 * recorded measurement of the app still describes the app. `null` when git cannot answer,
 * including when the recorded commit is not in this repository's history.
 */
export function commitsTouchingSince(commit: string, paths: readonly string[]): number | null {
  const count = git(["rev-list", "--count", `${commit}..HEAD`, "--", ...paths]);
  if (count === null) return null;
  const parsed = Number.parseInt(count, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Short sha for a report table, without pretending git said more than it did. */
export function shortSha(commit: string | null): string {
  return commit === null ? "unknown" : commit.slice(0, 7);
}
