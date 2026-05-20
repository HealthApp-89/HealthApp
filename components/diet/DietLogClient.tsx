"use client";

import { MealJournalClient } from "@/components/meal/MealJournalClient";

type Props = {
  userId: string;
  date: string;
};

export function DietLogClient({ userId, date }: Props) {
  return <MealJournalClient userId={userId} date={date} />;
}
