export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ status: "ok", service: "ai-video-clipper-web" });
}
