import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1])) {
  console.error("Use bun scripts/build-extension-types.ts [--out <dir>].");
  process.exit(1);
}
const out = resolve(root, args[1] ?? "dist/types");
await rm(out, { recursive: true, force: true });
const proc = Bun.spawn([
  resolve(root, "node_modules/.bin/tsc"), "--ignoreConfig", "src/extensions/index.ts",
  "--declaration", "--emitDeclarationOnly", "--outDir", out, "--rootDir", "src",
  "--lib", "ESNext", "--target", "ESNext", "--module", "ESNext",
  "--moduleResolution", "bundler", "--strict", "--skipLibCheck",
  "--allowImportingTsExtensions", "--verbatimModuleSyntax", "--types", "bun",
], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
