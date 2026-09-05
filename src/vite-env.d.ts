/// <reference types="vite/client" />

/** Short commit hash, injected by vite.config.ts. */
declare const __BUILD_STAMP__: string;

/**
 * The year this build was made, injected by `vite.config.ts`, `vite.pages.config.ts` and
 * `vitest.config.ts` from `scripts/build-year.ts`. §4.4 step 0's floor under the device
 * clock; `currentYear()` in `src/lib/storage/db.ts` is the only reader.
 */
declare const __BUILD_YEAR__: number;
