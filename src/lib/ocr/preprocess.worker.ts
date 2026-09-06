/**
 * The preprocessing worker: one frame in, one prepared crop out.
 *
 * Deliberately thin. Everything it decides is in `preprocess.ts`, which is tested in node
 * against a fake canvas; what is here is the part that can only exist in a worker — an
 * `OffscreenCanvas` to draw on, and the message boundary. It holds no WebAssembly and no
 * state, so it is not the one instance §4 caps (that is the tesseract worker), and it does
 * not touch the ZXing path in any way (N1/P1).
 */
import { preprocessCrop, type CanvasLike } from "./preprocess";
import type { PreprocessRequest, PreprocessResponse } from "./preprocessClient";

const scope = self as unknown as {
  onmessage: ((event: { data: PreprocessRequest }) => void) | null;
  postMessage: (message: PreprocessResponse) => void;
};

scope.onmessage = (event) => {
  const { id, frame, rect } = event.data;
  void preprocessCrop(frame, rect, {
    createCanvas: (width, height) => new OffscreenCanvas(width, height) as unknown as CanvasLike,
    encode: (canvas) => (canvas as unknown as OffscreenCanvas).convertToBlob({ type: "image/png" }),
  })
    .then((result) => {
      scope.postMessage({
        id,
        ok: true,
        blob: result.blob,
        width: result.width,
        height: result.height,
        scale: result.scale,
        band: result.band,
      });
    })
    .catch((error: unknown) => {
      // P7: the reason crosses the boundary. A worker that fails silently is a screen that
      // waits forever on a promise nothing will settle.
      scope.postMessage({ id, ok: false, error: String(error) });
    });
};
