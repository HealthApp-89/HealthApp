# Apex Health OS

Personal health & sport performance tracker. Originally a localStorage prototype (`apex-live.jsx`); ported to Next.js + Supabase + Vercel with WHOOP and Apple Health sync.

## Stack

- Next.js 15 (App Router) on Vercel
- Supabase Postgres + Auth + RLS
- WHOOP OAuth 2.0 for daily recovery / sleep / strain sync
- Apple Health via iOS Shortcut → Supabase Edge Function
- Anthropic API (server-side) for coaching insights

## Local development

```bash
cp .env.example .env.local   # then fill in real values
npm install
npm run dev
```

App runs at <http://localhost:3000>.

## Privacy policy

Hosted at `/privacy` on the running app. Static copy in [PRIVACY.md](PRIVACY.md) — used as the WHOOP developer-portal privacy URL until the app is deployed on Vercel.
