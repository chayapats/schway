/** Parse standalone version requests before importing setup or session code. */
export function parseVersionCommand(argv: readonly string[]): { help: boolean } | { error: string } | undefined {
  const isVersion = (arg: string) => arg === "--version" || arg === "-V";
  const versions = argv.filter(isVersion);
  if (versions.length === 0) return undefined;
  if (versions.length !== 1 || argv.some(arg => !isVersion(arg) && arg !== "--help" && arg !== "-h")) {
    return { error: "Use --version on its own · Run schway --help for options" };
  }
  return { help: argv.includes("--help") || argv.includes("-h") };
}
