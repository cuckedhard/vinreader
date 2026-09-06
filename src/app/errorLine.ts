/**
 * An engine's own error, as one line a user can read out over a phone (P7).
 *
 * §6.4 asks for the underlying error under two of its banners — "Couldn't save this VIN"
 * prints it "beneath it in monospace" — so the string is not the app's to hide. Its *shape*
 * is: §6.4's tone is "terse, plain", and what reached the screen was neither. Dexie composes
 * a rejection's `message` as the fault followed by a newline and the inner error restating
 * itself, and both call sites then added the name in front of that, so a field user read the
 * same sentence twice on one line:
 *
 *   "UnknownError: Connection to Indexed Database server lost
 *     UnknownError: Connection to Indexed Database server lost"   (F12, the boundary)
 *   "storage full QuotaExceededError: storage full"               (R3-F4, the write path)
 *
 * The rule here is three sentences long, and nothing about it is Dexie-specific:
 *   · one line — every run of whitespace, newlines included, becomes one space;
 *   · each distinct sentence once — a segment that only restates an earlier one, with or
 *     without an `XxxError:` label in front, is dropped, and one that says something new is
 *     kept, because a cause the app cannot read is not a cause it may throw away;
 *   · the error's name in front, unless the text already opens with it.
 *
 * Pure: no DOM, no I/O. Lives in `app/` rather than `lib/` because it is a rule about what
 * the app *shows*, and both call sites are UI.
 */

const WHITESPACE = /\s+/g;

/**
 * A leading `SomethingError:` / `SomethingException:` label. Used only to compare two
 * segments for sameness — the label is never stripped from what is shown, because which
 * error named itself is part of what the line says.
 */
const LABEL = /^[A-Za-z_$][\w$]*(?:Error|Exception):\s*/;

function tidy(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

export function errorLine(error: unknown): string {
  const name = error instanceof Error ? tidy(error.name) : "";
  const raw = error instanceof Error ? error.message : String(error);

  const kept: string[] = [];
  const said: string[] = [];
  for (const segment of raw.split("\n")) {
    const line = tidy(segment);
    if (line === "") continue;
    const bare = line.replace(LABEL, "");
    // Said already, in either direction: "storage full" then "QuotaExceededError: storage
    // full" is one fact, and so is the same pair the other way round.
    if (said.some((earlier) => earlier.includes(bare) || bare.includes(earlier))) continue;
    kept.push(line);
    said.push(bare);
  }

  const body = kept.join(" ");
  if (body === "") return name;
  if (name === "") return body;
  return body === name || body.startsWith(`${name}:`) ? body : `${name}: ${body}`;
}
