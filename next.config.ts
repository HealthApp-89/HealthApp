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
};

export default nextConfig;
