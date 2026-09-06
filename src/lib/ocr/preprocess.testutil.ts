/**
 * A 2D canvas small enough to reason about, for testing `preprocess.ts` in node.
 *
 * `getImageData` copies and `putImageData` writes back, exactly as the platform does, so a
 * pipeline that forgets to put its grayscale back produces a colour image here too — the
 * fake cannot pass a step the browser would fail.
 *
 * Not production source: excluded from coverage and from mutation scoring (R4-D).
 */
import type { CanvasLike, Context2DLike, ImageDataLike } from "./preprocess";

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function isPixels(value: unknown): value is Pixels {
  const candidate = value as Pixels | null;
  return (
    typeof candidate?.width === "number" &&
    typeof candidate.height === "number" &&
    candidate.data instanceof Uint8ClampedArray
  );
}

function makeContext(canvas: FakeCanvas): Context2DLike {
  return {
    set imageSmoothingEnabled(value: boolean) {
      canvas.smoothing.push(value);
    },
    get imageSmoothingEnabled() {
      return true;
    },
    set imageSmoothingQuality(value: "low" | "medium" | "high") {
      canvas.quality.push(value);
    },
    get imageSmoothingQuality() {
      return "high" as const;
    },
    drawImage(image: unknown, sx, sy, sw, sh, dx, dy, dw, dh) {
      if (!isPixels(image)) throw new Error("drawImage: not an image");
      // Nearest neighbour. Enough to prove what was sampled from where; the browser's own
      // resampling quality is what `imageSmoothingQuality` is asserted for.
      for (let y = 0; y < dh; y += 1) {
        for (let x = 0; x < dw; x += 1) {
          const srcX = Math.min(Math.floor(sx + ((x + 0.5) * sw) / dw), image.width - 1);
          const srcY = Math.min(Math.floor(sy + ((y + 0.5) * sh) / dh), image.height - 1);
          if (srcX < 0 || srcY < 0) continue;
          const from = (srcY * image.width + srcX) * 4;
          const to = ((dy + y) * canvas.width + (dx + x)) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            canvas.data[to + channel] = image.data[from + channel] ?? 0;
          }
        }
      }
    },
    getImageData(sx, sy, sw, sh) {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
          const from = ((sy + y) * canvas.width + (sx + x)) * 4;
          const to = (y * sw + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            out[to + channel] = canvas.data[from + channel] ?? 0;
          }
        }
      }
      return { data: out, width: sw, height: sh };
    },
    putImageData(image: ImageDataLike, dx: number, dy: number) {
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const from = (y * image.width + x) * 4;
          const to = ((dy + y) * canvas.width + (dx + x)) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            canvas.data[to + channel] = image.data[from + channel] ?? 0;
          }
        }
      }
    },
  };
}

export class FakeCanvas implements CanvasLike, Pixels {
  data: Uint8ClampedArray;
  /** Every `imageSmoothingQuality` this canvas was set to, in order. */
  readonly quality: string[] = [];
  readonly smoothing: boolean[] = [];
  private readonly ctx: Context2DLike;

  constructor(
    public width: number,
    public height: number,
    private readonly missingContext = false,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    this.ctx = makeContext(this);
  }

  getContext(): Context2DLike | null {
    return this.missingContext ? null : this.ctx;
  }

  /** The RGBA at one pixel. */
  at(x: number, y: number): [number, number, number, number] {
    const at = (y * this.width + x) * 4;
    return [
      this.data[at] ?? 0,
      this.data[at + 1] ?? 0,
      this.data[at + 2] ?? 0,
      this.data[at + 3] ?? 0,
    ];
  }

  /** Every distinct red channel value in the canvas. */
  levels(): number[] {
    const seen = new Set<number>();
    for (let i = 0; i < this.data.length; i += 4) seen.add(this.data[i] ?? 0);
    return [...seen].sort((a, b) => a - b);
  }
}

/** A solid RGBA image. */
export function solid(
  width: number,
  height: number,
  background: readonly [number, number, number],
): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = background[0];
    data[i * 4 + 1] = background[1];
    data[i * 4 + 2] = background[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** One rectangle of an image, painted. */
export function fill(
  image: Pixels,
  rect: { left: number; top: number; width: number; height: number },
  colour: readonly [number, number, number],
): Pixels {
  for (let y = rect.top; y < rect.top + rect.height; y += 1) {
    for (let x = rect.left; x < rect.left + rect.width; x += 1) {
      const at = (y * image.width + x) * 4;
      image.data[at] = colour[0];
      image.data[at + 1] = colour[1];
      image.data[at + 2] = colour[2];
      image.data[at + 3] = 255;
    }
  }
  return image;
}

/** One byte per pixel, from an RGBA image whose channels are already equal. */
export function grayOf(pixels: Pixels): Uint8Array {
  const out = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < out.length; i += 1) out[i] = pixels.data[i * 4] ?? 0;
  return out;
}
