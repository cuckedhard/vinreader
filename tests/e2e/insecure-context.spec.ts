import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";

/**
 * §13.2 adversary, round 3 of `harden S1`. [R3-B].
 *
 * §6.3: "Insecure context → error(insecure_context) immediately, no permission prompt",
 * and §6.4 gives that state a line of its own — so the app expects to be opened over plain
 * http and has a designed answer for it: use the keyboard. `bun run preview --host` serves
 * exactly that, and so does any LAN deployment that is not behind TLS.
 *
 * This drives the whole of that designed answer, end to end, from an origin that is not a
 * secure context — which is the only way to see what `crypto.randomUUID` does there.
 * `dist/` is served over http from a non-loopback address, because Chromium treats
 * localhost and 127.0.0.1 as secure however they are served.
 */
const DIST = resolve(process.cwd(), "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

let server: Server | null = null;
let origin = "";

test.beforeAll(async () => {
  const host = lanAddress();
  // Chromium calls localhost and 127.0.0.1 secure however they are served, so without a
  // non-loopback address there is no insecure origin to test from. The test says so.
  if (host === null || !existsSync(DIST)) return;

  server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0]!.split("#")[0]!;
    const candidate = join(DIST, normalize(path));
    const file =
      candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(DIST, "index.html");
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((ready) => server!.listen(0, "0.0.0.0", ready));
  const port = (server!.address() as { port: number }).port;
  origin = `http://${host}:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

test("[R3-B] the keyboard fallback §6.4 points at can still save over plain http", async ({
  page,
}) => {
  test.skip(origin === "", "needs a non-loopback address and a built dist/");
  await page.goto(`${origin}/#/scan`);

  // The platform facts this finding rests on, asserted rather than assumed.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");

  // §6.3 and §6.4: no permission prompt, and the line that sends the user to the keyboard.
  await expect(page.getByText("Camera needs a secure (https) connection.")).toBeVisible();

  await page.getByRole("button", { name: /type vin instead/i }).click();
  await page.getByRole("textbox", { name: /vin/i }).fill("1HGCM82633A004352");
  await page.getByRole("button", { name: "Save VIN" }).click();

  // FAILS today: `upsertVehicle` calls `crypto.randomUUID()` for the §5.2 event id
  // (upsert.ts:91), and that method is [SecureContext]. The transaction throws, the
  // record is rolled back, and the screen shows "Couldn't save this VIN" over the raw
  // "crypto.randomUUID is not a function". Nothing this user scans or types on this
  // deployment can ever be stored — on the exact fallback §6.4 sends them to.
  await expect(page).toHaveURL(/#\/v\/1HGCM82633A004352/, { timeout: 10_000 });
  await expect(page.getByText("1HG CM826 3 3 A 004352")).toBeVisible();
});
