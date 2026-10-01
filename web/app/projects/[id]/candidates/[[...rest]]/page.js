// The candidate editor was retired on 2026-09-30. Saved links to it, and to anything under
// /projects/<id>/candidates, land on that project's page instead of a 404.
import { redirect } from "next/navigation.js";

export default async function RetiredCandidatePage({ params }) {
  const { id } = await params;
  redirect(`/projects/${encodeURIComponent(id)}`);
}
