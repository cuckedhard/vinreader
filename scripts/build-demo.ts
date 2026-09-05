/**
 * Builds the app as a single self-contained HTML file for publishing as a Claude Artifact.
 *
 * `bun run demo:build [outfile]`
 *
 * The artifact host wraps whatever this emits in its own
 * `<!doctype html><head>…</head><body>`, serves it from a sandboxed iframe, and enforces a
 * CSP that blocks every external subresource — no stylesheet, script, image, font, fetch or
 * WebSocket to any host, including the origin the page itself came from. So the output
 * carries no document skeleton and no references at all: the CSS goes into a `<style>`, the
 * one JS chunk (`vite.demo.config.ts` collapses the graph so there is exactly one) into an
 * inline `<script type="module">`, and the icons become `data:` URIs.
 *
 * What this script deliberately does NOT do is paper over the sandbox. The camera, the vPIC
 * lookup, sign-in and file downloads are unavailable or blocked in that frame; the app's own
 * failure paths handle all four, and hiding them would misrepresent the build. See the
 * header comment written into the output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "dist-demo");
const defaultOut = join(outDir, "vinrelay-demo.html");

/** `data:` media types for everything `index.html` can reference by `<link>`. */
const MEDIA_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * The one text sequence that can end an inline `<script>` or `<style>` early. Neither the
 * current bundle nor the current CSS contains it, which is exactly why it has to be handled
 * here rather than checked once by hand — a string literal in some future dependency would
 * otherwise cut the artifact short in mid-bundle and leave a blank page.
 */
function escapeForInlineElement(source: string): string {
  return source.replace(/<\/(script|style)/gi, "<\\/$1");
}

function dataUri(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const type = MEDIA_TYPES[ext] ?? "application/octet-stream";
  return `data:${type};base64,${readFileSync(filePath).toString("base64")}`;
}

