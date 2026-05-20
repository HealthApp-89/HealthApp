import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function MealRedirect({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { date } = await searchParams;
  const dateQs = date ? `&date=${encodeURIComponent(date)}` : "";
  redirect(`/diet?tab=log${dateQs}`);
}
