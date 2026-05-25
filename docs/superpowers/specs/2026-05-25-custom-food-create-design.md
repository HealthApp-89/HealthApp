# Custom food create — design

**Date:** 2026-05-25
**Status:** Approved (brainstorm)
**Surfaces:** `/profile/library`, `MealLoggerSheet` Library tab
**Migrations:** none
**API changes:** none

## Problem

`user_food_items` already supports manually-created single items (`kind='item'`, `source='user_manual'`, `per_100g` macros) and the v1.2 meal-logging chat revamp wired Nora's `save_to_library` tool to write through this path. However there is no user-facing way to create a library item directly. `LibraryClient` is read+delete only; the empty state tells users "Use 'Save to library' in the meal log to add items," which forces them through Nora to seed the library even when they already know the macros (e.g., from a product label whose food isn't in USDA / OFF and which they don't want to log right now).

This spec adds a manual create form, surfaced both on `/profile/library` (proactive curation) and inline inside `MealLoggerSheet` (catch-the-moment-of-need when search misses). It also lowers the entry bar: the user said the minimum acceptable is name + protein + carbs + fat. We compute kcal via Atwater factors when omitted.

## Non-goals

- **Recipe creation** (`composite_of`). Already covered by `save_to_library` from logged meals; manual recipe assembly is a heavier UX (ingredient picker, ratios) and stays deferred.
- **Barcode scanner UI.** Treated as a separate sub-project (sketched at the end of this doc). The backend (`/api/food/barcode` + OFF lookup) is already complete.
- **Editing existing library items.** Out of scope for this arc; the `LibraryClient` page remains read+delete after this ships.

## Form shape

Single component `<CustomFoodForm onSaved={(item) => void} onCancel={() => void} />`. Reused unchanged in both surfaces.

| Field | Required | Notes |
|---|---|---|
| Name | yes | Trim; case-insensitive uniqueness enforced by existing `(user_id, lower(name))` unique index from migration `0030_food_library_dedup.sql` |
| Basis | yes (toggle) | `per_100g` (default) or `per_serving` |
| Serving size (g) | yes if basis=`per_serving` | Used only for client-side back-calculation to `per_100g`; never sent to the server |
| Protein (g) | **yes** | ≥ 0, finite |
| Carbs (g) | **yes** | ≥ 0, finite |
| Fat (g) | **yes** | ≥ 0, finite |
| Fiber (g) | no | Defaults to 0 |
| Calories (kcal) | no | If blank, derived live via Atwater factors: `4·P + 4·C + 9·F`. If user enters a value that diverges from the Atwater estimate by more than 30%, surface an inline soft warning ("kcal looks higher/lower than macros suggest"). Never blocks submit. |
| Notes | no | Free text, max 2000 chars (matches the existing Zod `notes` cap on `POST /api/food/user-items`) |

A live "Per 100g preview" card under the form shows the computed `{kcal, protein_g, carbs_g, fat_g, fiber_g}` per 100g — the exact shape that lands in `user_food_items.per_100g`. This removes mystery about what's stored when the user enters per-serving values.

## Storage basis: per-100g, always

The entire food pipeline (USDA cache, OFF cache, lookup chain in `lib/food/lookup.ts`, `resolveItemMacros`, `macrosForQty`, `sum_food_entries`) keys off `per_100g` macros. Per-serving entry is a UX affordance only. `<CustomFoodForm>` converts to per-100g before POSTing. This keeps the per-100g invariant in one place: the form.

## Atwater derivation

```
kcal_atwater = 4 * protein_g + 4 * carbs_g + 9 * fat_g
```

Helper lives at `lib/food/atwater.ts`:

```ts
export function deriveKcalFromMacros(m: { protein_g: number; carbs_g: number; fat_g: number }): number
```

