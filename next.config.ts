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

  // 308 redirects for legacy URLs from previous restructures. The coach
  // mini-apps restructure (PRs 2-6) moved /strength, /diet, /health onto
  // their own routes and collapsed /coach/* + /meal into /metrics + /diet.
  // Page-level redirects in app/metrics/page.tsx + app/diet/page.tsx +
  // app/health/page.tsx handle ?sub= query-string variants; this block
  // handles bare-URL bookmarks and PWA-cached deep-links.
  async redirects() {
    return [
      // Slice 7 legacy (trends / log catch-alls)
      { source: "/trends",          destination: "/metrics", permanent: true },
      { source: "/trends/:path*",   destination: "/metrics", permanent: true },
      { source: "/log",             destination: "/health?tab=log", permanent: true },
      // PR 4 — /meal page file deleted in PR 6
      { source: "/meal",            destination: "/diet?tab=log", permanent: true },
      { source: "/meal/:path*",     destination: "/diet?tab=log", permanent: true },
      // PR 6 — collapse the entire /coach/* legacy surface into /metrics
      { source: "/coach",                   destination: "/metrics",                 permanent: true },
      { source: "/coach/progress",          destination: "/metrics",                 permanent: true },
      { source: "/coach/progress/:path*",   destination: "/metrics",                 permanent: true },
      { source: "/coach/trends",            destination: "/metrics",                 permanent: true },
      { source: "/coach/trends/:path*",     destination: "/metrics",                 permanent: true },
      { source: "/coach/reviews",           destination: "/metrics/reviews",         permanent: true },
      { source: "/coach/weeks/:week_start", destination: "/metrics/weeks/:week_start", permanent: true },
    ];
  },
};

export default nextConfig;
