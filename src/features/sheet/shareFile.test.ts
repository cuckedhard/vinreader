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
import {
  downloadFile,
  isShareableFile,
  shareData,
  sharedFile,
  SHAREABLE_FILE_TYPES,
  type HandoffFile,
} from "./shareFile";

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

/**
 * SH-2. The guard that was written to keep an unacceptable file out of a share could not
 * detect one: `navigator.canShare({ files })` runs `CanShareInternal`, which tests only that
 * some known field is present and that any `url` parses — no MIME test, no extension test,
 * nothing that could ever have answered "will this browser accept *this* file". It said yes
 * to the `application/json` file the browser process then refused.
 *
 * `isShareableFile` is the question `canShare` was being asked, and this is where it is
 * pinned: every pair the app is allowed to send is put through the Chromium fixture above,
 * so a second entry cannot be added without showing that Chromium permits it.
 */
describe("SH-2: the allowlist that answers what canShare cannot", () => {
  it("holds only pairs Chromium permits, by its own two checks", () => {
    expect(SHAREABLE_FILE_TYPES.size).toBeGreaterThan(0);
    for (const [extension, type] of SHAREABLE_FILE_TYPES) {
      expect(chromiumRefuses({ name: `vin-relay-${VIN}.${extension}`, type })).toBe(false);
    }
  });

  it("admits the file Share builds", () => {
    expect(isShareableFile(sharedFile(VIN))).toBe(true);
  });

  it("refuses the file Share used to build, which canShare answered `true` for", () => {
    expect(isShareableFile(downloadFile(VIN))).toBe(false);
  });

  it("checks the name and the type separately, because Chromium does", () => {
    // A permitted extension carrying an unpermitted type, and the other way round: either
    // one on its own is `PERMISSION_DENIED`.
    expect(isShareableFile({ name: "vin-relay-x.txt", type: "application/json" })).toBe(false);
    expect(isShareableFile({ name: "vin-relay-x.json", type: "text/plain" })).toBe(false);
    // A type Chromium permits, under an extension this app does not send.
    expect(isShareableFile({ name: "vin-relay-x.csv", type: "text/csv" })).toBe(false);
    // No extension at all is `dotIndex <= 0` in `isDangerousFilename`.
    expect(isShareableFile({ name: "vin-relay-x", type: "text/plain" })).toBe(false);
    expect(isShareableFile({ name: ".txt", type: "text/plain" })).toBe(false);
  });

  it("reads the File as the platform will, not as it was asked for", () => {
    // `new File([...], name, { type })` lowercases the type on the way in, and a name can
    // reach this from anywhere; both are compared case-insensitively rather than trusted.
    expect(isShareableFile({ name: `vin-relay-${VIN}.TXT`, type: "TEXT/PLAIN" })).toBe(true);
  });
});

describe("SH-2: what goes to navigator.share", () => {
  const summary = "2003 HONDA Accord";
  const txt = () => new File(["{}"], `vin-relay-${VIN}.txt`, { type: "text/plain" });
  const json = () => new File(["{}"], `vin-relay-${VIN}.json`, { type: "application/json" });

  it("attaches the record when both questions answer yes", () => {
    const file = txt();
    expect(shareData(summary, file, true)).toEqual({ text: summary, files: [file] });
  });

  it("drops a file the platform would refuse rather than losing the whole share", () => {
    // `canShare` said yes — it says yes to everything — and this is the file Chromium
    // answers with PERMISSION_DENIED. Before SH-2 it was attached anyway and the share
    // failed entirely; now the text goes without it.
    expect(shareData(summary, json(), true)).toEqual({ text: summary });
  });

  it("obeys the one thing canShare does report", () => {
    expect(shareData(summary, txt(), false)).toEqual({ text: summary });
  });

  it("never drops the text, whatever happens to the file (§4.9)", () => {
    for (const data of [
      shareData(summary, txt(), true),
      shareData(summary, json(), true),
      shareData(summary, txt(), false),
    ]) {
      expect(data.text).toBe(summary);
    }
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
