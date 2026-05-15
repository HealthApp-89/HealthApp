// lib/ui/constants.ts
//
// UI timing constants. Centralised so toast / debounce / animation durations
// don't drift across surfaces.

/** Auto-dismiss timeout for transient toasts (tap-to-explain, error notices). */
export const TOAST_DISMISS_MS = 3000;

/** Debounce window for chip submit double-tap guards before inFlight state
 *  takes over. */
export const CHIP_SUBMIT_DEBOUNCE_MS = 400;
