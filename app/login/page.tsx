"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const supabase = createSupabaseBrowserClient();
    const { error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <main style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", background: COLOR.bg }}>
      <Card style={{ width: "100%", maxWidth: "360px", padding: "32px 24px" }}>
        <div style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.2em", color: COLOR.textMuted, textAlign: "center", marginBottom: "12px" }}>
          APEX HEALTH OS
        </div>
        <h1 style={{ fontSize: "20px", fontWeight: 600, textAlign: "center", marginBottom: "24px", color: COLOR.textStrong }}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </h1>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR.textMuted }}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
            style={{
              background: COLOR.surfaceAlt,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.input,
              padding: "8px 12px",
              fontSize: "14px",
              fontFamily: "monospace",
              outline: "none",
              color: COLOR.textStrong,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = COLOR.accent;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = COLOR.divider;
            }}
          />
          <label style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR.textMuted, marginTop: "8px" }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            placeholder="••••••••"
            style={{
              background: COLOR.surfaceAlt,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.input,
              padding: "8px 12px",
              fontSize: "14px",
              fontFamily: "monospace",
              outline: "none",
              color: COLOR.textStrong,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = COLOR.accent;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = COLOR.divider;
            }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: "8px",
              borderRadius: RADIUS.pill,
              padding: "12px 16px",
              fontSize: "14px",
              fontWeight: 700,
              border: "none",
              background: COLOR.accent,
              color: "#fff",
              width: "100%",
              cursor: "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          {error && <p style={{ fontSize: "14px", color: COLOR.danger, marginTop: "8px" }}>{error}</p>}
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError("");
          }}
          style={{
            marginTop: "16px",
            width: "100%",
            fontSize: "12px",
            color: COLOR.textMuted,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textDecoration: "none",
            padding: "8px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = COLOR.textStrong;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = COLOR.textMuted;
          }}
        >
          {mode === "signin" ? "No account? Create one" : "Have an account? Sign in"}
        </button>
      </Card>
    </main>
  );
}
