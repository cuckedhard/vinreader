/**
 * §4.5 WMI → manufacturer seed. Calls vPIC `DecodeWMI` once per candidate and writes
 * `src/lib/vin/wmi-seed.json` sorted by WMI; candidates that do not resolve to a
 * non-empty manufacturer are dropped. The committed JSON is the artifact — never
 * hand-type it, regenerate with `bun run seed:wmi`.
 *
 * The build environment refuses `vpic.nhtsa.dot.gov:443` (D09), so this runs on a
 * machine that can reach vPIC and the output is committed from there.
 */

/** `bun-types` is not in the locked stack (§2); this is the only Bun API used here. */
declare const Bun: { write(path: string, input: string): Promise<number> };

const OUT_PATH = "src/lib/vin/wmi-seed.json";
const ENDPOINT = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeWMI";
const SPACING_MS = 200;
const TIMEOUT_MS = 15_000;

/** §4.5 starting candidate list. An unresolved candidate costs one call, so it is broad. */
const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  "Heavy truck and chassis": [
    "1FU",
    "1FV",
    "1XK",
    "1XP",
    "1M1",
    "1HT",
    "4V4",
    "1NK",
    "2NK",
    "3AK",
    "5KJ",
  ],
  "Pickup and van": [
    "1FT",
    "1FD",
    "1FM",
    "1GC",
    "1GB",
    "1GT",
    "1GK",
    "3GC",
    "1C6",
    "1C4",
    "3C6",
    "1N6",
    "5TF",
    "1GD",
    "3GT",
    "5FN",
  ],
  "Passenger car": [
    "1HG",
    "2HG",
    "JHM",
    "1G1",
    "1G6",
    "3G1",
    "1FA",
    "3FA",
    "2T1",
    "4T1",
    "5TD",
    "JTD",
    "1N4",
    "3N1",
    "JN1",
    "JN8",
    "1J4",
    "2C3",
    "1C3",
    "1LN",
    "1ME",
  ],
  "Import and European": [
    "WDB",
    "WDD",
    "WDC",
    "4JG",
    "WVW",
    "3VW",
    "1VW",
    "WV1",
    "WBA",
    "WBS",
    "5UX",
    "WAU",
    "TRU",
    "WP0",
    "YV1",
    "YV4",
    "JTE",
    "JF1",
    "JF2",
    "4S3",
    "4S4",
    "KMH",
    "KM8",
    "KNA",
    "KND",
    "5YJ",
  ],
  "Motorcycle and trailer": ["1HD", "JH2", "JYA", "JKA", "1UY", "5PV"],
};

/** The manufacturer's field name differs between vPIC endpoints; take the first non-empty. */
const MANUFACTURER_FIELDS = ["Manufacturer", "ManufacturerName", "CommonName"] as const;

interface SeedEntry {
  manufacturer: string;
  make?: string;
}

type Row = Record<string, unknown>;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstRow(payload: unknown): Row | null {
  if (typeof payload !== "object" || payload === null) return null;
  const results = (payload as { Results?: unknown }).Results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const row: unknown = results[0];
  return typeof row === "object" && row !== null ? (row as Row) : null;
}

function stringField(row: Row, field: string): string | null {
  const value = row[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function decodeWmi(wmi: string): Promise<{ entry: SeedEntry; field: string } | null> {
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${wmi}?format=json`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    console.warn(`  ${wmi}: dropped — request failed (${reason(error)})`);
    return null;
  }

  if (!response.ok) {
    console.warn(`  ${wmi}: dropped — HTTP ${response.status} ${response.statusText}`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn(`  ${wmi}: dropped — malformed JSON (${reason(error)})`);
    return null;
  }

  const row = firstRow(payload);
  if (row === null) {
    console.warn(`  ${wmi}: dropped — no Results row`);
    return null;
  }

  for (const field of MANUFACTURER_FIELDS) {
    const manufacturer = stringField(row, field);
    if (manufacturer === null) continue;
    // `CommonName` is the short marque ("FORD") next to a long legal name; keep it as
    // `make` only when it adds something the manufacturer string does not already say.
    const common = stringField(row, "CommonName");
    const entry: SeedEntry =
      common !== null && common !== manufacturer
        ? { manufacturer, make: common }
        : { manufacturer };
    return { entry, field };
  }

  console.warn(`  ${wmi}: dropped — no ${MANUFACTURER_FIELDS.join(" / ")}`);
  return null;
}

async function main(): Promise<void> {
  const seed: Record<string, SeedEntry> = {};
  const dropped: string[] = [];
  const fieldCounts = new Map<string, number>();
  let firstRequest = true;

  for (const [className, wmis] of Object.entries(CANDIDATES)) {
    console.log(`\n${className} (${wmis.length})`);
    for (const wmi of wmis) {
      if (!firstRequest) await sleep(SPACING_MS);
      firstRequest = false;

      const result = await decodeWmi(wmi);
      if (result === null) {
        dropped.push(`${wmi} (${className})`);
        continue;
      }

      seed[wmi] = result.entry;
      fieldCounts.set(result.field, (fieldCounts.get(result.field) ?? 0) + 1);
      const make = result.entry.make === undefined ? "" : ` / ${result.entry.make}`;
      console.log(`  ${wmi}: ${result.entry.manufacturer}${make} [${result.field}]`);
    }
  }

  const sorted = Object.fromEntries(Object.entries(seed).sort(([a], [b]) => a.localeCompare(b)));
  await Bun.write(OUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

  const total = Object.keys(CANDIDATES).reduce((n, key) => n + CANDIDATES[key].length, 0);
  console.log(`\nResolved ${Object.keys(sorted).length} of ${total} → ${OUT_PATH}`);
  for (const field of MANUFACTURER_FIELDS) {
    const count = fieldCounts.get(field) ?? 0;
    if (count > 0) console.log(`  manufacturer taken from ${field}: ${count}`);
  }
  console.log(
    dropped.length === 0 ? "Dropped none" : `Dropped ${dropped.length}: ${dropped.join(", ")}`,
  );
}

// `export {}` makes this a module, which is what top-level `await` needs.
export {};

await main();
