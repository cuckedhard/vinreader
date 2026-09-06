import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";

/**
 * A fake-camera video of QR codes, for the specs that drive §9-S3's phone-to-phone path.
 *
 * The same y4m shape `bench/make-qr-camera.mjs` writes, built at run time so nothing under
 * `bench/` is clobbered. Segments run in order and Chromium loops the file, which is how one
 * video can hold a code the app refuses followed by one it reads (§7 item 5: one definition,
 * imported by both carrier specs).
 */
const W = 1280;
const H = 720;
const QUIET = 4;

/** One QR, drawn as a full luma plane. */
function lumaOf(text: string): Buffer {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const scale = Math.floor(Math.min(W, H) / (size + QUIET * 2));
  const side = (size + QUIET * 2) * scale;
  const x0 = Math.floor((W - side) / 2);
  const y0 = Math.floor((H - side) / 2);
  const luma = Buffer.alloc(W * H, 0xff);
  for (let my = 0; my < size; my += 1) {
    for (let mx = 0; mx < size; mx += 1) {
      if (!data[my * size + mx]) continue;
      const px = x0 + (mx + QUIET) * scale;
      const py = y0 + (my + QUIET) * scale;
      for (let y = py; y < py + scale; y += 1) luma.fill(0x00, y * W + px, y * W + px + scale);
    }
  }
  return luma;
}

export function writeQrY4m(
  name: string,
  segments: readonly (readonly [string, number])[],
): string {
  const chroma = Buffer.alloc((W / 2) * (H / 2), 0x80);
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`)];
  for (const [text, frames] of segments) {
    const luma = lumaOf(text);
    for (let i = 0; i < frames; i += 1) parts.push(Buffer.from("FRAME\n"), luma, chroma, chroma);
  }
  const out = join(mkdtempSync(join(tmpdir(), `vinrelay-${name}-`)), `${name}.y4m`);
  writeFileSync(out, Buffer.concat(parts));
  return out;
}
