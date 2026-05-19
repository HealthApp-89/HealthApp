import React from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MetricsShell } from "./MetricsShell";

export default async function MetricsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return <MetricsShell userId={user.id}>{children}</MetricsShell>;
}
