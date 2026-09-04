/**
 * §13.4 scan-robustness bench — degradation tiers.
 *
 * Simulates what a door-jamb label looks like through a phone camera in the field, so the
 * bench can measure decode rate per symbology × tier (§13.6 thresholds: ≥99% clean, ≥90%
 * moderate, ≥70% severe) and, above all, false accepts.
 *
 * Determinism (the bench is a gate, so a flaky number is worse than no number):
 * `degrade(png, tier, seed)` is a pure function of its arguments. Every random choice —
 * rotation angle, warp amount, glare band placement, noise field, JPEG quality — comes from
 * a seeded PRNG keyed by `(seed, purpose)`. There is no `Math.random`, no clock read, and no
 * ambient state. sharp's own operations (rotate, resize, blur, JPEG/PNG codecs) are
 * deterministic for a given input, and no metadata is written, so the output bytes are
 * stable across runs.
 *
 * Pipeline order follows a camera: geometry (the label's pose) → lighting (glare, exposure)
 * → sensor noise → compression.
 *
 * Everything runs on a single 8-bit luminance plane. Barcode decoding only ever looks at
 * luminance, and clamping to bytes between stages is what a real 8-bit imaging chain does.
 * The final PNG is written back out as 3-channel sRGB so any consumer (sharp, pngjs, a
 * canvas) sees an ordinary greyscale-looking colour image.
 */
import sharp from "sharp";

export type Tier = "clean" | "moderate" | "severe";

export const TIERS: readonly Tier[] = ["clean", "moderate", "severe"];

/**
 * Every tunable in one place so the bench report can state exactly what "moderate" and
 * "severe" meant for a given run, and so a finding can name one number. Ranges are
 * `[min, max]` and are sampled from the seed.
 *
 * These are derived from the physical situation, not fitted to the §13.6 thresholds. Where a
 * value was chosen rather than derived, the comment says what was measured.
 */
export const DEGRADE_PARAMS = {
  /** §13.4: blur σ≈1.5, rotation ±15°, 70% scale, light noise. */
  moderate: {
    rotationDeg: [-15, 15],
    scale: 0.7,
    blurSigma: 1.5,
    /** "Light noise": a daylight phone frame, grain you can see but not read through. */
    noiseSigma: [2, 4],
  },
  /**
   * §13.4: cylindrical / perspective warp for curved door jambs, a glare band across the
   * code, 50% scale, low light, JPEG artifacts.
   */
  severe: {
    /**
     * Half-angle of the cylinder the label is wrapped around, radians. 0.45–0.7 rad is a
     * 26–40° arc across the frame, which compresses the bars at the edges by
     * tan(θ)/θ = 1.07–1.20× relative to the centre.
     */
    cylinderTheta: [0.45, 0.7],
    /**
     * Perspective keystone: how much shorter the far vertical edge is, as a fraction of the
     * near edge. For a label of width W photographed from distance D at yaw φ, that fraction
     * is ≈ (W·sin φ)/D; a 10 cm label at 25 cm gives 0.12 at 18° and 0.28 at 45° off-axis —
     * the range someone gets crouched at an open door, unable to square up to the jamb.
     */
    keystone: [0.12, 0.28],
    scale: 0.5,
    /** Direction of the glare streak, degrees from horizontal. */
    glareAngleDeg: [25, 65],
    /** Band centre offset along the band normal, as a fraction of the half-extent. */
    glareOffsetFrac: [-0.3, 0.3],
    /**
     * Band half-width σ as a fraction of the image diagonal, so the washed core is ±2σ =
     * 12–20% of the frame — a streak across part of the code, not a blanket over it.
     */
    glareSigmaFrac: [0.03, 0.05],
    /**
     * Peak wash toward white at the band centre. This is the single most destructive knob in
     * the tier: measured on Code 39, 0.5 → 90–100% decode, 0.65 → 15–83%, 0.8 → 0%. Above
     * ~0.75 the band stops washing the code and starts erasing it, which measures nothing.
     */
    glarePeak: [0.5, 0.65],
    /** Underexposure: contrast collapse toward mid-grey, then a brightness cut. */
    lowLightContrast: [0.6, 0.75],
    lowLightBrightness: [0.5, 0.65],
    /** Heavier grain: a high-ISO frame. Measured cliff: σ ≥ 9 on top of the rest is 0%. */
    noiseSigma: [5, 8],
    jpegQuality: [38, 50],
  },
} as const;

/** Value used for anything sampled from outside the image — the label's white surround. */
const BACKGROUND = 255;

