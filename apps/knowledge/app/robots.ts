import type { MetadataRoute } from "next";

/** Public articles may be indexed; the studio and the sign-in plumbing never are. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/studio", "/api/"] }] };
}
