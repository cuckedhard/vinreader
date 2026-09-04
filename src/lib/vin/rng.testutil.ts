/**
 * The one seeded generator the §13.2 fixed-seed measurements in `src/lib/vin` are allowed
 * to use. Not a test file — the name deliberately misses `vitest.config.ts`'s
 * `src/**\/*.test.ts` include so vitest does not collect it as an empty suite.
 *
 * WHY THIS FILE EXISTS (ledger R4-B). The measurements in `extractVin.straddle.test.ts`
 * and `extractVin.adversary.test.ts` used to carry a hand-rolled LCG:
 *
 *     seed = (seed * 1103515245 + 12345) & 0x7fffffff
 *
 * `0x7fffffff * 1103515245` is about 2.4e18, two and a half orders of magnitude past the
 * 2^53 where IEEE-754 doubles stop being exact, so the multiply silently loses the low
 * bits and the recurrence is not the LCG it is written as. Measured from every seed the
 * suite actually uses (20260904, 12345, 0x2c6b, 0x5aff): each one runs a tail of
 * 3,079-6,241 states and then falls into a cycle of **period 10,466**, so it can only ever
 * emit 13,545-16,707 distinct values however long it is run. At roughly 22 draws per trial
 * a test claiming 3,000 trials was drawing from 708 distinct payloads, and a residue
 * reported as 13 fabrications was 2 distinct payloads counted six times each. The rates
 * were ratios, so they were not nonsense, but every sample size in the ledger was about 4x
 * smaller than it read and every interval about twice as wide.
 *
 * WHY MULBERRY32, AND WHY COPIED. `bench/corpus.ts` and `bench/degrade.ts` already use
 * mulberry32 for exactly this job, so the repo gets one generator rather than two (§7
 * item 5): it is `Math.imul`-based, every intermediate stays inside int32, and nothing
 * depends on double precision. Its state is `a += 0x6d2b79f5 (mod 2^32)` with an odd
 * increment, so the state period is exactly 2^32 = 4,294,967,296 from any seed — verified
 * here as no state repeat in 1e6 steps and 499,923 distinct outputs in 500,000 draws from
 * seed 20260904.
 *
 * It is copied out of `bench/corpus.ts` rather than imported because nothing under `src/`
 * imports `bench/`: doing so would pull the bench's node-only build scope into the app's
 * module graph and into the §13.5 coverage include. `bench/corpus.ts` carries the same
 * note in the other direction. If one copy is ever changed, change both — a recorded
 * measurement is only reproducible while the stream is.
 *
 * `[R4-B]` in `extractVin.straddle.test.ts` asserts the non-degeneracy this file claims,
 * from each of the four seeds in use. That is the assertion the old generator would have
 * failed, and it is why it is a test rather than a comment.
 */

/** mulberry32, byte-for-byte the generator in `bench/corpus.ts`. Pure (P3). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded stream that remembers how many distinct values it handed out, so a measurement
 * can assert a floor on its own effective sample rather than trusting its trial count.
 * `distinct()` is the direct form of the R4-B defect: under the broken LCG it saturated at
 * 13,545-16,707 (seed-dependent) and stayed there however many draws were taken.
 */
export function countingRandom(seed: number): { next: () => number; distinct: () => number } {
  const rand = mulberry32(seed);
  const seen = new Set<number>();
  return {
    next: () => {
      const value = rand();
      seen.add(value);
      return value;
    },
    distinct: () => seen.size,
  };
}
