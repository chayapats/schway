/** Context section name for the per-turn local date; extensions cannot claim it. */
export const LOCAL_DATE_SECTION_NAME = "schway-local-date";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Inputs for one local-date capture; the host offset only applies when no IANA zone resolves. */
export interface LocalDateInput {
  /** Captured instant in milliseconds since the Unix epoch. */
  epochMs: number;
  /** IANA zone name; undefined, empty or unknown names fall back to the host UTC offset. */
  timeZone: string | undefined;
  /** Host offset east of UTC in minutes; defaults to the process's local offset at the instant. */
  hostOffsetMinutes?: (epochMs: number) => number;
}

/** Return the process's resolved IANA zone, or undefined when the runtime cannot name one. */
export function systemTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** Format the local date, weekday, zone and UTC offset with no time of day; never throws, falling back to the host offset alone. */
export function formatLocalDate(input: LocalDateInput): string {
  // On a DST transition day two turns can share a date but report different offsets. That is accepted:
  // the offset is the one in effect at capture, and the date stays the same for the whole local day.
  // A failing host offset reads as UTC+00:00, and a non-finite instant uses the system clock.
  const epochMs = Number.isFinite(input.epochMs) ? input.epochMs : Date.now();
  const zoned = zonedParts(epochMs, input.timeZone);
  if (zoned) {
    return `${dateLine(zoned.year, zoned.month, zoned.day)}\nTime zone: ${zoned.zone} (${formatOffset(zoned.offsetMinutes)})`;
  }
  const offsetMinutes = hostOffset(epochMs, input.hostOffsetMinutes);
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  return `${dateLine(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())}\nTime zone: ${formatOffset(offsetMinutes)}`;
}

/** Resolve wall-clock parts and the offset in effect for a valid IANA zone, or undefined when the zone is unknown. */
function zonedParts(epochMs: number, timeZone: string | undefined) {
  if (!timeZone) return undefined;
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(epochMs)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const { year, month, day, hour, minute, second } = parts;
    if ([year, month, day, hour, minute, second].some(value => value === undefined || !Number.isFinite(value))) return undefined;
    const wall = Date.UTC(year!, month! - 1, day!, hour! % 24, minute!, second!);
    const offsetMinutes = Math.round((wall - Math.floor(epochMs / 1000) * 1000) / 60_000);
    return { year: year!, month: month!, day: day!, offsetMinutes, zone: format.resolvedOptions().timeZone || timeZone };
  } catch {
    return undefined;
  }
}

/** Read the host offset east of UTC, treating failures and nonsense values as UTC. */
function hostOffset(epochMs: number, read: LocalDateInput["hostOffsetMinutes"]): number {
  try {
    const offset = read ? read(epochMs) : -new Date(epochMs).getTimezoneOffset();
    return Number.isFinite(offset) && Math.abs(offset) < 24 * 60 ? Math.round(offset) : 0;
  } catch {
    return 0;
  }
}

/** Render an ISO calendar date with its English weekday. */
function dateLine(year: number, month: number, day: number): string {
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  return `Current date: ${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)} (${weekday})`;
}

/** Render minutes east of UTC as `UTC+HH:MM`. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
