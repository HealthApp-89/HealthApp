"use client";

type Props = {
  sessionType: string;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
};

export function SaveAsDefaultDialog({ sessionType, onConfirm, onCancel, saving }: Props) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 max-w-sm w-full">
        <h3 className="text-base font-semibold text-zinc-50 mb-2">Save your {sessionType} day as your default?</h3>
        <p className="text-sm text-zinc-400 mb-4">
          This will be used the next time you start a {sessionType} session.
          Coach&rsquo;s original plan stays available — reset anytime.
        </p>
        <div className="flex gap-2">
          <button onClick={onConfirm} disabled={saving} className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : `Save as my ${sessionType} day`}
          </button>
          <button onClick={onCancel} disabled={saving} className="flex-1 bg-zinc-800 text-zinc-300 rounded-lg py-2 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
