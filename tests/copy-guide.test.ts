import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BANNED_COPY } from "./helpers/banned-copy.ts";
import { parseScreen } from "./screen-catalog/format.ts";
import { SCREENS, variantsFor } from "./screen-catalog/screens.ts";

test("every catalog golden follows the banned-copy guide", async () => {
  const root = join(import.meta.dir, "screen-catalog/goldens");
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".golden")).sort();
  const expected = SCREENS.flatMap(screen => variantsFor(screen).map(variant => `${screen.id}/${variant.id}.golden`)).sort();
  expect(files).toEqual(expected);
  const failures: string[] = [];
  for (const file of files) {
    const screen = parseScreen(await readFile(join(root, file), "utf8"));
    screen.text.forEach((line, index) => {
      for (const { pattern, reason } of BANNED_COPY) if (pattern.test(line))
        failures.push(`${file}: screen ${screen.screen}, variant ${screen.variant}, line ${index + 1}: /${pattern.source}/ (${reason})\n${line}`);
    });
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

test("voice guide and banned-copy patterns cannot drift", async () => {
  const guide = await readFile(join(import.meta.dir, "../docs/voice-and-copy.md"), "utf8");
  const section = guide.split("## Banned patterns\n")[1]?.split("## Reviewer checklist")[0];
  expect(section).toBeDefined();
  const sources = section!.split("\n").filter(line => line.includes("  # ")).map(line => line.split(/\s+# /)[0]!.trim());
  expect(sources.sort()).toEqual(BANNED_COPY.map(({ pattern }) => pattern.source).sort());
});
