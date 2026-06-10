#!/usr/bin/env node
// scripts/audit-time-helpers.mjs
//
// Fixture-based audit for lib/time.ts helpers. No DB access.

import { todayInUserTz, ymdInUserTz } from "../lib/time.ts";
import { currentWeekMonday, recommendationWeekStart, reviewWindow } from "../lib/coach/week.ts";
import { deriveMealSlot } from "../lib/food/meal-slot.ts";

const TZ = {
  utc: "UTC",
  dxb: "Asia/Dubai",
  tyo: "Asia/Tokyo",
  lax: "America/Los_Angeles",
  lon: "Europe/London",
  npt: "Asia/Kathmandu", // +05:45 — half-hour-ish offset
  akl: "Pacific/Auckland",
};

let pass = 0;
let fail = 0;

function assert(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label} — ${detail}`); }
}

// 1. todayInUserTz differs around UTC midnight for Dubai
const utcMidnight = new Date("2026-06-10T00:00:00Z");
assert(
  "Dubai 'today' at UTC midnight is the day after UTC",
  todayInUserTz(utcMidnight, TZ.dxb) === "2026-06-10",
  `got ${todayInUserTz(utcMidnight, TZ.dxb)}`,
);
assert(
  "UTC 'today' at UTC midnight is 2026-06-10",
  todayInUserTz(utcMidnight, TZ.utc) === "2026-06-10",
  `got ${todayInUserTz(utcMidnight, TZ.utc)}`,
);
const lateNightDubai = new Date("2026-06-10T20:30:00Z"); // 00:30 Dubai
assert(
  "Dubai late-night maps to the next day",
  todayInUserTz(lateNightDubai, TZ.dxb) === "2026-06-11",
  `got ${todayInUserTz(lateNightDubai, TZ.dxb)}`,
);

// 2. DST spring forward — London
const dstSpring = new Date("2026-03-29T02:30:00Z");
assert(
  "London handles DST spring-forward without throwing",
  /^\d{4}-\d{2}-\d{2}$/.test(ymdInUserTz(dstSpring, TZ.lon)),
  `got ${ymdInUserTz(dstSpring, TZ.lon)}`,
);

// 3. Half-hour offset — Kathmandu
const ktmMoment = new Date("2026-06-10T18:30:00Z");
assert(
  "Kathmandu (+05:45) crosses midnight correctly",
  todayInUserTz(ktmMoment, TZ.npt) === "2026-06-11",
  `got ${todayInUserTz(ktmMoment, TZ.npt)}`,
);

// 4. Auckland Sunday→Monday boundary
const aklSundayUtc = new Date("2026-06-07T13:00:00Z");
assert(
  "Auckland Sunday-night UTC = Monday local",
  currentWeekMonday(aklSundayUtc, TZ.akl) === "2026-06-08",
  `got ${currentWeekMonday(aklSundayUtc, TZ.akl)}`,
);

// 5. recommendationWeekStart on Sunday returns next Monday
const lonSunday = new Date("2026-06-07T12:00:00Z");
assert(
  "London Sunday → next Monday",
  recommendationWeekStart(lonSunday, TZ.lon) === "2026-06-08",
  `got ${recommendationWeekStart(lonSunday, TZ.lon)}`,
);

// 6. reviewWindow on Monday returns previous Mon-Sun
const dxbMonday = new Date("2026-06-08T08:00:00Z");
const win = reviewWindow(dxbMonday, TZ.dxb);
assert(
  "Monday review window starts on 2026-06-01",
  win.start === "2026-06-01" && win.end === "2026-06-07" && win.mode === "monday-recap",
  `got ${JSON.stringify(win)}`,
);

// 7. Meal slot — 08:00 Dubai is breakfast
const breakfastDxb = new Date("2026-06-10T04:00:00Z");
assert(
  "Meal slot: 08:00 Dubai is breakfast",
  deriveMealSlot(breakfastDxb, TZ.dxb) === "breakfast",
  `got ${deriveMealSlot(breakfastDxb, TZ.dxb)}`,
);

// 8. Same UTC moment in LA is 21:00 previous day → dinner
assert(
  "Same UTC moment in LA is dinner the previous day",
  deriveMealSlot(breakfastDxb, TZ.lax) === "dinner",
  `got ${deriveMealSlot(breakfastDxb, TZ.lax)}`,
);

// 9. Same UTC moment in Tokyo is 13:00 → lunch
assert(
  "Same UTC moment in Tokyo is lunch",
  deriveMealSlot(breakfastDxb, TZ.tyo) === "lunch",
  `got ${deriveMealSlot(breakfastDxb, TZ.tyo)}`,
);

console.log(`\naudit-time-helpers: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
