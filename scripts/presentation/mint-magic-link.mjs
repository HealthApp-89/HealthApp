/**
 * Mints a one-time magic-link login URL for a user via Supabase service role.
 * Used by the presentation pipeline so Playwright can auth without handling
 * the user's password.
 *
 * Run with:
 *   node --env-file=.env.local scripts/presentation/mint-magic-link.mjs
 *
 * Optional flags:
 *   --email <addr>       defaults to abdelouahed.elbied@icloud.com
 *   --redirect <path>    defaults to /
 */
import { createClient } from "@supabase/supabase-js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = arg("app-url", process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const email = arg("email", "abdelouahed.elbied@icloud.com");
const redirectPath = arg("redirect", "/");
const redirectTo = `${APP_URL.replace(/\/$/, "")}${redirectPath.startsWith("/") ? "" : "/"}${redirectPath}`;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase.auth.admin.generateLink({
  type: "magiclink",
  email,
  options: { redirectTo },
});

if (error) {
  console.error("generateLink failed:", error.message);
  process.exit(2);
}

// Print only the action_link to stdout so callers can capture it cleanly
console.log(data?.properties?.action_link ?? "");
