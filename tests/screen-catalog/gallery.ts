import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseScreen, type ScreenGolden, type StyleRun } from "./format.ts";

const themes = { dark: { text: "#e6eaf0", background: "#0e1117" }, light: { text: "#1d232c", background: "#f7f7f4" } };
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const ansi = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
function cssColor(color: string, fallback: string): string {
  if (color === "default") return fallback;
  if (!color.startsWith("idx")) return color;
  const n = Number(color.slice(3));
  if (n < 16) return ansi[n]!;
  if (n >= 232) { const c = (8 + (n - 232) * 10).toString(16).padStart(2, "0"); return `#${c}${c}${c}`; }
  const cube = n - 16, levels = [0, 95, 135, 175, 215, 255];
  return `#${[Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6].map(i => levels[i]!.toString(16).padStart(2, "0")).join("")}`;
}
function style(run: StyleRun | undefined, theme: typeof themes.dark, cursor: boolean): string {
  let fg = cssColor(run?.fg ?? "default", theme.text), bg = cssColor(run?.bg ?? "default", theme.background);
  const attrs = run?.attrs ?? "";
  if (attrs.includes("r")) [fg, bg] = [bg, fg];
  const decoration = [attrs.includes("u") ? "underline" : "", attrs.includes("s") ? "line-through" : ""].filter(Boolean).join(" ");
  return `color:${attrs.includes("h") ? "transparent" : fg};background:${bg};${attrs.includes("b") ? "font-weight:700;" : ""}${attrs.includes("i") ? "font-style:italic;" : ""}${attrs.includes("d") ? "opacity:0.6;" : ""}${decoration ? `text-decoration:${decoration};` : ""}${cursor ? "outline:1px solid currentColor;outline-offset:-1px;" : ""}`;
}
function frame(golden: ScreenGolden): string {
  const theme = golden.variant.includes("light") ? themes.light : themes.dark;
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  // OpenTUI exposes terminal cursor positions as one-based coordinates.
  const rows = golden.text.map((text, row) => {
    let column = 0;
    const cells: string[] = [];
    for (const { segment } of segmenter.segment(text)) {
      const width = Bun.stringWidth(segment);
      const run = golden.styles.find(run => run.row === row && column >= run.start && column < run.end);
      cells.push(`<span style="display:inline-block;width:${width}ch;${style(run, theme, golden.cursor.visible && golden.cursor.y - 1 === row && golden.cursor.x - 1 >= column && golden.cursor.x - 1 < column + width)}">${escape(segment)}</span>`);
      column += width;
    }
    while (column < golden.cols) {
      const run = golden.styles.find(run => run.row === row && column >= run.start && column < run.end);
      cells.push(`<span style="${style(run, theme, golden.cursor.visible && golden.cursor.y - 1 === row && golden.cursor.x - 1 === column)}"> </span>`); column++;
    }
    return `<div class="row">${cells.join("")}</div>`;
  });
  return `<figure><figcaption>${escape(golden.variant)} · ${golden.cols}×${golden.rows}</figcaption><div class="terminal" style="color:${theme.text};background:${theme.background};width:${golden.cols}ch">${rows.join("")}</div></figure>`;
}
/** Build an offline gallery solely from the ordered index and parsed golden files. */
export async function buildGallery(directory: string, output: string): Promise<string> {
  const ids = (await readFile(join(directory, "index.txt"), "utf8")).trim().split("\n").filter(Boolean);
  const sections: string[] = [], toc: string[] = [];
  for (const id of ids) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid screen ID: ${id}`);
    const names = (await readdir(join(directory, id))).filter(name => name.endsWith(".golden"));
    const goldens = await Promise.all(names.map(async name => parseScreen(await readFile(join(directory, id, name), "utf8"))));
    const widthOrder = (n: number) => [120, 80, 50].includes(n) ? [120, 80, 50].indexOf(n) : 3 + n;
    goldens.sort((a, b) => Number(a.variant.startsWith("nocolor-")) - Number(b.variant.startsWith("nocolor-")) || widthOrder(a.cols) - widthOrder(b.cols) || Number(a.variant.includes("light")) - Number(b.variant.includes("light")));
    if (!goldens.length) throw new Error(`No goldens for ${id}`);
    const first = goldens[0]!;
    toc.push(`<li><a href="#${id}">${escape(first.title)}</a></li>`);
    const groups = new Map<string, ScreenGolden[]>();
    for (const golden of goldens) { const key = `${golden.variant.startsWith("nocolor-")}-${golden.cols}`; groups.set(key, [...(groups.get(key) ?? []), golden]); }
    sections.push(`<section id="${id}"><h2>${escape(first.title)}</h2><p>${escape(first.description)}</p>${[...groups.values()].map(group => `<div class="grid">${group.map(frame).join("")}</div>`).join("")}</section>`);
  }
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Schway screen catalog</title><style>body{margin:2rem;font-family:system-ui;background:#ddd;color:#222}a{color:#234}section{margin:3rem 0}.grid{display:grid;grid-template-columns:max-content max-content;gap:1rem;overflow:auto}figure{margin:0 0 1rem}figcaption{margin:.5rem 0}.terminal{font:12px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}.row{white-space:pre;height:1.3em}</style><h1>Schway screen catalog</h1><nav><ol>${toc.join("")}</ol></nav>${sections.join("")}</html>\n`;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, html); return resolve(output);
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("Usage: bun tests/screen-catalog/gallery.ts [--out <file>]");
  console.log(await buildGallery(join(import.meta.dir, "goldens"), resolve(args[1] ?? ".scratch/screen-gallery/index.html")));
}
