"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string>("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError("");
    const supabase = createSupabaseBrowserClient();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    if (error) {
      setStatus("error");
      setError(error.message);
    } else {
      setStatus("sent");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-sm w-full rounded-2xl border border-white/10 bg-white/[0.03] p-8">
        <div className="text-xs uppercase tracking-[0.2em] text-white/30 text-center mb-3">
          APEX HEALTH OS
        </div>
        <h1 className="text-xl font-semibold text-center mb-6">Sign in</h1>

        {status === "sent" ? (
          <p className="text-sm text-emerald-300 leading-relaxed">
            Check your inbox at <span className="font-mono">{email}</span> for a sign-in link.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label className="text-[10px] uppercase tracking-[0.08em] text-white/40">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-emerald-300/50"
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="mt-2 rounded-xl bg-emerald-300/20 border border-emerald-300/40 text-emerald-300 px-4 py-3 text-sm font-bold disabled:opacity-50"
            >
              {status === "sending" ? "Sending…" : "Send magic link"}
            </button>
            {error && <p className="text-sm text-red-400">{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
