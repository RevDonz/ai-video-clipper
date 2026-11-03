// The signed-in user as the shell shows it (05-ui-dashboard.md §4.2, §6.1): a name, the initials on
// the account button and the role. Without a principal (no user database) it is the env login,
// the admin.

const NAME_LIMIT = 64;

function initialsOf(name) {
  const words = name.split(/[\s._-]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!words.length) return "";
  const letters = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0]).slice(0, 2);
  return letters.join("").toUpperCase();
}

export function shellUser(env = process.env, principal = null) {
  const source = principal?.displayName ?? env?.APP_USERNAME;
  const name = typeof source === "string" ? source.trim() : "";
  const displayName = Array.from(name).slice(0, NAME_LIMIT).join("");
  const user = { displayName, initials: initialsOf(displayName), role: principal?.role ?? "admin" };
  // The break-glass session says so in the account menu (rombak 02 §6.6).
  return principal?.via === "break_glass" ? { ...user, breakGlass: true } : user;
}
