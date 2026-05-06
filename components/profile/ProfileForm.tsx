"use client";

import { useState, useTransition, useRef } from "react";
import { saveProfile } from "@/app/profile/actions";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/coach/system-prompts";

type Props = {
  initial: {
    name: string | null;
    age: number | null;
    height_cm: number | null;
    goal: string | null;
    system_prompt: string | null;
  };
};

export function ProfileForm({ initial }: Props) {
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  function onSubmit(formData: FormData) {
    setFlash(null);
    startTransition(async () => {
      try {
        await saveProfile(formData);
        setFlash("✓ Saved");
      } catch (e) {
        setFlash(`✗ ${(e as Error).message}`);
      }
    });
  }

  function restoreDefault() {
    if (promptRef.current) {
      promptRef.current.value = DEFAULT_SYSTEM_PROMPT;
      // Bring focus to the field so the user sees the change happened.
      promptRef.current.focus();
    }
  }

  return (
    <form action={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {flash && (
        <div
          style={{
            borderRadius: RADIUS.input,
            padding: "10px 14px",
            fontSize: "12px",
            background: flash.startsWith("✗") ? COLOR.dangerSoft : COLOR.accentSoft,
            border: `1px solid ${flash.startsWith("✗") ? COLOR.danger + "44" : COLOR.accent + "44"}`,
            color: flash.startsWith("✗") ? COLOR.danger : COLOR.accent,
          }}
        >
          {flash}
        </div>
      )}
      <Field name="name" label="Name" defaultValue={initial.name ?? ""} />
      <Field name="age" label="Age" type="number" defaultValue={initial.age?.toString() ?? ""} />
      <Field
        name="height_cm"
        label="Height"
        unit="cm"
        type="number"
        defaultValue={initial.height_cm?.toString() ?? ""}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: COLOR.textFaint,
            fontWeight: 600,
          }}
        >
          Goal
        </label>
        <textarea
          name="goal"
          defaultValue={initial.goal ?? ""}
          rows={3}
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "10px 12px",
            fontSize: "14px",
            outline: "none",
            resize: "vertical",
            color: COLOR.textStrong,
            fontFamily: "inherit",
          }}
        />
      </div>

      {/* Coach instructions — full system prompt, with Restore Default. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: COLOR.textFaint,
              fontWeight: 600,
            }}
          >
            Coach instructions
          </label>
          <button
            type="button"
            onClick={restoreDefault}
            style={{
              background: "transparent",
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.input,
              padding: "4px 10px",
              fontSize: "10px",
              color: COLOR.textMuted,
              cursor: "pointer",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            Restore default
          </button>
        </div>
        <textarea
          ref={promptRef}
          name="system_prompt"
          defaultValue={initial.system_prompt ?? DEFAULT_SYSTEM_PROMPT}
          rows={12}
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "10px 12px",
            fontSize: "13px",
            lineHeight: 1.5,
            outline: "none",
            resize: "vertical",
            color: COLOR.textStrong,
            fontFamily: "inherit",
          }}
        />
        <div style={{ fontSize: "10px", color: COLOR.textFaint, lineHeight: 1.4 }}>
          Steers the chat coach. The schema explainer (column meanings, tool contracts) is added
          automatically and isn't editable here.
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        style={{
          alignSelf: "flex-end",
          background: COLOR.accent,
          border: "none",
          borderRadius: "12px",
          padding: "10px 20px",
          fontSize: "12px",
          fontWeight: 700,
          color: "#fff",
          cursor: "pointer",
          opacity: pending ? 0.5 : 1,
        }}
      >
        {pending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  unit,
  type = "text",
  defaultValue,
}: {
  name: string;
  label: string;
  unit?: string;
  type?: "text" | "number";
  defaultValue: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: COLOR.textFaint,
          fontWeight: 600,
        }}
      >
        {label}
        {unit && <span style={{ color: COLOR.textFaint, marginLeft: "2px" }}>{unit}</span>}
      </label>
      <input
        name={name}
        type={type}
        step="any"
        defaultValue={defaultValue}
        style={{
          background: COLOR.surfaceAlt,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: RADIUS.input,
          padding: "10px 12px",
          fontSize: "14px",
          fontFamily: "monospace",
          outline: "none",
          color: COLOR.textStrong,
        }}
      />
    </div>
  );
}
