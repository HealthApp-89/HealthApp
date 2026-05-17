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

  // 308 redirects for the routes consolidated under /metrics in Slice 7.
  // Old URLs collapse to the matching sub-pill so deep-links, PWA shortcuts,
  // and stale bookmarks land on the right surface.
  async redirects() {
    return [
      { source: "/trends",          destination: "/metrics?sub=trends",   permanent: true },
      { source: "/trends/:path*",   destination: "/metrics?sub=trends",   permanent: true },
      { source: "/strength",        destination: "/metrics?sub=strength", permanent: true },
      { source: "/strength/:path*", destination: "/metrics?sub=strength", permanent: true },
      { source: "/health",          destination: "/metrics?sub=body",     permanent: true },
      { source: "/health/:path*",   destination: "/metrics?sub=body",     permanent: true },
      { source: "/log",             destination: "/metrics?sub=strength", permanent: true },
      // Reserved for Slice 8 (coach trend rename).
      { source: "/coach/trends",    destination: "/coach/progress",       permanent: true },
    ];
  },
};

export default nextConfig;
