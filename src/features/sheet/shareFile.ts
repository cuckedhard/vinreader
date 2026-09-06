/**
 * The two files one record can leave this device as, and why they are not the same file.
 *
 * **Download JSON** writes to the user's own disk. Nothing inspects it on the way, so it
 * keeps §9-S3's `vin-relay-<vin>.json` and `application/json`.
 *
 * **Share** hands the file to another app through the browser process, and Chromium refuses
 * that exact file before any system sheet is drawn. `ShareServiceImpl.java` (Android) and
 * `chrome/browser/webshare/share_service_impl.cc` (desktop) each hold two allowlists,
 * published together in `third_party/blink/renderer/modules/webshare/FILE_TYPES.md`:
 * `PERMITTED_EXTENSIONS` contains no `json`, and the only `application/*` entry in
 * `PERMITTED_MIME_TYPES` is `application/pdf`. A file that fails either check is answered
 * with `ShareError.PERMISSION_DENIED`, which `navigator_share.cc` turns into a
 * `NotAllowedError` — so the *whole* share fails, text and all, on every tap. That is the
 * Android Chrome report this module exists for (SH-1).
 *
 * §4.9 says the readable text always goes and the record rides along as a file. That share
 * text is fixed line by line in §4.9 and carries no `VINRELAY1:` carrier, so the attached
 * file is the only way the whole record — notes, unit and paint code included — travels
 * with a share; text alone hands over a VIN the receiver has to decode again, and never the
 * fields a human typed. Sending the same bytes under an extension and a type the platform
 * will carry keeps §4.9's promise everywhere without changing one byte of what is sent.
 * Dropping the file instead would have kept it nowhere on Android.
 *
 * The bytes are `texts.json` in both cases: the file the receiver opens is the record, and
 * the import path reads a file by parsing it (`ImportScreen.readFile` calls `file.text()`
 * then `JSON.parse`) rather than by trusting its name or its type.
 *
 * Pure: no DOM, no I/O. `File` and `Blob` are built by the caller.
 */

/** One file leaving the device: what it is called, and what it says it is. */
export interface HandoffFile {
  readonly name: string;
  readonly type: string;
}

/** §9-S3's stem, in one place for both files. */
const STEM = "vin-relay-";

/** §9-S3: "Download JSON". The record, as itself, on the user's own disk. */
export function downloadFile(vin: string): HandoffFile {
  return { name: `${STEM}${vin}.json`, type: "application/json" };
}

/**
 * The same bytes, named and typed so the browser process will carry them: `txt` is in
 * `PERMITTED_EXTENSIONS` and `text/plain` is in `PERMITTED_MIME_TYPES` (FILE_TYPES.md,
 * "# Text"). Both lists are checked, so both halves have to be right.
 */
export function sharedFile(vin: string): HandoffFile {
  return { name: `${STEM}${vin}.txt`, type: "text/plain" };
}
