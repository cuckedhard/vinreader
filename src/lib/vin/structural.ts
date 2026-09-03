/**
 * §5.1 `structural`: the block every record carries, derived from the 17 characters
 * alone and therefore always available offline (N1, P2). Pure (P3): the current year
 * is an argument, never a clock read.
 */
import { isCheckDigitValid } from "./checkDigit";
import { modelYearFromVin } from "./modelYear";
import type { VinStructural } from "./types";
import { countryFromVin, manufacturerFromWmi, regionFromVin, wmiFromVin } from "./wmi";

export function buildStructural(vin: string, currentYear: number): VinStructural {
  const wmi = wmiFromVin(vin);
  return {
    wmi,
    vds: vin.slice(3, 8),
    checkDigit: vin.slice(8, 9),
    checkDigitValid: isCheckDigitValid(vin),
    yearCode: vin.slice(9, 10),
    modelYear: modelYearFromVin(vin, currentYear),
    plantCode: vin.slice(10, 11),
    serial: vin.slice(11, 17),
    region: regionFromVin(vin),
    country: countryFromVin(vin),
    manufacturerFromWmi: manufacturerFromWmi(wmi),
  };
}
