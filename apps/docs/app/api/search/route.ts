/** GET /api/search: the ⌘K index (titles, folders and headings), for someone holding docs.read (#80). */
import { gate } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";
import { searchIndex } from "@/lib/search";
import { getSource, SourceUnavailableError } from "@/lib/source";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET() {
  const g = await gate("docs.read");
  if (!g.ok) return Response.json(g.body, { status: g.status, headers: NO_STORE });
  const config = getPlatform().config;
  const source = getSource({ repo: config.getString("source.repo"), branch: config.getString("source.branch") });
  try {
    return Response.json({ docs: await searchIndex(source) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof SourceUnavailableError) {
      return Response.json(
        { error: "source_unavailable", message: "Documents temporarily unavailable" },
        { status: 503, headers: NO_STORE },
      );
    }
    throw err;
  }
}
