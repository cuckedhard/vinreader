/**
 * §9-S2 definition of done: verify every §4.8 key against a live `DecodeVinValues` call on the
 * §4.11 fixture VIN. This build environment refuses `vpic.nhtsa.dot.gov:443` (D09), so the check
 * runs on a machine that can reach vPIC:
 *
 *   bun run scripts/verify-vpic-fields.ts [VIN]
 *
 * It only reports. The §4.8 map is authoritative (P2): a key that comes back absent is a §4
 * change for Zach to make, never a silent "fix" by this script or by an agent.
 */

import { MAPPED_KEYS } from "../src/lib/vpic/fields";

/** `@types/node` is not in the locked stack (§2); these are the only Node globals used here. */
declare const process: { argv: readonly string[]; exitCode: number | undefined };

const ENDPOINT = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";

/** §4.11 fixture VIN: vPIC is expected to answer HONDA / Accord / 2003. */
const FIXTURE_VIN = "1HGCM82633A004352";

/** The script's own patience, not the §4.7 client budget of 10 s. */
const TIMEOUT_MS = 15_000;

type Row = Record<string, unknown>;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every failure path prints a plain line and exits non-zero — no stack trace. */
function fail(message: string): null {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  return null;
}

function firstRow(payload: unknown): Row | null {
  if (typeof payload !== "object" || payload === null) {
    return fail("response was not a JSON object");
  }
  const results = (payload as { Results?: unknown }).Results;
  if (!Array.isArray(results) || results.length === 0) {
    return fail("response carried no Results row");
  }
  const row: unknown = results[0];
  if (typeof row !== "object" || row === null) {
    return fail("Results[0] was not an object");
  }
  return row as Row;
}

async function fetchRow(vin: string): Promise<Row | null> {
  const url = `${ENDPOINT}/${vin}?format=json`;
  console.log(`GET ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return fail(`request failed or timed out after ${TIMEOUT_MS} ms (${reason(error)})`);
  }

  if (!response.ok) {
    return fail(`HTTP ${response.status} ${response.statusText}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return fail(`malformed JSON (${reason(error)})`);
  }

  return firstRow(payload);
}

/** vPIC returns every field as a string; empty means unknown (§4.7). */
function value(row: Row, key: string): string {
  const raw = row[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function list(title: string, keys: readonly string[]): void {
  console.log(`\n${title} (${keys.length})`);
  if (keys.length === 0) {
    console.log("  none");
    return;
  }
  for (const key of keys) console.log(`  ${key}`);
}

async function main(): Promise<void> {
  const vin = process.argv[2] ?? FIXTURE_VIN;
  console.log(`Verifying the §4.8 display map against vPIC for ${vin}\n`);

  const row = await fetchRow(vin);
  if (row === null) return;

  const present = new Set(Object.keys(row));
  const absent = MAPPED_KEYS.filter((key) => !present.has(key));
  const populated = MAPPED_KEYS.filter((key) => present.has(key) && value(row, key) !== "");
  const unmapped = Object.keys(row)
    .filter((key) => !MAPPED_KEYS.includes(key) && value(row, key) !== "")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  list("MAPPED BUT ABSENT from the response — the map may name these wrongly", absent);
  list("PRESENT AND POPULATED but not mapped — candidates the map may be missing", unmapped);

  console.log(`\nMAPPED AND POPULATED (${populated.length} of ${MAPPED_KEYS.length})`);
  if (populated.length === 0) {
    console.log("  none");
  } else {
    for (const key of populated) console.log(`  ${key} = ${value(row, key)}`);
  }

  console.log("\n§4.11 expectation for 1HGCM82633A004352 — HONDA / Accord / 2003:");
  for (const key of ["Make", "Model", "ModelYear"]) {
    const shown = value(row, key);
    console.log(`  ${key} = ${shown === "" ? "(empty)" : shown}`);
  }

  console.log(
    "\nA key listed as absent is a §4.8 correction. §4 constants are authoritative: report it" +
      "\nto Zach in the session report. This script never edits the map, and neither does an agent.",
  );

  if (absent.length > 0) {
    console.error(`\nFAIL: ${absent.length} mapped key(s) absent from the live response.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK: every mapped key exists in the live response.");
}

// `export {}` makes this a module, which is what top-level `await` needs.
export {};

await main();
