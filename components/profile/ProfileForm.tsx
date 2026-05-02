"use client";

import { useTransition, useState } from "react";
import { saveProfile } from "@/app/profile/actions";

type Props = {
  initial: {
    name: string | null;
    age: number | null;
    height_cm: number | null;
    goal: string | null;
  };
};

export function ProfileForm({ initial }: Props) {
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);

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

  return (
    <form action={onSubmit} className="flex flex-col gap-3">
      {flash && (
        <div
          className="rounded-[10px] px-3.5 py-2.5 text-xs"
          style={{
            background: flash.startsWith("✗") ? "rgba(255,69,58,0.12)" : "rgba(10,132,255,0.1)",
            border: `1px solid ${flash.startsWith("✗") ? "rgba(255,69,58,0.3)" : "rgba(10,132,255,0.25)"}`,
            color: flash.startsWith("✗") ? "#ff453a" : "#0a84ff",
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
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase tracking-[0.08em] text-white/40">Goal</label>
        <textarea
          name="goal"
          defaultValue={initial.goal ?? ""}
          rows={3}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-white/30 resize-y text-white/80"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="self-end rounded-xl px-5 py-2.5 text-xs font-bold disabled:opacity-50"
        style={{
          background: "rgba(10,132,255,0.15)",
          border: "1px solid #0a84ff55",
          color: "#0a84ff",
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
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-[0.08em] text-white/40">
        {label}
        {unit && <span className="text-white/20 ml-0.5">{unit}</span>}
      </label>
      <input
        name={name}
        type={type}
        step="any"
        defaultValue={defaultValue}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-white/30"
      />
    </div>
  );
}
