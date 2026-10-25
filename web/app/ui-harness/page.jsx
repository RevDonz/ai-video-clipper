// The UI kit's test page (05-ui-dashboard.md §8.1, 08 Fase 1 "Halaman uji"): HeroUI's Button,
// Switch, Tabs, Table, Modal and DatePicker on the Potongin tokens inside the app shell, measured
// by web/e2e/ui-kit.spec.mjs (44 px targets, palette, lime only on the primary button). Dev and
// CI only: a 404 unless POTONGIN_EDITOR_FAKES=1 (the CI/dev switch the e2e suite already sets)
// and the session is valid (the proxy sends anonymous visitors to /login first).
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import AppShell from "../../components/AppShell.jsx";
import { SESSION_COOKIE, verifySessionToken } from "../../lib/auth.mjs";
import UiHarness from "./UiHarness.jsx";

export const dynamic = "force-dynamic";

export const metadata = { title: "Uji komponen", robots: { index: false, follow: false } };

export default async function Page() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  if (process.env.POTONGIN_EDITOR_FAKES !== "1" || !verifySessionToken(token)) notFound();
  return (
    <AppShell>
      <UiHarness />
    </AppShell>
  );
}
