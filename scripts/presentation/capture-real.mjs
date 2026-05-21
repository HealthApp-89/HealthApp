/**
 * Captures real screenshots of the deployed Apex Health OS app at iPhone
 * dimensions (390×844 @ 2× DPI). Authentication is done in two steps so we
 * never touch a password:
 *
 *   1. Service role mints a magic-link, exposing properties.hashed_token.
 *   2. We call /auth/v1/verify with type=magiclink&token_hash=... &
 *      grant_type=password... actually the REST flow we use is the
 *      `verifyOtp` JS helper, which gives us an access_token + refresh_token
 *      back.
 *   3. We format them as a supabase-ssr cookie (name = sb-<ref>-auth-token,
 *      value = `base64-<base64url JSON>`) and inject onto the Playwright
 *      context. Middleware reads the cookie like any normal session.
 *
 * Usage:
 *   node --env-file=.env.local scripts/presentation/capture-real.mjs
 */
import playwrightPkg from "/tmp/node_modules/playwright-core/index.js";
const { chromium } = playwrightPkg;

import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "shots-real");
mkdirSync(OUT, { recursive: true });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SITE = (process.env.CAPTURE_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://health-app-delta-ruby.vercel.app").replace(/\/$/, "");
const EMAIL = process.env.CAPTURE_EMAIL || "abdelouahed.elbied@icloud.com";

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

const CHROMIUM = "/Users/abdelouahedelbied/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const PAGES = [
  { name: "dashboard",    path: "/" },
  { name: "log",          path: "/log" },
  { name: "strength",     path: "/strength" },
  { name: "trends",       path: "/trends" },
  { name: "coach",        path: "/coach" },
  { name: "coach-trends", path: "/coach/trends" },
  { name: "profile",      path: "/profile" },
];

function projectRef(url) {
  const m = new URL(url).hostname.match(/^([^.]+)\.supabase\.co$/);
  if (!m) throw new Error(`Cannot extract project ref from ${url}`);
  return m[1];
}

/** base64url-encode a UTF-8 string. */
function b64url(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function mintSession() {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Step 1: admin generates a magic link → we extract hashed_token.
  const gen = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (gen.error) throw gen.error;
  const hashed_token = gen.data?.properties?.hashed_token;
  if (!hashed_token) throw new Error("No hashed_token in generateLink response");

  // Step 2: regular anon client redeems the hashed_token for a session.
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const verify = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: hashed_token,
  });
  if (verify.error) throw verify.error;
  const session = verify.data?.session;
  if (!session) throw new Error("verifyOtp returned no session");
  return session;
}

/**
 * Build the supabase-ssr cookie payload. Format (current @supabase/ssr):
 *   value = "base64-" + base64url(JSON.stringify(session))
 * Chunked into .0, .1, ... if the value exceeds CHUNK_SIZE.
 */
function buildSessionCookies(session, ref, domain) {
  const sessionJson = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type,
    user: session.user,
  };
  const value = "base64-" + b64url(JSON.stringify(sessionJson));
  const name = `sb-${ref}-auth-token`;
  const CHUNK = 3180; // matches @supabase/ssr default

  const cookieBase = {
    domain,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + 60 * 60, // 1h
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  };

  if (value.length <= CHUNK) {
    return [{ ...cookieBase, name, value }];
  }
  const chunks = [];
  for (let i = 0, n = 0; i < value.length; i += CHUNK, n++) {
    chunks.push({ ...cookieBase, name: `${name}.${n}`, value: value.slice(i, i + CHUNK) });
  }
  return chunks;
}

async function main() {
  console.log("Minting session via service role + verifyOtp…");
  const session = await mintSession();
  const ref = projectRef(SUPABASE_URL);
  const domain = new URL(SITE).hostname;
  const cookies = buildSessionCookies(session, ref, domain);
  console.log(`  session for ${session.user.email} — ${cookies.length} cookie chunk(s)`);

  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await context.addCookies(cookies);

  const page = await context.newPage();
  for (const p of PAGES) {
    const url = `${SITE}${p.path}`;
    console.log(`  capturing ${p.name} → ${p.path}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(900);
    // Force scroll to top — server-streamed pages occasionally land mid-page
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const out = resolve(OUT, `${p.name}.png`);
    // Viewport-only (first 844px) — uniform phone-shaped images for slides.
    await page.screenshot({ path: out, fullPage: false });
  }

  await context.close();
  await browser.close();
  console.log(`\nWrote ${PAGES.length} screenshots to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
