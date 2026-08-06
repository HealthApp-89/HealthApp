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
    <section className="rounded-lg border border-divider">
      <header className="border-b border-divider px-3 py-2 text-xs uppercase tracking-wider text-mid">
        {title}
        {typeof count === "number" && count > 0 && (
          <span className="ml-2 text-muted">{count}</span>
        )}
      </header>
      {count === 0 && empty ? (
        <div className="px-3 py-4 text-xs text-muted">{empty}</div>
      ) : (
        children
      )}
    </section>
  );
}
