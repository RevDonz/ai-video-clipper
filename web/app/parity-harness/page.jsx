// Text parity harness (plan §11.1 T1.2b): JASSUB through the editor's text-layer adapter, driven
// by web/e2e/parity-text.spec.mjs. Dev and CI only: a 404 unless POTONGIN_PARITY_HARNESS=1 and
// the session is valid (the proxy already sends anonymous visitors to /login).
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { SESSION_COOKIE, verifySessionToken } from "../../lib/auth.mjs";
import ParityHarness from "./harness-client.jsx";

export const dynamic = "force-dynamic";

export const metadata = { title: "Parity harness", robots: { index: false, follow: false } };

export default async function Page() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  // The same rule as parityHarnessAllowed() in app/api/parity-fixtures/[...path]/route.js.
  if (process.env.POTONGIN_PARITY_HARNESS !== "1" || !verifySessionToken(token)) notFound();
  return <ParityHarness />;
}
