export const metadata = {
  title: "Privacy Policy — Apex Health OS",
};

export default function Privacy() {
  return (
    <main className="min-h-screen p-6 md:p-12">
      <div className="max-w-2xl mx-auto prose prose-invert">
        <h1 className="text-3xl font-semibold mb-2">Privacy Policy</h1>
        <p className="text-white/50 text-sm mb-8">Last updated: 2026-04-30</p>

        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Who this app is for</h2>
          <p className="text-white/70 leading-relaxed">
            Apex Health OS is a personal, single-user health and training tracker. It is operated by
            and for one individual. There are no other users, no sign-ups, and no third-party data
            sharing.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">What data is collected</h2>
          <p className="text-white/70 leading-relaxed">
            With the user&apos;s explicit authorization via OAuth, this app retrieves the following
            data from WHOOP: recovery score, heart rate variability (HRV), resting heart rate,
            sleep performance and stages, and daily strain. From Apple Health (via an iOS Shortcut
            the user installs and runs themselves) it ingests: steps, body weight, body fat, blood
            oxygen, and skin temperature where available. Manually entered workouts (sets, reps,
            weights) and free-text notes are also stored.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Where data is stored</h2>
          <p className="text-white/70 leading-relaxed">
            All data is stored in a private Supabase Postgres database controlled by the
            individual user. Access is protected by Supabase Auth and Postgres row-level security.
            Data is never sold, shared, or transmitted to any third party other than the platform
            providers required to run the app (Supabase for storage, Vercel for hosting,
            Anthropic for AI-generated coaching insights when explicitly requested).
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Retention and deletion</h2>
          <p className="text-white/70 leading-relaxed">
            Data is retained until the user deletes it. The user can revoke WHOOP access at any
            time in their WHOOP account settings, and can wipe the database at any time directly
            in Supabase.
          </p>
        </section>

        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Contact</h2>
          <p className="text-white/70 leading-relaxed">
            For any questions about this policy, contact{" "}
            <a className="text-emerald-300 underline" href="mailto:abdel2.elbied@gmail.com">
              abdel2.elbied@gmail.com
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
