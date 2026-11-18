import manifest from "@/platform.app";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, app: "knowledge", version: manifest.version });
}
