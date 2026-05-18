export function MealLoggerComingSoonTab({ modality }: { modality: "photo" | "voice" }) {
  return (
    <div className="py-8 text-center text-sm text-zinc-500">
      {modality === "photo"
        ? "Photo logging is coming soon — Spec B."
        : "Voice logging is coming soon — Spec C."}
    </div>
  );
}