The form calls it live as the user types. If the user provides their own kcal value (e.g., from a label that includes alcohol or polyols the simple Atwater formula doesn't capture), use the user-provided value verbatim and only surface a soft warning when the divergence exceeds 30%. Alcohol's 7 kcal/g and sugar-alcohol partial values are the most common legitimate reasons for divergence, so we never block.

## Backend: no change

The existing `POST /api/food/user-items` already accepts exactly this shape with `source: "user_manual"`. The client always sends a complete payload (Atwater-derived kcal included), so the server's Zod schema in [app/api/food/user-items/route.ts](../../app/api/food/user-items/route.ts) stays as-is. No migration. No new route. No new env var.

The existing `(user_id, lower(name))` unique index from migration 0030 handles dedup at the DB layer. On 23505 conflict the form catches the error and surfaces an inline message — see Validation below.

## Surface 1 — Manage Library page (`/profile/library`)

[components/profile/LibraryClient.tsx](../../components/profile/LibraryClient.tsx) gains a primary action button at the top of the page:

```
[+ Add custom food]
My Library
Saved foods and recipes. These resolve first when you log meals.
```

Tapping it opens `<CustomFoodForm>` in a `BottomSheet` (using the existing `components/ui/BottomSheet`). On `onSaved`:

1. Close the sheet.
2. Invalidate `queryKeys.userFoodItems.all(userId)`.
3. The new row appears at the top of the list (sorted by `updated_at desc` server-side, which `listLibraryItems` already does).

The current empty-state copy in `LibraryClient` ("Nothing saved yet. Use 'Save to library' in the meal log to add items.") becomes wrong as soon as this ships; replace it with a primary CTA pointing at the new button.

## Surface 2 — MealLoggerSheet Library tab (inline create-and-log)

[components/log/MealLoggerLibraryTab.tsx](../../components/log/MealLoggerLibraryTab.tsx) gains a `[+ Create custom food]` button next to the existing section header. Tapping it opens `<CustomFoodForm>` in a sibling `BottomSheet` from `MealLoggerSheet` (the same pattern `HistoryPickerSheet` uses today: `MealLoggerSheet` holds an `open` state for the sub-sheet and renders both at the top level, so the parent stays mounted under the modal).

On `onSaved`, the form returns the freshly-created `UserFoodItem`. The MealLoggerSheet then **immediately stages it as a candidate** for the current `mealSlot`, defaulting `qty_g` to:

- the entered serving size if the user used the per-serving basis,
- 100g otherwise.

The user adjusts qty if needed, taps Confirm, and the row commits through the existing draft→commit pipeline (`/api/food/draft` → `/api/food/commit`). The new entry lands as `kind='library'` on `food_log_entries` (already in the `kind` allowlist), with the per-item `db_ref.source` reflecting `user_library`.

If the user cancels the inline qty step after the save (closes the inline view), the library row stays. The save and the log are independent commits; cancelling the second doesn't roll back the first.

## Validation

In priority order, with named behaviors:

1. **Name non-empty after trim** → blocks submit. Inline error: "Give your food a name."
2. **P, C, F all finite and ≥ 0** → blocks submit. Inline errors per field.
3. **Fiber ≥ 0 when present** → blocks submit.
4. **Per-serving basis requires serving size > 0** → blocks submit.
5. **Atwater kcal sanity check** → soft warning when user-entered kcal diverges from `4P+4C+9F` by more than 30%. Never blocks.
6. **Server-side 23505 dedup conflict** → friendly inline error: "You already have a '{name}' saved." Render a link to `/profile/library` so the user can find the existing row. (We don't auto-open the existing item because the user may be in the MealLoggerSheet inline flow where that re-route would lose context.)

## Telemetry / observability

`food_log_entries.kind = 'library'` already exists in the v1.1 allowlist from migration 0023. Entries logged via inline-create-then-log land as `kind='library'`, source `user_manual` on the underlying item — same shape as picking a pre-existing library item. No new audit surface needed.

The audit script `scripts/audit-meal-logging-resolve.mjs` already verifies the user-library leg of the resolve chain; manually-created items participate in that without modification.

## Files touched

| File | Change |
|---|---|
| `components/food/CustomFoodForm.tsx` | **new** — the form component, reused in both surfaces |
| `lib/food/atwater.ts` | **new** — `deriveKcalFromMacros({protein_g, carbs_g, fat_g}): number` helper |
| `components/profile/LibraryClient.tsx` | add "+ Add custom food" button, host the BottomSheet, replace empty-state copy |
| `components/log/MealLoggerLibraryTab.tsx` | add inline "+ Create custom food" CTA, stacked-view host, post-save qty step |

No changes to: `app/api/food/user-items/route.ts`, `lib/food/library.ts`, `lib/food/types.ts`, `lib/query/fetchers/userFoodItems.ts`, `lib/query/hooks/useUserFoodItems.ts`, any migration, any cron, any chat tool.

## Future sub-project — barcode scanner

Captured here so the design relationship is explicit, not built in this arc.

**State of the backend:** complete. `/api/food/barcode` does the OFF lookup, inserts a draft `food_log_entries` row with `kind='barcode'`, and returns the product image URL. The route is at [app/api/food/barcode/route.ts](../../app/api/food/barcode/route.ts).

**What's missing:** the camera/scanner UI. Concrete sketch:

- `<BarcodeScanner onScan={(upc) => void} onError={(e) => void}>` wrapping `@zxing/browser` (MIT, ~80KB gzip, mature; scans EAN-8/13 and UPC-A/E in well under a second on iPhone). Camera permission via `navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}})`. iOS PWA-safe since iOS 14.5.
- A third tab inside `MealLoggerSheet`: `Add food` / `Library` / `Scan`.
- On detection: POST `/api/food/barcode`. If 200, jump to the existing qty/confirm step. If 404 (OFF doesn't have this product) → "We couldn't find this product. **Create it manually**" → opens `<CustomFoodForm>` pre-filled with the scanned UPC stored in the `notes` field.

The synergy with this spec: building manual-create first makes the OFF-miss fallback a one-line wire-up. Scope estimate: 1–2 days of focused work, fully isolated from existing surfaces.
