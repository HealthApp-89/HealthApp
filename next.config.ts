import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  experimental: {
    // Router cache reuse window. Default in Next 15 is `dynamic: 0`, meaning
    // every back-navigation to a previously-visited page re-runs the server
    // render and re-hits Supabase. Bumping to 30s makes intra-app tab hopping
    // feel instant within the window — the RSC payload is reused from the
    // client cache, no network round-trip — while still keeping data fresh
    // (sync routes call revalidatePath() which evicts the cache anyway).
    //
    // Static segments default to 300s; we leave that alone.
    // Ref: https://nextjs.org/docs/app/api-reference/config/next-config-js/staleTimes
    staleTimes: {
      dynamic: 30,
    },
  },

  // 308 redirects for legacy URLs.
  //
  // Peter Dashboard arc (2026-05-24/25) renamed /metrics → /coach as
  // Peter's canonical home. The prior /coach → /metrics rules were removed
  // because they created an infinite redirect loop with the /metrics page
  // shim that redirects back to /coach. /coach/trends and /coach/weeks/*
  // are real pages and must serve their own content — do not redirect them.
  async redirects() {
    return [
      // Bare-URL bookmarks pointing at the old /metrics surface.
      { source: "/metrics",                 destination: "/coach",                  permanent: true },
      { source: "/metrics/reviews",         destination: "/coach/reviews",          permanent: true },
      { source: "/metrics/weeks/:week_start", destination: "/coach/weeks/:week_start", permanent: true },
      // Slice 7 legacy.
      { source: "/trends",          destination: "/coach",          permanent: true },
      { source: "/trends/:path*",   destination: "/coach",          permanent: true },
      { source: "/log",             destination: "/health?tab=log", permanent: true },
      // PR 4 — /meal page file deleted in PR 6.
      { source: "/meal",            destination: "/diet?tab=log", permanent: true },
      { source: "/meal/:path*",     destination: "/diet?tab=log", permanent: true },
    ];
  },
};

export default nextConfig;
