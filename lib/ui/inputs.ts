import type { FocusEvent } from "react";

/**
 * Select all text on focus. Drop into `<input>` (or `<textarea>`) via
 * `onFocus={selectOnFocus}` so clicking into a pre-populated numeric cell
 * highlights the value — typing replaces it instead of the user having to
 * triple-tap or arrow-select first.
 *
 * Especially useful on touch devices where the cursor-placement default
 * makes editing 60 → 65 a multi-step affair.
 */
export function selectOnFocus(
  e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
) {
  e.currentTarget.select();
}
