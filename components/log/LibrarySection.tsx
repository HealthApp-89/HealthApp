"use client";

import type { ReactNode } from "react";

export function LibrarySection({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <section className="rounded-lg border border-zinc-800">
      <header className="border-b border-zinc-900 px-3 py-2 text-xs uppercase tracking-wider text-zinc-400">
        {title}
        {typeof count === "number" && count > 0 && (
          <span className="ml-2 text-zinc-500">{count}</span>
        )}
      </header>
      {count === 0 && empty ? (
        <div className="px-3 py-4 text-xs text-zinc-500">{empty}</div>
      ) : (
        children
      )}
    </section>
  );
}
