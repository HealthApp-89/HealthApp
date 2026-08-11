// lib/coach/session-structure/index.ts
export { getFatigueTier, tierOf, type FatigueTier } from "./tiers";
export {
  findOrderingWarnings,
  restSecondsFor,
  isolationSize,
  rpePrescription,
  repsForExercise,
  REST_SECONDS,
  TRANSITION_BUFFER_SECONDS,
  type OrderingWarning,
} from "./rules";
export { suggestReorder } from "./reorder";
export {
  annotateSession,
  type AnnotatedExercise,
  type SessionStructure,
} from "./annotate";
