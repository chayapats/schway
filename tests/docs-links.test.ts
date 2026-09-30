import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function prose(markdown: string): string {
  let fence: string | undefined;
  return markdown.split("\n").filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))) fence = undefined;
      return false;
    }
    if (marker) { fence = marker; return false; }
    return true;
  }).join("\n");
}

function anchors(markdown: string): Set<string> {
  const result = new Set<string>();
  const lines = prose(markdown).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]
      ?? (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line) ? lines[index - 1] : undefined);
    if (!heading) continue;
    const slug = heading.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "")
      .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, "").replace(/ /g, "-");
    let unique = slug;
    for (let suffix = 1; result.has(unique); suffix++) unique = `${slug}-${suffix}`;
    result.add(unique);
  }
  return result;
}

function linkDestination(markdown: string, start: number): string {
  const angled = markdown[start] === "<";
  let destination = "";
  let depth = 0;
  for (let index = start + (angled ? 1 : 0); index < markdown.length; index++) {
    const character = markdown[index]!;
    const next = markdown[index + 1];
    if (character === "\\" && next && /[!-/:-@\[-`{-~]/.test(next)) {
      destination += next;
      index++;
      continue;
    }
    if (angled) {
      if (character === ">" || character === "\n") break;
    } else {
      if (/\s/.test(character) || character === ")" && depth === 0) break;
      if (character === "(") depth++;
      if (character === ")") depth--;
    }
    destination += character;
  }
  return destination;
}

async function brokenLinks(files: string[]): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    const markdown = prose(await readFile(file, "utf8")).replace(/(`+)[\s\S]*?\1/g, "");
    const destinations = [
      ...markdown.matchAll(/!?\[(?:\\.|[^\]\\\n])*\]\(\s*/g),
      ...markdown.matchAll(/^ {0,3}\[[^\]]+\]:\s*/gm),
    ];
    for (const match of destinations) {
      const destination = linkDestination(markdown, match.index! + match[0].length);
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
      const [path, fragment] = destination.split("#", 2);
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      try {
        if (!(await stat(target)).isFile()) throw new Error("not a file");
        if (fragment && !anchors(await readFile(target, "utf8")).has(decodeURIComponent(fragment))) {
          failures.push(`${file}: ${destination} (missing heading)`);
        }
      } catch {
        failures.push(`${file}: ${destination} (missing file)`);
      }
    }
  }
  return failures;
}

test("relative Markdown links in docs resolve to files and headings", async () => {
  const files = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: resolve(import.meta.dir, "../docs"), absolute: true }));
  expect(files.length).toBeGreaterThan(0);
  expect(await brokenLinks(files)).toEqual([]);
});

test("link checking catches missing files and anchors while respecting Markdown examples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schway-doc-links-"));
  try {
    const source = join(directory, "guide.md");
    await writeFile(join(directory, "other guide.md"), "# Choose a model (API key)\n## ภาษาไทย\n## Repeat\n## Repeat\n");
    await writeFile(join(directory, "guide(v2).md"), "# Version 2\n");
    await writeFile(join(directory, "guide).md"), "# Escaped delimiter\n");
    await writeFile(source, [
      "# Local heading", "[local](#local-heading)",
      "[other](<other%20guide.md#choose-a-model-api-key>)",
      "[unicode](other%20guide.md#ภาษาไทย)", "[duplicate](other%20guide.md#repeat-1)",
      "[balanced](guide(v2).md#version-2)", "[escaped](guide\\).md#escaped-delimiter)",
      "[balanced reference][version]", "[version]: guide(v2).md#version-2",
      "[missing file](absent.md)", "[missing heading](other%20guide.md#absent)",
      "[reference][missing]", "[missing]: absent-reference.md",
      "[external](https://example.test/no-network)", "`[inline example](absent-inline.md)`",
      "```md", "[example](absent-example.md)", "```",
      "~~~md", "[example](absent-tilde.md)", "~~~",
    ].join("\n"));
    expect(await brokenLinks([source])).toEqual([
      `${source}: absent.md (missing file)`,
      `${source}: other%20guide.md#absent (missing heading)`,
      `${source}: absent-reference.md (missing file)`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
