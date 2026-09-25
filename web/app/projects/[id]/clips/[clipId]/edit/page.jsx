// Editor V3 page (plan §11.2 T2.6, Appendix C): /projects/:id/clips/:clipId/edit.
//
// A 404 unless POTONGIN_EDITOR_V3=on and both ids are well formed (checked before anything runs);
// the proxy already sends anonymous visitors to /login and the session is checked again here.
// POTONGIN_EDITOR_FAKES=1 (dev and CI only) runs the shell on the T1.Z fakes for the e2e specs.
// The editor headers (COOP/COEP, nosniff, frame-ancestors) are set in next.config.mjs (T2.Z).
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import EditorApp from "../../../../../../components/editor/EditorApp.jsx";
import { editorPageMode, validEditorIds } from "../../../../../../components/editor/shell-model.mjs";
import { SESSION_COOKIE, verifySessionToken } from "../../../../../../lib/auth.mjs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Editor klip — Potongin AI", robots: { index: false, follow: false } };

export default async function EditorPage({ params }) {
  const mode = editorPageMode(process.env);
  const { id, clipId } = await params;
  if (mode === "off" || !validEditorIds(id, clipId)) notFound();
  const store = await cookies();
  if (!verifySessionToken(store.get(SESSION_COOKIE)?.value ?? null)) {
    redirect(`/login?next=${encodeURIComponent(`/projects/${id}/clips/${clipId}/edit`)}`);
  }
  return <EditorApp jobId={id} clipId={clipId} runtimeKind={mode} />;
}
