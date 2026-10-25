// What the shell needs from the server (components/AppShell.jsx): the user and the features.
// Server pages pass it as props; client pages get it from their segment layout through
// components/ShellData.jsx.
import { shellUser } from "./shell-user.mjs";
import { uiFeatures } from "./ui-features.mjs";

export function shellData(env = process.env) {
  const user = shellUser(env);
  return { user, features: uiFeatures(user, env) };
}
