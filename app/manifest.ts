import type { MetadataRoute } from "next";

/** PWA manifest. With this + the icon files in /app, iOS Safari's
 *  Share → Add to Home Screen launches the dashboard full-screen,
 *  no Safari chrome, with the dark theme color in the status bar. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Apex Health OS",
    short_name: "Apex",
    description:
      "Personal health and performance tracker — WHOOP, Withings, Apple Health, Strong, Yazio.",
    start_url: "/",
    scope: "/",
    id: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#080e1a",
    theme_color: "#080e1a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
