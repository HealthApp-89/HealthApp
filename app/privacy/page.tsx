import { COLOR } from "@/lib/ui/theme";

export const metadata = {
  title: "Privacy Policy — Apex Health OS",
};

export default function Privacy() {
  return (
    <main style={{ minHeight: "100dvh", padding: "24px 16px", background: COLOR.bg }}>
      <div style={{ maxWidth: "640px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "32px", fontWeight: 600, marginBottom: "8px", color: COLOR.textStrong }}>Privacy Policy</h1>
        <p style={{ color: COLOR.textMuted, fontSize: "14px", marginBottom: "32px" }}>Last updated: 2026-04-30</p>

        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px", color: COLOR.textStrong }}>Who this app is for</h2>
          <p style={{ color: COLOR.textMid, lineHeight: "1.6" }}>
            Apex Health OS is a personal, single-user health and training tracker. It is operated by
            and for one individual. There are no other users, no sign-ups, and no third-party data
            sharing.
          </p>
        </section>

        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px", color: COLOR.textStrong }}>What data is collected</h2>
          <p style={{ color: COLOR.textMid, lineHeight: "1.6" }}>
            With the user&apos;s explicit authorization via OAuth, this app retrieves the following
            data from WHOOP: recovery score, heart rate variability (HRV), resting heart rate,
            sleep performance and stages, and daily strain. From Apple Health (via an iOS Shortcut
            the user installs and runs themselves) it ingests: steps, body weight, body fat, blood
            oxygen, and skin temperature where available. Manually entered workouts (sets, reps,
            weights) and free-text notes are also stored.
          </p>
        </section>

        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px", color: COLOR.textStrong }}>Where data is stored</h2>
          <p style={{ color: COLOR.textMid, lineHeight: "1.6" }}>
            All data is stored in a private Supabase Postgres database controlled by the
            individual user. Access is protected by Supabase Auth and Postgres row-level security.
            Data is never sold, shared, or transmitted to any third party other than the platform
            providers required to run the app (Supabase for storage, Vercel for hosting,
            Anthropic for AI-generated coaching insights when explicitly requested).
          </p>
        </section>

        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px", color: COLOR.textStrong }}>Retention and deletion</h2>
          <p style={{ color: COLOR.textMid, lineHeight: "1.6" }}>
            Data is retained until the user deletes it. The user can revoke WHOOP access at any
            time in their WHOOP account settings, and can wipe the database at any time directly
            in Supabase.
          </p>
        </section>

        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px", color: COLOR.textStrong }}>Contact</h2>
          <p style={{ color: COLOR.textMid, lineHeight: "1.6" }}>
            For any questions about this policy, contact{" "}
            <a style={{ textDecoration: "underline", color: COLOR.accent }} href="mailto:abdel2.elbied@gmail.com">
              abdel2.elbied@gmail.com
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
