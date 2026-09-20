import type { ToolExecutionResult } from "./types.ts";

/** Error used when an AbortSignal fires during a tool. */
export function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** True for AbortError / ABORT_ERR from streams or AbortSignal. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

/** Map common filesystem failures to model-visible messages. */
export function filesystemError(path: string, error: unknown): string {
  if (isErrno(error, "ENOENT")) {
    return `File not found: ${path}`;
  }
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
    return `Permission denied: ${path}`;
  }
  if (isErrno(error, "EISDIR")) {
    return `Path is a directory: ${path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Bounded tool error for an OS/filesystem failure. */
export function filesystemFailure(
  path: string,
  resolvedPath: string,
  error: unknown,
): ToolExecutionResult {
  return {
    content: filesystemError(path, error),
    isError: true,
    details: { path, resolvedPath },
  };
}

/** Narrow Node/Bun filesystem errors by `code`. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