const WHITE = { r: 255, g: 255, b: 255 };

type SharpPipeline = ReturnType<typeof sharp>;

interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Degrade one barcode PNG to the given tier.
 *
 * - `clean` — the control: a re-encode only. Same normalisation (flatten onto white,
 *   luminance, sRGB PNG) as the other tiers, so a clean failure is a decoder problem and
 *   never a format problem.
 * - `moderate` — rotate ±15° on white, scale to 70%, defocus blur σ≈1.5, light sensor grain.
 * - `severe` — cylindrical + perspective warp, scale to 50%, a glare band across the code,
 *   underexposure, heavier grain, low-quality JPEG.
 *
 * The pose depends only on the seed, not on the image, so every corpus item degraded with
 * seed 1 gets the *same* rotation and the same warp. Callers wanting a distribution rather
 * than a handful of poses must vary the seed per image (e.g. the item's index), otherwise a
 * cell of 200 images is really a sample of however many distinct seeds were used.
 */
export async function degrade(png: Buffer, tier: Tier, seed: number): Promise<Buffer> {
  const source = await rawGray(sharp(png).flatten({ background: WHITE }));
  switch (tier) {
    case "clean":
      return toPng(source);
    case "moderate":
      return toPng(await moderate(source, seed));
    case "severe":
      return toPng(await severe(source, seed));
    default: {
      const unreachable: never = tier;
      throw new Error(`degrade: unknown tier ${String(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * A hand-held frame of a flat label: the phone is tilted, held back a bit, and slightly out
 * of focus.
 *
 * Blur runs before the downscale, i.e. σ=1.5 is measured on the rendered label rather than
 * on the sampled frame — lens defocus happens to the optical image, the sensor samples what
 * comes out. Measured either way at ≥4 px per narrow module the decode rate is identical;
 * below that, blurring after the downscale is a second, unstated degradation that swamps the
 * tier (Code 128 at 3 px/module: 33% → 4%). Blur-first keeps "moderate" meaning what §13.4
 * says it means at whatever size the corpus renders.
 */
async function moderate(source: Gray, seed: number): Promise<Gray> {
  const p = DEGRADE_PARAMS.moderate;
  const blurred = await viaSharp(source, (s) => s.blur(p.blurSigma));

  const geometry = stream(seed, "moderate/geometry");
  const angle = range(geometry, p.rotationDeg[0], p.rotationDeg[1]);
  // Rotation fills the new corners with white, not black, so the binariser is not handed a
  // dark frame that never appears on a real label.
  const rotated = await viaSharp(blurred, (s) => s.rotate(angle, { background: WHITE }));
  const scaled = await viaSharp(rotated, (s) => resizeBy(s, rotated, p.scale));

  const noise = stream(seed, "moderate/noise");
  return addNoise(scaled, range(noise, p.noiseSigma[0], p.noiseSigma[1]), noise);
}

/**
 * A label wrapped around a curved door jamb, photographed off-axis in bad light with the sun
 * on the laminate. Geometry first, then lighting, then grain, then compression.
 */
async function severe(source: Gray, seed: number): Promise<Gray> {
  const p = DEGRADE_PARAMS.severe;

  const geometry = stream(seed, "severe/geometry");
  const thetaMax = range(geometry, p.cylinderTheta[0], p.cylinderTheta[1]);
  const keystone = range(geometry, p.keystone[0], p.keystone[1]);
  const farSide: -1 | 1 = geometry() < 0.5 ? -1 : 1;

  const warped = warp(source, thetaMax, keystone, farSide);
  const scaled = await viaSharp(warped, (s) => resizeBy(s, warped, p.scale));

  const glared = applyGlare(scaled, stream(seed, "severe/glare"));
  const dim = applyLowLight(glared, stream(seed, "severe/lowLight"));

  const grain = stream(seed, "severe/noise");
  const noisy = addNoise(dim, range(grain, p.noiseSigma[0], p.noiseSigma[1]), grain);

  const codec = stream(seed, "severe/jpeg");
  const quality = Math.round(range(codec, p.jpegQuality[0], p.jpegQuality[1]));
  return jpegRoundTrip(noisy, quality);
}

// ---------------------------------------------------------------------------
// Pixel operations
// ---------------------------------------------------------------------------

/**
 * Cylindrical wrap seen through an off-axis perspective, resampled bilinearly in one pass.
 *
 * Forward model: a flat label is wrapped around a vertical cylinder of half-angle
 * `thetaMax`, then photographed from one side. Resampling walks it backwards — for each
 * destination pixel, undo the perspective, then undo the cylinder.
 *
 * *Cylinder.* A point at arc coordinate θ sits at screen x = R·sin θ, so the source column
 * for a destination column is `asin(xₙ·sin θmax) / θmax` in normalised units. Bars near the
 * centre keep their width; bars near the edges are compressed by tan(θmax)/θmax — 1.09× at
 * θmax = 0.5 rad, 1.20× at 0.7 rad. That progressive horizontal compression is the specific
 * thing that breaks 1D decoding on a curved jamb, and it is not a projective transform, so
 * no amount of corner-fitting undoes it.
 *
 * *Perspective.* The frame is mapped to a trapezoid whose far vertical edge is `keystone`
 * shorter, on the side given by `farSide`. This is a real homography (built from the
 * unit-square-to-quad closed form, then inverted), which matters: an off-axis photo of a
 * plane *is* projective, so a detector that fits a perspective transform can undo it. An
 * earlier draft ramped vertical magnification linearly instead, which looks similar but is
 * not projective and took QR from 100% to 0% on its own — that was a bug in the tier, not a
 * finding about the scanner.
 *
 * With the homography in place Data Matrix and both 1D symbologies are unaffected by the
 * keystone up to 0.28 in isolation, and QR is not: a VIN-only QR (version 2, 42-module
 * grid) reads at 100% up to keystone 0.04 and 0% from 0.06 — see the bench report. That
 * cliff is a property of ZXing's QR detector, so it is left in place rather than tuned out.
 *
 * Samples outside the source are white: past the edge of the label is the door jamb's light
 * surround, not black.
 */
function warp(source: Gray, thetaMax: number, keystone: number, farSide: -1 | 1): Gray {
  const { width, height } = source;
  const out = new Uint8Array(width * height);
  const maxX = width - 1;
  const maxY = height - 1;
  if (maxX <= 0 || maxY <= 0) return { data: new Uint8Array(source.data), width, height };

  const shortEdge = (maxY * keystone) / 2;
  // Unit-square corners (0,0) (1,0) (1,1) (0,1) map to these, in destination pixels.
  const quad: Quad =
    farSide === 1
      ? [
          [0, 0],
          [maxX, shortEdge],
          [maxX, maxY - shortEdge],
          [0, maxY],
        ]
      : [
          [0, shortEdge],
          [maxX, 0],
          [maxX, maxY],
          [0, maxY - shortEdge],
        ];
  const inverse = invert3x3(squareToQuad(quad));

  const cx = maxX / 2;
  const halfW = cx > 0 ? cx : 1;
  const sinTheta = Math.sin(thetaMax);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const w = inverse[6] * x + inverse[7] * y + inverse[8];
      if (w === 0) {
        out[y * width + x] = BACKGROUND;
        continue;
      }
      // Undo the perspective: back to the frame as the cylinder projected it.
      const u = (inverse[0] * x + inverse[1] * y + inverse[2]) / w;
      const v = (inverse[3] * x + inverse[4] * y + inverse[5]) / w;
      const flatX = u * maxX;
      const flatY = v * maxY;
      // Undo the cylinder: back to the flat label.
      const xn = (flatX - cx) / halfW;
      const theta = Math.asin(clamp(xn * sinTheta, -1, 1));
      const sx = cx + (theta / thetaMax) * halfW;
      out[y * width + x] = bilinear(source, sx, flatY);
    }
  }
  return { data: out, width, height };
}

type Quad = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

/**
 * Heckbert's closed form for the projective map taking the unit square's corners to a quad,
 * returned row-major as a 3×3 with m[8] = 1.
 */
function squareToQuad(quad: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  if (dx3 === 0 && dy3 === 0) {
    // Affine: the quad is a parallelogram.
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const den = dx1 * dy2 - dx2 * dy1;
  if (den === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

/** Adjugate of a 3×3 — the inverse up to a scale, which projective division cancels. */
function invert3x3(m: number[]): number[] {
  return [
    m[4] * m[8] - m[5] * m[7],
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8],
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6],
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3],
  ];
}

/**
 * Sun on a laminated label: a bright band laid diagonally across the symbol.
 *
 * The band is a Gaussian ridge about a line, blended toward white (`v + (255 − v)·gain`), so
 * the core washes contrast out without erasing the bars — a hard erase would make severe a
 * measurement of nothing. The band's centre is held inside the middle 60% of the image so it
 * always crosses the code rather than clipping a corner.
 */
function applyGlare(image: Gray, rng: () => number): Gray {
  const p = DEGRADE_PARAMS.severe;
  const { data, width, height } = image;
  const direction = toRadians(range(rng, p.glareAngleDeg[0], p.glareAngleDeg[1]));
  // Unit normal to the band's direction; distance from the band's centre line is measured
  // along it.
  const nx = -Math.sin(direction);
  const ny = Math.cos(direction);
  const sigma = Math.max(
    1,
    range(rng, p.glareSigmaFrac[0], p.glareSigmaFrac[1]) * Math.hypot(width, height),
  );
  const halfExtent = (Math.abs(nx) * width + Math.abs(ny) * height) / 2;
  const offset = range(rng, p.glareOffsetFrac[0], p.glareOffsetFrac[1]) * halfExtent;
  const peak = range(rng, p.glarePeak[0], p.glarePeak[1]);

  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const falloff = 1 / (2 * sigma * sigma);
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const dyn = ny * (y - cy) - offset;
    for (let x = 0; x < width; x += 1) {
      const d = nx * (x - cx) + dyn;
      const gain = peak * Math.exp(-d * d * falloff);
      const v = data[y * width + x];
      out[y * width + x] = clampByte(v + (255 - v) * gain);
    }
  }
  return { data: out, width, height };
}

/**
 * Underexposure: contrast collapses toward mid-grey and the whole frame is pulled down, the
 * way a dim phone frame looks. Applied together, because a real underexposed frame loses
 * both at once.
 */
function applyLowLight(image: Gray, rng: () => number): Gray {
  const p = DEGRADE_PARAMS.severe;
  const contrast = range(rng, p.lowLightContrast[0], p.lowLightContrast[1]);
  const brightness = range(rng, p.lowLightBrightness[0], p.lowLightBrightness[1]);
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = clampByte(brightness * ((image.data[i] - 128) * contrast + 128));
  }
  return { data: out, width: image.width, height: image.height };
}

/** Additive Gaussian sensor grain, generated in row-major order so the field is seed-stable. */
function addNoise(image: Gray, sigma: number, rng: () => number): Gray {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = clampByte(image.data[i] + sigma * gaussian(rng));
  }
  return { data: out, width: image.width, height: image.height };
}

/** Encode to a low-quality JPEG and decode back — the artifacts a camera app leaves behind. */
async function jpegRoundTrip(image: Gray, quality: number): Promise<Gray> {
  const encoded = await fromGray(image)
    .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: false })
    .toBuffer();
  return rawGray(sharp(encoded));
}

// ---------------------------------------------------------------------------
// sharp plumbing
// ---------------------------------------------------------------------------

/** Run a sharp operation on a luminance plane and come back to one. */
async function viaSharp(image: Gray, op: (s: SharpPipeline) => SharpPipeline): Promise<Gray> {
  return rawGray(op(fromGray(image)));
}

function resizeBy(s: SharpPipeline, image: Gray, scale: number): SharpPipeline {
  return s.resize(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
    { fit: "fill", kernel: "lanczos3" },
  );
}

function fromGray(image: Gray): SharpPipeline {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 1 },
  });
}

async function rawGray(pipeline: SharpPipeline): Promise<Gray> {
  const { data, info } = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) {
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  }
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = data[i * info.channels];
  }
  return { data: out, width: info.width, height: info.height };
}

/** Every tier ends here, so all three are byte-comparable 3-channel sRGB PNGs. */
async function toPng(image: Gray): Promise<Buffer> {
  return fromGray(image).toColourspace("srgb").png({ compressionLevel: 9 }).toBuffer();
}

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/**
 * One independent stream per purpose, keyed by `(seed, label)`, so retuning the rotation
 * range cannot shift the noise field and vice versa.
 */
function stream(seed: number, label: string): () => number {
  return mulberry32((seed ^ fnv1a(label)) >>> 0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function range(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

/** Box–Muller, so grain is Gaussian rather than uniform. */
function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function bilinear(image: Gray, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const top = lerp(texel(image, x0, y0), texel(image, x0 + 1, y0), fx);
  const bottom = lerp(texel(image, x0, y0 + 1), texel(image, x0 + 1, y0 + 1), fx);
  return clampByte(lerp(top, bottom, fy));
}

function texel(image: Gray, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return BACKGROUND;
  return image.data[y * image.width + x];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampByte(value: number): number {
  return clamp(Math.round(value), 0, 255);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
