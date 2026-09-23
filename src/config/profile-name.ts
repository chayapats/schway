/** Profile names are filesystem- and CLI-safe identifiers without secrets. */
export const PROFILE_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True when a profile name uses only safe identifier characters. */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

/** True when a base URL is absolute and carries no userinfo or query string. */
export function isValidProfileBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) {
    return false;
  }
  const beforeFragment = url.href.split("#", 1)[0]!;
  if (beforeFragment.includes("?")) {
    return false;
  }
  return true;
}