/** Resolves a `./`-relative href from the emitted `index.html` to a path under `dist-demo`. */
function assetPath(href: string): string {
  return join(outDir, href.replace(/^\.?\//, "").split("?")[0]!);
}

function section(source: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(source);
  if (match === null) throw new Error(`build-demo: no <${tag}> in dist-demo/index.html`);
  return match[1]!;
}

/**
 * Everything the sandbox needs settled before the app's own code runs, in the order it has
 * to happen.
 *
 * `data-theme` first: it normally lives on `<html>` in `index.html` (§6.1 — dark is the
 * pre-hydration value so the majority never see a flash), and the artifact host supplies its
 * own `<html>`, so the attribute would otherwise be lost. It is set before the theme
 * bootstrap that follows, which is free to replace it from the stored choice.
 *
 * Then service-worker registration. `PWA_DISABLED=1` means nothing in the bundle asks for
 * one, so this is defence in depth rather than a fix: it keeps any future registration —
 * from the app or from a dependency — from throwing inside a frame where the API is present
 * but forbidden, which is a rejected promise no caller here has a handler for.
 */
const GUARD_SCRIPT = `(function () {
  try {
    var root = document.documentElement;
    if (!root.dataset.theme) root.dataset.theme = "dark";
    if (!root.lang) root.lang = "en";
  } catch (e) {}
  try {
    var container = navigator.serviceWorker;
    if (container && typeof container.register === "function") {
      var stub = {
        scope: location.href, installing: null, waiting: null, active: null,
        update: function () { return Promise.resolve(stub); },
        unregister: function () { return Promise.resolve(true); },
        addEventListener: function () {}, removeEventListener: function () {}
      };
      container.register = function () { return Promise.resolve(stub); };
      container.getRegistration = function () { return Promise.resolve(undefined); };
      container.getRegistrations = function () { return Promise.resolve([]); };
    }
  } catch (e) {}
})();`;

/**
 * Undoes the artifact wrapper's reset, which is written for a light document: it sets
 * `color-scheme: light`, a 14 px body font and its own body background, and this app is
 * dark and high-contrast by default (§6.1). `src/index.css` already states the background
 * and colour, but only as unlayered rules that win on document order — stating them again
 * here, after the app's stylesheet, makes that independent of how the host orders its own.
 *
 * `color-scheme` is the one the app's CSS cannot cover at all: it drives the scrollbars,
 * the form-control chrome and the caret, none of which are painted from custom properties.
 */
const ARTIFACT_OVERRIDES = `/* --- artifact host overrides (scripts/build-demo.ts) --- */
:root { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  font-size: 16px;
  background: var(--bg);
  color: var(--fg);
}`;

function build(): void {
  // `vite.demo.config.ts` sets this too; setting it here as well means a run of this script
  // is identical whether or not the npm script was the entry point.
  const result = spawnSync(
    "bunx",
    ["vite", "build", "--config", "vite.demo.config.ts", "--logLevel", "warn"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PWA_DISABLED: "1",
        // See the note on the `import("./vite.config")` in `vite.demo.config.ts`: the
        // extension Vite asks for is the one `tsc` forbids here, and the resolution works
        // either way. Silenced so the only output of a good build is the build.
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`build-demo: vite build failed (exit ${String(result.status)})`);
  }
}

function assertSingleChunk(): void {
  const scripts = readdirSync(join(outDir, "assets")).filter((f) => f.endsWith(".js"));
  if (scripts.length !== 1) {
    throw new Error(
      `build-demo: expected exactly one JS chunk in dist-demo/assets, found ${String(
        scripts.length,
      )}: ${scripts.join(", ")}. Code splitting is on — check ` +
        `build.rollupOptions.output.codeSplitting in vite.demo.config.ts.`,
    );
  }
}

function inline(): string {
  const html = readFileSync(join(outDir, "index.html"), "utf8");
  const head = section(html, "head");
  const body = section(html, "body");

  const title = /<title>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "VIN Relay";

  // The one stylesheet and the one module script, by href, from the emitted head.
  const cssHref = /<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/i.exec(head)?.[1];
  const jsHref = /<script[^>]+type="module"[^>]*src="([^"]+)"/i.exec(head)?.[1];
  if (cssHref === undefined) throw new Error("build-demo: no stylesheet link in index.html");
  if (jsHref === undefined) throw new Error("build-demo: no module script in index.html");

  const css = readFileSync(assetPath(cssHref), "utf8");
  const js = readFileSync(assetPath(jsHref), "utf8");

  // `index.html`'s pre-paint theme bootstrap, carried over verbatim. It is the only inline
  // script in the source head and it is load-bearing (§6.1), so it is lifted rather than
  // reimplemented — a copy here would be a second place for the two palette literals to
  // drift, which `src/ui/theme.test.ts` guards in the original.
  const bootstrap = /<script>([\s\S]*?)<\/script>/i.exec(head)?.[1]?.trim() ?? "";
  if (bootstrap === "") {
    throw new Error("build-demo: index.html's pre-paint theme bootstrap went missing");
  }

  // `<link rel="icon">` / `apple-touch-icon`, as data: URIs. Nothing may be fetched.
  const icons: string[] = [];
  for (const match of head.matchAll(/<link\s+([^>]*rel="(?:[^"]*icon)"[^>]*)>/gi)) {
    const attrs = match[1]!;
    const href = /href="([^"]+)"/i.exec(attrs)?.[1];
    if (href === undefined) continue;
    const file = assetPath(href);
    if (!existsSync(file)) continue;
    icons.push(`<link ${attrs.replace(/href="[^"]+"/i, `href="${dataUri(file)}"`)}>`);
  }

  // The theme bootstrap looks this up and rewrites it; keeping it means the lifted script
  // behaves exactly as it does in the real app instead of taking its null branch.
  const themeColor = /<meta\s+name="theme-color"[^>]*>/i.exec(head)?.[0] ?? "";

  // The body of the emitted document, minus the script tag Vite injected into the head.
  const rootDiv = body.replace(/<script[\s\S]*?<\/script>/gi, "").trim();

  return `<title>${title}</title>
${themeColor}
${icons.join("\n")}

<style>
${escapeForInlineElement(css)}

${ARTIFACT_OVERRIDES}
</style>

<script>
${GUARD_SCRIPT}
</script>

<script>
${bootstrap}
</script>

${rootDiv}

<script type="module">
${escapeForInlineElement(js)}
</script>
`;
}

const outFile = resolve(process.argv[2] ?? defaultOut);
build();
assertSingleChunk();
const output = inline();
writeFileSync(outFile, output, "utf8");

const bytes = Buffer.byteLength(output, "utf8");
console.log(`build-demo: ${basename(outFile)} — ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`build-demo: ${outFile}`);
if (bytes > 16 * 1024 * 1024) {
  throw new Error("build-demo: output exceeds the artifact host's 16 MB limit");
}
