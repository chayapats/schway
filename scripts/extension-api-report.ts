import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--update")) {
  console.error("Use bun scripts/extension-api-report.ts [--update].");
  process.exit(1);
}
const update = args[0] === "--update";
const temp = await mkdtemp(join(tmpdir(), "schway-extension-api-"));
let exitCode = 1;
try {
  const emit = Bun.spawn([process.execPath, "scripts/build-extension-types.ts", "--out", join(temp, "types")],
    { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await emit.exited !== 0) throw new Error("Declaration build failed. Fix the diagnostics and retry.");
  await mkdir(join(root, "api"), { recursive: true });
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      newlineKind: "lf",
      mainEntryPointFilePath: join(temp, "types/extensions/index.d.ts"),
      compiler: { overrideTsconfig: { compilerOptions: {
        lib: ["ESNext", "DOM"], types: ["bun"], typeRoots: [join(root, "node_modules/@types")],
        strict: true, skipLibCheck: true, module: "ESNext", moduleResolution: "Bundler",
      } } },
      apiReport: { enabled: true, reportFileName: "extensions", reportFolder: join(root, "api"), reportTempFolder: join(temp, "report") },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: { extractorMessageReporting: {
        "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
        "ae-forgotten-export": { logLevel: ExtractorLogLevel.Error },
      } },
    },
    configObjectFullPath: join(root, "api-extractor.json"),
    packageJsonFullPath: join(root, "package.json"),
  });
  const result = Extractor.invoke(config, { localBuild: update });
  exitCode = result.succeeded ? 0 : 1;
  if (!update && result.apiReportChanged) {
    const expected = join(root, "api/extensions.api.md");
    const diff = Bun.spawn(["git", "diff", "--no-index", "--",
      await Bun.file(expected).exists() ? expected : "/dev/null", join(temp, "report/extensions.api.md")],
    { cwd: root, stdout: "inherit", stderr: "inherit" });
    await diff.exited;
    console.error("Update the API report: bun scripts/extension-api-report.ts --update");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await rm(temp, { recursive: true, force: true });
}
process.exit(exitCode);
