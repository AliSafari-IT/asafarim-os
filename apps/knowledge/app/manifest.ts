import type { MetadataRoute } from "next";

/**
 * The web app manifest (served at /manifest.webmanifest): the Linked K icons for "add to home screen" and
 * installed-app launchers (#370). The PNGs live in public/icons/; the favicon (app/icon.svg, app/favicon.ico)
 * and the apple-touch icon (app/apple-icon.png) are picked up by Next's file conventions.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ASafariM Knowledge",
    short_name: "Knowledge",
    description: "Write, learn, and share technical knowledge.",
    start_url: "/",
    display: "standalone",
    theme_color: "#0e7490",
    background_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
