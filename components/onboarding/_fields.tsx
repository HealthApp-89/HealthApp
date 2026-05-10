"use client";
import type { CSSProperties, ReactNode } from "react";
import { COLOR } from "@/lib/ui/theme";

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: "none", padding: 0, margin: "16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong, paddingBottom: 4 }}>{label}</legend>
      {children}
    </fieldset>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16 }} />
      <span style={{ fontSize: 14 }}>{label}</span>
    </label>
  );
}

export function Select<T extends string>({
  label, value, onChange, options,
}: {
  label: string; value: T; onChange: (v: T) => void; options: Array<[T, string]>;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} style={inputStyle()}>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

export function TextField({
  label, value, onChange, type = "text", placeholder, hint, prefilled,
}: {
  label: string; value: string | number; onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "time";
  placeholder?: string; hint?: string; prefilled?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>
        {label}{prefilled && <span style={{ marginLeft: 6, color: COLOR.accent }}>↻ from latest data</span>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle()}
      />
      {hint && <span style={{ fontSize: 11, color: COLOR.textMuted }}>{hint}</span>}
    </label>
  );
}

export function TextArea({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: COLOR.textMuted }}>{label}</span>
      <textarea
        rows={rows} value={value} onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle(), resize: "vertical", fontFamily: "inherit" }}
      />
    </label>
  );
}

export function inputStyle(extra: CSSProperties = {}): CSSProperties {
  return {
    padding: "8px 10px",
    background: "transparent",
    border: `1px solid ${COLOR.divider}`,
    borderRadius: 8,
    color: COLOR.textStrong,
    fontSize: 14,
    ...extra,
  };
}

export function addBtnStyle(): CSSProperties {
  return {
    padding: "8px 10px",
    background: "transparent",
    border: `1px dashed ${COLOR.divider}`,
    borderRadius: 8,
    color: COLOR.textMuted,
    fontSize: 13,
    cursor: "pointer",
  };
}

export function removeBtnStyle(): CSSProperties {
  return {
    padding: "0 12px",
    background: "transparent",
    border: `1px solid ${COLOR.divider}`,
    borderRadius: 8,
    color: COLOR.textMuted,
    cursor: "pointer",
  };
}
