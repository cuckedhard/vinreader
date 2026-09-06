/**
 * SH-1. The file Share attaches has to be one the browser will actually carry.
 *
 * The rule below is not this app's: it is Chromium's, copied verbatim from
 * `components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/ShareServiceImpl.java`
 * (`PERMITTED_EXTENSIONS`, `PERMITTED_MIME_TYPES`, `isDangerousFilename`,
 * `isDangerousMimeType`), which the desktop `share_service_impl.cc` duplicates and
 * `third_party/blink/renderer/modules/webshare/FILE_TYPES.md` documents. It lives here, in
 * the test, because it is a fact about the platform rather than a policy of ours — and
 * because a fixture is what lets this file say "Chromium refuses that" about the file the
 * app used to send, in the browser's own terms.
 *
 * What the app was sending — `vin-relay-<vin>.json`, `application/json` — fails both halves
 * of it, which is `ShareError.PERMISSION_DENIED` before any system sheet is drawn and a
 * `NotAllowedError` in the page: the Android Chrome report.
 */
import { describe, expect, it } from "vitest";
import { downloadFile, sharedFile, type HandoffFile } from "./shareFile";

/** §4.11's fixture VIN. */
const VIN = "1HGCM82633A004352";

const PERMITTED_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "css",
  "csv",
  "ehtml",
  "flac",
  "gif",
  "htm",
  "html",
  "ico",
  "jfif",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mp3",
  "mp4",
  "mpeg",
  "mpg",
  "oga",
  "ogg",
  "ogm",
  "ogv",
  "opus",
  "pdf",
  "pjp",
  "pjpeg",
  "png",
  "shtm",
  "shtml",
  "svg",
  "svgz",
  "text",
  "tif",
  "tiff",
  "txt",
  "wav",
  "weba",
  "webm",
  "webp",
  "xbm",
]);

const PERMITTED_MIME_TYPES = new Set([
  "audio/flac",
  "application/pdf",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/x-icon",
  "image/x-ms-bmp",
  "image/x-xbitmap",
  "text/comma-separated-values",
  "text/css",
  "text/csv",
  "text/html",
  "text/plain",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/webm",
]);

/** `ShareServiceImpl.isDangerousFilename`, step for step. */
function isDangerousFilename(name: string): boolean {
  if (name === "") return true;
  if (name.includes("..") || name === ".") return true;
  if (name.includes("/") || name.includes("\\")) return true;
  const trimmed = name.trim();
  if (name !== trimmed || trimmed.endsWith(".")) return true;
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return true;
  // `FileUtils.getExtension` lowercases (Locale.US) before the set lookup.
  return !PERMITTED_EXTENSIONS.has(trimmed.slice(dot + 1).toLowerCase());
}

/** `ShareServiceImpl.isDangerousMimeType`. */
function isDangerousMimeType(type: string): boolean {
  return !PERMITTED_MIME_TYPES.has(type);
}

/** The whole of the browser-process check: either half refuses the share. */
function chromiumRefuses(file: HandoffFile): boolean {
  return isDangerousFilename(file.name) || isDangerousMimeType(file.type);
}

describe("SH-1: the file Web Share attaches", () => {
  it("is one Chromium will carry, by both of its checks", () => {
    expect(chromiumRefuses(sharedFile(VIN))).toBe(false);
  });

  it("is the record itself, named for the VIN it holds", () => {
    expect(sharedFile(VIN)).toEqual({ name: `vin-relay-${VIN}.txt`, type: "text/plain" });
  });

  it("was refused as `.json`, which is the reported failure", () => {
    // Not a hypothetical: this is exactly what `share()` built until SH-1.
    expect(chromiumRefuses({ name: `vin-relay-${VIN}.json`, type: "application/json" })).toBe(true);
    // And both halves refuse it on their own, so fixing one would not have been enough.
    expect(isDangerousFilename(`vin-relay-${VIN}.json`)).toBe(true);
    expect(isDangerousMimeType("application/json")).toBe(true);
  });
});

describe("SH-1: the file Download JSON writes", () => {
  it("stays §9-S3's `.json`, because nothing inspects a local download", () => {
    expect(downloadFile(VIN)).toEqual({
      name: `vin-relay-${VIN}.json`,
      type: "application/json",
    });
  });

  it("differs from the shared file only in its container", () => {
    // The bytes are the same string in both paths (`texts.json`); this is the whole of the
    // difference, and it is the reason Share stopped failing.
    expect(downloadFile(VIN).name.replace(/\.json$/, "")).toBe(
      sharedFile(VIN).name.replace(/\.txt$/, ""),
    );
  });
});

describe("the fixture is Chromium's rule and not a paraphrase", () => {
  it("refuses what Chromium refuses, and permits what it permits", () => {
    expect(chromiumRefuses({ name: "x.pdf", type: "application/pdf" })).toBe(false);
    expect(chromiumRefuses({ name: "x.png", type: "image/png" })).toBe(false);
    // An extension it permits, carrying a type it does not, and the other way round.
    expect(chromiumRefuses({ name: "x.txt", type: "application/json" })).toBe(true);
    expect(chromiumRefuses({ name: "x.json", type: "text/plain" })).toBe(true);
    // The `SafeBaseName` guards, which a VIN-stemmed name can never trip but the rule keeps.
    expect(chromiumRefuses({ name: "../x.txt", type: "text/plain" })).toBe(true);
    expect(chromiumRefuses({ name: "a/x.txt", type: "text/plain" })).toBe(true);
    expect(chromiumRefuses({ name: " x.txt", type: "text/plain" })).toBe(true);
    expect(chromiumRefuses({ name: "x.txt.", type: "text/plain" })).toBe(true);
    expect(chromiumRefuses({ name: ".txt", type: "text/plain" })).toBe(true);
    expect(chromiumRefuses({ name: "", type: "text/plain" })).toBe(true);
    expect(chromiumRefuses({ name: "txt", type: "text/plain" })).toBe(true);
  });
});
