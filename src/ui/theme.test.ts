import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("leaves an explicit choice alone whatever the OS prefers", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  // The boolean is `matchMedia("(prefers-color-scheme: dark)").matches`, which is false
  // both when the OS asks for light and when it expresses no preference — §6.1's
  // default is dark, but "no preference" is the OS saying light, so light it is.
  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
