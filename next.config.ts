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

  // 308 redirects for legacy URLs. /strength and /health were collapsed to
  // /metrics sub-pills in Slice 7, but the coach mini-apps restructure (PRs
  // 2-3) brought /strength and /health back as their own routes — those
  // redirects were removed when the new routes shipped to avoid bouncing
  // the new pages back into the old /metrics shell. /diet was never
  // collapsed so it needs no entry here.
  async redirects() {
    return [
      { source: "/trends",          destination: "/metrics?sub=trends",   permanent: true },
      { source: "/trends/:path*",   destination: "/metrics?sub=trends",   permanent: true },
      { source: "/log",             destination: "/metrics?sub=log",      permanent: true },
      // Reserved for Slice 8 (coach trend rename).
      { source: "/coach/trends",        destination: "/coach/progress",       permanent: true },
      { source: "/coach/trends/:path*", destination: "/coach/progress",       permanent: true },
    ];
  },
};

export default nextConfig;
