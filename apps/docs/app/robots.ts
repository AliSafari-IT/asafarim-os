import type { MetadataRoute } from "next";

/** A private reader (#79): no crawler may read any of it. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
