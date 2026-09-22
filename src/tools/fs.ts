import { rename, unlink, writeFile } from "node:fs/promises";
import type { ToolExecutionResult } from "./types.ts";

/** Create an Error named AbortError for tool cancellation handling. */
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

/** Wrap a filesystem failure as model-visible error text with supplied and resolved paths in details. */
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

/**
 * Replace `path` by writing a same-directory temporary file and renaming it over the destination.
 * Passes cancellation to the temporary write; failures attempt temporary-file cleanup and propagate.
 */
export async function writeFileAtomically(
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { signal });
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
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
