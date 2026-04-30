# Privacy Policy — Apex Health OS

**Last updated:** 2026-04-30

## Who this app is for

Apex Health OS is a personal, single-user health and training tracker. It is operated by and for one individual. There are no other users, no sign-ups, and no third-party data sharing.

## What data is collected

With the user's explicit authorization via OAuth, this app retrieves the following data from WHOOP: recovery score, heart rate variability (HRV), resting heart rate, sleep performance and stages, and daily strain. From Apple Health (via an iOS Shortcut the user installs and runs themselves) it ingests: steps, body weight, body fat, blood oxygen, and skin temperature where available. Manually entered workouts (sets, reps, weights) and free-text notes are also stored.

## Where data is stored

All data is stored in a private Supabase Postgres database controlled by the individual user. Access is protected by Supabase Auth and Postgres row-level security. Data is never sold, shared, or transmitted to any third party other than the platform providers required to run the app (Supabase for storage, Vercel for hosting, Anthropic for AI-generated coaching insights when explicitly requested).

## Retention and deletion

Data is retained until the user deletes it. The user can revoke WHOOP access at any time in their WHOOP account settings, and can wipe the database at any time directly in Supabase.

## Contact

For any questions about this policy, contact abdel2.elbied@gmail.com.
