/**
 * §4.9 handoff payload schema and the S3 export bundle schema, both as zod.
 * Pure: no DOM, no React, no I/O, no clock (P3).
 *
 * Shape only. `codec.ts` owns the version check, so `payloadSchema` never sees a
 * payload from another version and can pin `v` to a literal.
 */

import { z } from "zod";

import { VIN_RE } from "../vin/grammar";
import type { VehicleRecord } from "../vin/types";

/** §4.9 payload codec version. `codec.ts` re-exports it as `PAYLOAD_VERSION`. */
export const PAYLOAD_VERSION = 1;

/** §4.9. Everything except `v` and `vin` is optional; an empty string is legal. */
export interface Payload {
  v: number;
  vin: string;
  y?: string;
  mk?: string;
  md?: string;
  tr?: string;
  bc?: string;
  en?: string;
  fu?: string;
  dr?: string;
  gv?: string;
  at?: string;
  u?: string;
  n?: string;
  by?: string;
}

/** §S3 History → Export all. */
export interface ExportBundle {
  app: "vin-relay";
  v: 1;
  exportedAt: string;
  vehicles: VehicleRecord[];
}

/**
 * §5.1 timestamps are ISO 8601 **with an offset** (`nowIso`), and `Z` is an offset.
 * A payload's `at` comes from another device, so it is checked rather than trusted:
 * §4.12 compares timestamps by `Date.parse`, and an unparseable one poisons that.
 */
const isoDateTime = z.iso.datetime({ offset: true });

const summary = z.string();

/**
 * A carrier that survives transit but names something other than a VIN must not become
 * a record: §5.3 keys every record by its VIN, so the grammar (§4.1) is the gate.
 */
const vin = z.string().regex(VIN_RE, "not a VIN (§4.1: 17 characters, no I, O or Q)");

export const payloadSchema: z.ZodType<Payload> = z.object({
  v: z.literal(PAYLOAD_VERSION),
  vin,
  y: summary.optional(),
  mk: summary.optional(),
  md: summary.optional(),
  tr: summary.optional(),
  bc: summary.optional(),
  en: summary.optional(),
  fu: summary.optional(),
  dr: summary.optional(),
  gv: summary.optional(),
  at: isoDateTime.optional(),
  u: summary.optional(),
  n: summary.optional(),
  by: summary.optional(),
});

/** §4.10, locked. Copied verbatim; never re-derived. */
const REGIONS = ["Africa", "Asia", "Europe", "North America", "Oceania", "South America"] as const;

/** §4.10, locked. */
const DECODE_STATUSES = ["pending", "ok", "partial", "unsupported", "failed"] as const;

/** §5.1 `origin`. `cloud` is written only by the S4 pull path (D12) but is a legal value. */
const ORIGINS = ["scan", "manual", "import", "cloud"] as const;

const modelYearSchema = z.object({
  candidates: z.array(z.number().int()),
  resolved: z.number().int().nullable(),
});

const structuralSchema = z.object({
  wmi: z.string(),
  vds: z.string(),
  checkDigit: z.string(),
  checkDigitValid: z.boolean(),
  yearCode: z.string(),
  modelYear: modelYearSchema,
  plantCode: z.string(),
  serial: z.string(),
  region: z.enum(REGIONS).nullable(),
  country: z.string().nullable(),
  manufacturerFromWmi: z.string().nullable(),
});

const decodeSchema = z.object({
  status: z.enum(DECODE_STATUSES),
  source: z.literal("nhtsa_vpic"),
  fetchedAt: isoDateTime.nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  fields: z.record(z.string(), z.string()),
});

/**
 * §5.1. Exported for the import screen, which accepts a single `.json` record as well
 * as a bundle. `structural` is revalidated rather than trusted, but the upsert
 * recomputes it from the 17 characters anyway, so a stale block heals itself.
 */
export const vehicleRecordSchema: z.ZodType<VehicleRecord> = z.object({
  vin,
  structural: structuralSchema,
  decode: decodeSchema,
  unit: z.string().nullable(),
  notes: z.string().nullable(),
  firstScannedAt: isoDateTime,
  lastScannedAt: isoDateTime,
  scanCount: z.number().int(),
  origin: z.enum(ORIGINS),
  metaUpdatedAt: isoDateTime,
  deletedAt: isoDateTime.nullable(),
});

export const exportBundleSchema: z.ZodType<ExportBundle> = z.object({
  app: z.literal("vin-relay"),
  v: z.literal(1),
  exportedAt: isoDateTime,
  vehicles: z.array(vehicleRecordSchema),
});
