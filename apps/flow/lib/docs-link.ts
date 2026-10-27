/**
 * The link to a draft's document in Docs: `<docs.url>/<docPath>`, Docs' address from the app's config
 * (`APP_CONFIG_DOCS_URL`, else the manifest's default; next.config.ts sets the dev gateway's). The
 * path comes from the draft (untrusted): each segment is encoded, and a path that would leave Docs'
 * root (`..`, an empty segment, another origin) gives no link.
 */
import { getPlatform } from "./platform";

export function docsLink(docPath: string, base = getPlatform().config.getString("docs.url")): string | undefined {
  const segments = docPath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  let root: URL;
  try {
    root = new URL(base.endsWith("/") ? base : `${base}/`);
  } catch {
    return undefined;
  }
  if (root.protocol !== "https:" && root.protocol !== "http:") return undefined;
  const url = new URL(segments.map(encodeURIComponent).join("/"), root);
  return url.origin === root.origin && url.pathname.startsWith(root.pathname) ? url.href : undefined;
}
