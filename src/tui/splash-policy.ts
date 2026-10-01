import type { SplashSetting } from "../config/config.ts";
import type { MotionMode } from "./motion-policy.ts";

/** Decoration selected for one interactive launch; none retains the static top-bar bolt. */
export type SplashPolicy = "full" | "accent" | "none";

/** Resolve startup decoration from user preference, motion, exact installed version and resume intent. */
export function resolveSplash(setting: SplashSetting, motion: MotionMode, seenVersion: string | undefined, installedVersion: string, resume: boolean): SplashPolicy {
  if (motion !== "full" || setting === "never") return "none";
  if (resume) return "accent";
  return setting === "always" || seenVersion !== installedVersion ? "full" : "accent";
}
