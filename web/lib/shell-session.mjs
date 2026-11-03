// The shell data of the signed-in user, for server layouts and pages (lib/shell-data.mjs).
import { cookies } from "next/headers";

import { sessionFromCookieStore } from "./auth.mjs";
import { shellData } from "./shell-data.mjs";

export async function sessionShellData() {
  return shellData(process.env, sessionFromCookieStore(await cookies()));
}
