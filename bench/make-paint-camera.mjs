/**
 * Render a synthetic certification label as a y4m for Chromium's fake camera, so S5's
 * paint-code capture mode can be driven end to end: crop box, preprocessing worker,
 * tesseract, vote, proposal.
 *
 * The label is deliberately the hard case S5 addendum §5 describes. A door-jamb sticker is
 * dense with tyre pressures, GVWR figures and dates, and the finding that shapes the whole
 * feature is that **no cross-manufacturer pattern can tell a paint code from those
 * neighbours** — so the aimed line here carries the code *and* another token, and the rows
 * above and below carry the tokens the crop box is supposed to exclude. A test that only
 * ever showed one clean word on an empty field would prove nothing about either.
 *
 * Synthetic, and it stays synthetic: §13.7 says there is no corpus of real stickers, so
 * this proves the pipeline runs, never that a scuffed label in a snowy door jamb reads.
 *
 * Usage: node bench/make-paint-camera.mjs [out.y4m]
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const out = process.argv[2] ?? "bench/fake-paint.y4m";
const W = 1280;
const H = 720;

/**
 * The aimed line sits at the centre of the frame, in both axes, because the crop box is
 * centred in the preview and a fake camera cannot be re-aimed. The other rows sit far
 * enough away that a correctly mapped crop cannot reach them: at 390x844 the box is 48 px
 * of a 268 px preview over a 720-line frame, which is about 129 frame rows, so the crop is
 * y 296-424 and x 217-1062. The aimed row's ink lands at y 329-391 and its text at
 * x 390-890; every other row is outside that band by at least 60 rows.
 */
const ROWS = [
  { y: 150, size: 52, text: "GVWR 2722 KG (6000 LB)" },
  { y: 230, size: 52, text: "TIRE 235/65R17 PSI 240 KPA" },
  { y: 391, size: 84, text: "PNT WA8555", middle: true },
  { y: 520, size: 52, text: "DATE 0925 GAWR FRT 1202 KG" },
  { y: 600, size: 52, text: "TYPE TRUCK MFD BY EXAMPLE" },
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#d8d8d8"/>
  <rect x="120" y="60" width="1040" height="600" fill="#ffffff" stroke="#000000" stroke-width="4"/>
  ${ROWS.map(
    (row) =>
      `<text x="${row.middle ? W / 2 : 180}" y="${row.y}"${row.middle ? ' text-anchor="middle"' : ""} font-family="DejaVu Sans Mono, monospace" font-size="${row.size}" fill="#101010">${row.text}</text>`,
  ).join("\n  ")}
</svg>`;

const luma = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
if (luma.length !== W * H) throw new Error(`rendered ${luma.length} bytes, expected ${W * H}`);

const chroma = Buffer.alloc((W / 2) * (H / 2), 0x80);
const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`)];
for (let frame = 0; frame < 8; frame += 1) {
  parts.push(Buffer.from("FRAME\n"), luma, chroma, chroma);
}
writeFileSync(out, Buffer.concat(parts));
console.log(`wrote ${out}: a ${W}x${H} label, paint code on the centre line`);
