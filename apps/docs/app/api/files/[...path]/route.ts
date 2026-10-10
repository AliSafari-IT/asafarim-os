/** GET /api/files/<path>: an image of the source repository, for someone holding docs.read (#78). */
import { serveImage } from "@/lib/files";
import { gate } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";
import { getSource } from "@/lib/source";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const config = getPlatform().config;
  return serveImage(path.join("/"), {
    gate: () => gate("docs.read"),
    source: () => getSource({ repo: config.getString("source.repo"), branch: config.getString("source.branch") }),
  });
}
