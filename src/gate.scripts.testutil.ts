/**
 * [GATE-1a] Reading `package.json`'s scripts the way a shell would, for the gate's own guards.
 *
 * §13.5 is a list of commands, not a list of config files. `src/gate.typecheck.test.ts`
 * asserted what `tsconfig.json` contains and `src/gate.mutation.test.ts` what
 * `stryker.config.json` contains, and neither opened `package.json` — so repointing
 * `"typecheck"` at another config moved the program while both stayed green (measured:
 * `tsc --noEmit -p tsconfig.app.json` passed 3 of 3). Both guards need the same small
 * question answered — *which file would this command actually read?* — so the answer lives
 * here once rather than twice (§7 item 5).
 *
 * Deliberately a tokeniser and not a shell. It splits on the operators these scripts use and
 * strips the prefixes they wear; it does not honour quoting, so a step whose command name is
 * inside a quoted string is not recognised. Nothing in this repo's scripts is shaped that way,
 * and the failure mode is a caller this guard does not check rather than a wrong answer about
 * one it does — the enumeration assertions beside each use are what catch a caller going
 * missing.
 */

/** Tokens that stand in front of the real command: a runner, or a `NAME=value` env prefix. */
const PREFIXES = new Set(["bun", "bunx", "npx", "pnpm", "yarn", "run", "exec", "--"]);

/**
 * Every step of a script, tokenised, with runner and env prefixes stripped, so `tokens[0]` is
 * the program being invoked.
 */
export function commandSteps(command: string): string[][] {
  return command
    .split(/&&|\|\||;|(?<!\|)\|(?!\|)/)
    .map((step) => {
      const tokens = step.trim().split(/\s+/).filter(Boolean);
      while (
        tokens.length > 0 &&
        (PREFIXES.has(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))
      ) {
        tokens.shift();
      }
      return tokens;
    })
    .filter((tokens) => tokens.length > 0);
}

/** Whether a tokenised step invokes `program`, however it is spelled on the path. */
export function invokes(tokens: string[], program: string): boolean {
  const name = tokens[0] ?? "";
  return name === program || name.endsWith(`/${program}`);
}

/**
 * The value a step gives to one of `flags`, or `null` when it names none. Accepts both the
 * `--flag value` and `--flag=value` spellings; the last one wins, as it would on a command
 * line.
 */
export function flagValue(tokens: string[], flags: readonly string[]): string | null {
  let found: string | null = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (flags.includes(token)) {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith("-")) found = next;
      index += 1;
      continue;
    }
    for (const flag of flags) {
      if (token.startsWith(`${flag}=`)) found = token.slice(flag.length + 1);
    }
  }
  return found;
}

/** Every positional argument of a step — anything that is neither a flag nor a flag's value. */
export function positionals(tokens: string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (valueFlags.includes(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) out.push(token);
  }
  return out;
}
