/**
 * The conversation with the preprocessing worker.
 *
 * A frame that goes across and never comes back is a screen waiting forever, and a reply
 * matched to the wrong request is a crop from one frame proposed as another's. Neither is
 * visible from the browser — both look like "OCR is slow today" — so both are pinned here,
 * with the worker faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCropReader, type PreprocessResponse, type WorkerLike } from "./preprocessClient";
import { OcrError } from "./types";

const RECT = { left: 0, top: 0, width: 10, height: 4 };
const BAND = { top: 1, height: 2, measured: true };

class FakeWorker implements WorkerLike {
  readonly posted: { id: number; frame: unknown; transfer: Transferable[] }[] = [];
  terminated = 0;
  private listener: ((event: { data: PreprocessResponse }) => void) | null = null;

  postMessage(message: { id: number; frame: unknown }, transfer: Transferable[]): void {
    this.posted.push({ id: message.id, frame: message.frame, transfer });
  }

  addEventListener(_type: "message", listener: (event: { data: PreprocessResponse }) => void) {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated += 1;
  }

  reply(response: PreprocessResponse): void {
    this.listener?.({ data: response });
  }

  ok(id: number, width = 100): void {
    this.reply({ id, ok: true, blob: new Blob([String(id)]), width, height: 40, scale: 2, band: BAND });
  }
}

/** One worker, remembered, so a test can reply on it. */
function reader() {
  const workers: FakeWorker[] = [];
  const client = createCropReader(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { client, workers };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCropReader", () => {
  it("hands one frame over and resolves with what came back", async () => {
    const { client, workers } = reader();
    const pending = client.read("frame", RECT);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted[0]).toMatchObject({ id: 1, frame: "frame" });

    workers[0]!.ok(1, 320);
    await expect(pending).resolves.toMatchObject({ width: 320, scale: 2, band: BAND });
  });

  it("keeps one worker for the whole session rather than one per frame", async () => {
    const { client, workers } = reader();
    const first = client.read("a", RECT);
    const second = client.read("b", RECT);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted.map((post) => post.id)).toEqual([1, 2]);

    workers[0]!.ok(1);
    workers[0]!.ok(2);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("gives each reply to the caller that asked for it, whatever order they land in", async () => {
    const { client, workers } = reader();
    const first = client.read("a", RECT);
    const second = client.read("b", RECT);
    workers[0]!.ok(2, 222);
    workers[0]!.ok(1, 111);
    expect((await first).width).toBe(111);
    expect((await second).width).toBe(222);
  });

  it("ignores a reply nobody is waiting for", async () => {
    const { client, workers } = reader();
    const pending = client.read("a", RECT);
    expect(() => workers[0]!.ok(99)).not.toThrow();
    workers[0]!.ok(1, 7);
    expect((await pending).width).toBe(7);
  });

  it("rejects with the worker's own reason rather than hanging on a failure", async () => {
    const { client, workers } = reader();
    const pending = client.read("a", RECT);
    workers[0]!.reply({ id: 1, ok: false, error: "no 2d context for the crop" });
    await expect(pending).rejects.toBeInstanceOf(OcrError);
    await expect(pending).rejects.toMatchObject({
      reason: "engine_failed",
      message: "no 2d context for the crop",
    });
  });

  it("ends everything in flight when the screen goes, rather than leaving it pending", async () => {
    const { client, workers } = reader();
    const pending = client.read("a", RECT);
    client.dispose();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    expect(workers[0]!.terminated).toBe(1);
  });

  it("is safe to dispose twice, and spawns again if it is used again", async () => {
    const { client, workers } = reader();
    client.dispose();
    client.dispose();
    expect(workers).toHaveLength(0);

    const pending = client.read("a", RECT);
    expect(workers).toHaveLength(1);
    workers[0]!.ok(1);
    await expect(pending).resolves.toMatchObject({ scale: 2 });
  });

  it("transfers an ImageBitmap instead of copying a whole frame", async () => {
    class Bitmap {}
    vi.stubGlobal("ImageBitmap", Bitmap);
    const { client, workers } = reader();
    const bitmap = new Bitmap();
    void client.read(bitmap, RECT);
    expect(workers[0]!.posted[0]!.transfer).toEqual([bitmap]);

    // Anything that is not one is not claimed to be transferable, which would throw in a
    // real `postMessage` and take the whole read with it.
    void client.read({ not: "a bitmap" }, RECT);
    expect(workers[0]!.posted[1]!.transfer).toEqual([]);
  });
});
