// The editor page (plan §11.2 T2.6, Appendix C): /projects/:id/clips/:ref/edit, where :ref is the
// clip id or "klip-<n>" for a clip that has no id until its job is prepared (the editor prepares
// it on open; lib/editor/open-clip.mjs).
//
// A 404 unless POTONGIN_EDITOR_V3=on and the job id and clip reference are well formed (checked
// before anything runs); the proxy already sends anonymous visitors to /login and the session is
// checked again here. POTONGIN_EDITOR_FAKES=1 (dev and CI only) runs the shell on the T1.Z fakes
// for the e2e specs. The editor headers (COOP/COEP, nosniff, frame-ancestors) are set in
// next.config.mjs (T2.Z).
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import EditorApp from "../../../../../../components/editor/EditorApp.jsx";
import { editorPageMode } from "../../../../../../components/editor/shell-model.mjs";
import { SESSION_COOKIE, verifySessionToken } from "../../../../../../lib/auth.mjs";
import { readEditorFlags } from "../../../../../../lib/editor/flags.mjs";
import { clipRefFromSegment, editorHref } from "../../../../../../lib/editor/open-clip.mjs";

export const dynamic = "force-dynamic";

export const metadata = { title: "Edit klip · Potongin", robots: { index: false, follow: false } };

export default async function EditorPage({ params }) {
  const mode = editorPageMode(process.env);
  const { id, clipId: segment } = await params;
  const ref = clipRefFromSegment(segment);
  const here = ref ? editorHref(id, ref) : null;
  if (mode === "off" || !here) notFound();
  const store = await cookies();
  if (!verifySessionToken(store.get(SESSION_COOKIE)?.value ?? null)) {
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }
  const flags = readEditorFlags(process.env);
  return <EditorApp jobId={id} clipId={ref.clipId} clipIndex={ref.index} runtimeKind={mode} features={{ uploads: flags.uploads }} />;
}
