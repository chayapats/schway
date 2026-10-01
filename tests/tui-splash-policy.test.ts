import { expect, test } from "bun:test";
import { resolveSplash } from "../src/tui/splash-policy.ts";

test("first-run splash tracks exact versions and resume never covers the conversation", () => {
  expect(resolveSplash("first-run", "full", undefined, "1.2.3", false)).toBe("full");
  expect(resolveSplash("first-run", "full", "1.2.3", "1.2.3", false)).toBe("accent");
  for (const seen of ["1.2.2", "1.2.4"]) expect(resolveSplash("first-run", "full", seen, "1.2.3", false)).toBe("full");
  expect(resolveSplash("always", "full", "1.2.3", "1.2.3", false)).toBe("full");
  for (const setting of ["always", "first-run", "never"] as const) {
    for (const motion of ["full", "reduced", "off"] as const) {
      for (const resume of [false, true]) {
        const actual = resolveSplash(setting, motion, undefined, "1.2.3", resume);
        if (setting === "never" || motion !== "full") expect(actual).toBe("none");
        else expect(actual).toBe(resume ? "accent" : "full");
      }
    }
  }
});
