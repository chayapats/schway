/** Format a count with the singular noun only for one, defaulting to an s-suffixed plural. */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Format milliseconds as tenths below ten seconds, rounded seconds below a minute, or minutes and seconds. */
export function formatDuration(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
