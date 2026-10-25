// The signed-in user as the shell shows it (05-ui-dashboard.md §4.2, §6.1): a name, the initials
// on the account button and the role. Until the user database (Fase 4) there is one user, the
// env login (APP_USERNAME), and they are the admin.

const NAME_LIMIT = 64;

function initialsOf(name) {
  const words = name.split(/[\s._-]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!words.length) return "";
  const letters = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0]).slice(0, 2);
  return letters.join("").toUpperCase();
}

export function shellUser(env = process.env) {
  const name = typeof env?.APP_USERNAME === "string" ? env.APP_USERNAME.trim() : "";
  const displayName = Array.from(name).slice(0, NAME_LIMIT).join("");
  return { displayName, initials: initialsOf(displayName), role: "admin" };
}
