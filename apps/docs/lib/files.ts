/**
 * Images of the source repository, served by the app (#78), never from `public/`: the permission is
 * checked first, only images in the current listing can be read, and an SVG can't run script.
 */
import type { GateResult } from "./gate";
import { DocNotFoundError, SourceUnavailableError, type DocSource } from "./source";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};

export async function serveImage(
  filePath: string,
  deps: { gate: () => Promise<GateResult>; source: () => DocSource },
): Promise<Response> {
  const g = await deps.gate();
  if (!g.ok) return Response.json(g.body, { status: g.status, headers: { "cache-control": "no-store" } });
  const type = TYPES[filePath.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!type || filePath.split("/").includes("..")) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const bytes = await deps.source().readImage(filePath);
    return new Response(bytes, {
      headers: {
        "content-type": type,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        // An SVG opened directly is still just a picture: no script, no outside requests.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof DocNotFoundError) return Response.json({ error: "not_found" }, { status: 404 });
    if (err instanceof SourceUnavailableError) {
      return Response.json(
        { error: "source_unavailable", message: "Documents temporarily unavailable" },
        { status: 503 },
      );
    }
    throw err;
  }
}
