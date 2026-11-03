import { LOCK_FILE_UNUSABLE } from "../storage/sqlite-file-lock.ts";

/** Describe undo I/O failures without raw diagnostics or internal storage paths in primary copy; a refused lock file keeps its next action. */
export function undoFailureReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  // Schway writes this text itself: it names the lock file to fix and what to do. Callers add the final period.
  if (code === LOCK_FILE_UNUSABLE && error instanceof Error) return error.message.replace(/\.$/, "");
  switch (code) {
    case "EACCES": case "EPERM": return "Permission denied";
    case "ENOSPC": case "EDQUOT": return "No space left on device";
    case "EROFS": return "Read-only filesystem";
    case "ENOENT": return "File not found";
    case "ENOTDIR": return "Path is not a directory";
    case "EISDIR": return "Path is a directory";
    case "EMFILE": case "ENFILE": return "Too many open files";
    case "EIO": return "Could not read or write file";
    default: return "File operation failed";
  }
}
