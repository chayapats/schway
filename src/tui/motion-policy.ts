/** How much decorative motion the TUI may use; content never depends on it. */
export type MotionMode = "full" | "reduced" | "off";

/** Resolve SCHWAY_MOTION, then reduce motion for NO_COLOR or dumb terminals, defaulting to full. */
export function resolveMotion(env: Record<string, string | undefined>): MotionMode {
  const explicit = env.SCHWAY_MOTION?.trim().toLowerCase();
  if (explicit === "full" || explicit === "reduced" || explicit === "off") return explicit;
  if (env.NO_COLOR || env.TERM === "dumb") return "reduced";
  return "full";
}
