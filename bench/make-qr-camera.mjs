/**
 * Render a QR of a §4.9 payload URL as a y4m for Chromium's fake camera, so the
 * phone-to-phone handoff ("show QR, scan QR") can be driven end to end.
 * Usage: node bench/make-qr-camera.mjs "<text>" [out.y4m]
 */
import { writeFileSync } from "node:fs";
import QRCode from "qrcode";

const text = process.argv[2];
const out = process.argv[3] ?? "bench/fake-qr.y4m";
if (!text) throw new Error("usage: make-qr-camera.mjs <text> [out]");

const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
const size = qr.modules.size;
const data = qr.modules.data;

const W = 1280;
const H = 720;
const QUIET = 4;
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

const chroma = Buffer.alloc((W / 2) * (H / 2), 0x80);
const frames = 8;
const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`)];
for (let i = 0; i < frames; i += 1) parts.push(Buffer.from("FRAME\n"), luma, chroma, chroma);
writeFileSync(out, Buffer.concat(parts));
console.log(`wrote ${out}: QR ${size}x${size} modules at scale ${scale}, ${text.length} chars`);
