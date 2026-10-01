/** Describe undo I/O failures without exposing raw diagnostics or storage paths in primary copy. */
export function undoFailureReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
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
