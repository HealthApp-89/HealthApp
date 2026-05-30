// scripts/strava-subscribe-webhook.mjs — one-shot webhook subscription registration.
// Run via: node --env-file=.env.local scripts/strava-subscribe-webhook.mjs [list|create|delete]
// Default action: list. Requires STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET,
// STRAVA_WEBHOOK_CALLBACK_URL, STRAVA_VERIFY_TOKEN in env.

const action = process.argv[2] ?? "list";
const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_CALLBACK_URL, STRAVA_VERIFY_TOKEN } = process.env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET required");
  process.exit(1);
}

const base = "https://www.strava.com/api/v3/push_subscriptions";
const authQuery = `client_id=${STRAVA_CLIENT_ID}&client_secret=${STRAVA_CLIENT_SECRET}`;

async function list() {
  const r = await fetch(`${base}?${authQuery}`);
  console.log(r.status, await r.text());
}

async function create() {
  if (!STRAVA_WEBHOOK_CALLBACK_URL || !STRAVA_VERIFY_TOKEN) {
    console.error("STRAVA_WEBHOOK_CALLBACK_URL and STRAVA_VERIFY_TOKEN required for create");
    process.exit(1);
  }
  const body = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    callback_url: STRAVA_WEBHOOK_CALLBACK_URL,
    verify_token: STRAVA_VERIFY_TOKEN,
  });
  const r = await fetch(base, { method: "POST", body });
  console.log(r.status, await r.text());
}

async function del() {
  const id = process.argv[3];
  if (!id) { console.error("usage: delete <subscription_id>"); process.exit(1); }
  const r = await fetch(`${base}/${id}?${authQuery}`, { method: "DELETE" });
  console.log(r.status, await r.text());
}

if (action === "list") await list();
else if (action === "create") await create();
else if (action === "delete") await del();
else { console.error("actions: list | create | delete <id>"); process.exit(1); }
