// What the shell needs from the server (components/AppShell.jsx): the user, the features and the
// enabled UI languages for the account menu's picker (the client never reads the env). Server
// pages pass it as props; client pages get it from their segment layout through
// components/ShellData.jsx.
import { localeOptions } from "./i18n/locales.mjs";
import { shellUser } from "./shell-user.mjs";
import { uiFeatures } from "./ui-features.mjs";

export function shellData(env = process.env) {
  const user = shellUser(env);
  return { user, features: uiFeatures(user, env), locales: localeOptions(env) };
}
