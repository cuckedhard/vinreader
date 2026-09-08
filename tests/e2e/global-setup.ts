import { pruneQrY4mCache, QR_CACHE_DIR } from "./qr-video";

/**
 * [ENV-1] Take out what a previous run could not.
 *
 * The fake-camera videos are content-addressed and shared (`qr-video.ts`), so a normal run
 * adds nothing to the cache it did not need. What a normal run cannot do is clean up after
 * an abnormal one: an interrupt, a killed worker or an `ENOSPC` mid-write can leave an
 * unpublished `.tmp` behind, and editing a spec's frame counts orphans the video it used to
 * ask for. Both are collected here.
 *
 * This is a global setup rather than a teardown or an `afterAll` on purpose. The paths that
 * filled the disk were the ones where no teardown ran at all — 108 leftover directories did
 * not come from clean exits — and it is the only hook Playwright runs exactly once, in the
 * main process, before any worker exists, which is what makes it safe to delete files the
 * workers are about to read. It runs for every invocation, including a single
 * `playwright test <file>`, which is how the last count of 24 directories was reached.
 */
export default function globalSetup(): void {
  const { files, bytes } = pruneQrY4mCache();
  if (files > 0) {
    const mb = (bytes / 1024 / 1024).toFixed(0);
    console.log(`[qr-video] pruned ${files} stale file(s), ${mb} MB, from ${QR_CACHE_DIR}`);
  }
}
