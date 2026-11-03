import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { TIMINGS_PATH, testFiles, type TestTimings } from "./test-shard.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** Decodes the five predefined XML entities and numeric character references. */
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) =>
    entity.startsWith("#x") || entity.startsWith("#X") ? String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      : entity.startsWith("#") ? String.fromCodePoint(Number(entity.slice(1))) : ENTITIES[entity.toLowerCase()]!);
}

/** Reads per-file seconds from one Bun JUnit report: each file-level `<testsuite>` whose name is its file. */
export function parseJunit(xml: string): Map<string, number> {
  const seconds = new Map<string, number>();
  for (const [tag] of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const attributes = new Map([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key!, decode(value!)]));
    const file = attributes.get("file"), name = attributes.get("name"), time = Number(attributes.get("time"));
    if (!file || name !== file || !Number.isFinite(time) || time < 0) continue;
    seconds.set(file, (seconds.get(file) ?? 0) + time);
  }
  return seconds;
}

/**
 * Merges reports into a timing table: the slowest observation per file across reports (so x64 and ARM64
 * runs both count), rounded up to a tenth of a second, limited to `tracked` when given, in sorted key order.
 */
export function mergeTimings(reports: readonly Map<string, number>[], tracked?: readonly string[]): TestTimings {
  const slowest = new Map<string, number>();
  for (const report of reports) for (const [file, time] of report) slowest.set(file, Math.max(slowest.get(file) ?? 0, time));
  const keep = tracked ? new Set(tracked) : undefined;
  return Object.fromEntries([...slowest].filter(([file]) => !keep || keep.has(file))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([file, time]) => [file, Math.ceil(time * 10) / 10]));
}

/** Lists `.xml` files under each path, recursing into directories, in sorted order. */
async function reportPaths(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) {
      for (const entry of await readdir(path, { recursive: true })) if (entry.endsWith(".xml")) found.push(join(path, entry));
    } else found.push(path);
  }
  return found.sort();
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: bun scripts/ci/test-timings.ts <junit.xml or directory>...");
    process.exit(2);
  }
  const files = await reportPaths(paths);
  if (files.length === 0) throw new Error("No JUnit reports found. Download the junit-* artifacts from a checks run first.");
  const reports = await Promise.all(files.map(async file => parseJunit(await Bun.file(file).text())));
  const tracked = testFiles();
  const timings = mergeTimings(reports, tracked);
  const missing = tracked.filter(file => !Object.hasOwn(timings, file));
  await Bun.write(TIMINGS_PATH, `${JSON.stringify(timings, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(timings).length} timings from ${files.length} reports to ${TIMINGS_PATH}.`);
  if (missing.length > 0) console.log(`No timing for ${missing.length} tracked files; they get the default weight:\n${missing.join("\n")}`);
}
