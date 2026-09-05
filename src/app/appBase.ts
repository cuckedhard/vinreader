/**
 * Where this app is deployed, as an absolute URL ending in `/`.
 *
 * §4.9's URL carrier is `https://<host>/#/i?d=…`, and `codec.ts` builds it from whatever the
 * caller hands it — its `baseUrl()` already keeps "a deployment under a sub-path carries a
 * trailing slash that has to survive". What the caller hands it is this. `location.origin`
 * is not: it is scheme + host + port and nothing else, so on a project deployment
 * (`https://<user>.github.io/vinreader/`) the QR a second phone scans points at the site
 * root instead of the app, and the handoff §4.9 exists for is dead.
 *
 * `import.meta.env.BASE_URL` is Vite's answer to "what path was this build made for":
 * `/` for `vite.config.ts`, `/vinreader/` for `vite.pages.config.ts`, `./` for the
 * single-file demo. Resolved against the open document rather than concatenated onto the
 * origin, because the relative one is a real case — `"https://host" + "./"` is
 * `https://host./`, a different host — and because resolution is what a browser would do
 * with the same two strings.
 *
 * §8 Q1 (the public host) is still open, and `.env.example`'s `VITE_APP_HOST` is not read
 * here or anywhere else in `src/`. Deciding whether a configured host should override the
 * one the app is running on is that question, not this fix.
 */
export function resolveAppBase(href: string, base: string): string {
  return new URL(base, href).href;
}

/** The same, asked of the running document. */
export function appBaseUrl(): string {
  return resolveAppBase(window.location.href, import.meta.env.BASE_URL);
}
