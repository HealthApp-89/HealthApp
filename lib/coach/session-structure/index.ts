// lib/coach/session-structure/index.ts
export { getFatigueTier, tierOf, type FatigueTier } from "./tiers";
export {
  findOrderingWarnings,
  restPrescription,
  rpePrescription,
  repsForExercise,
  type OrderingWarning,
} from "./rules";
export { suggestReorder } from "./reorder";
export {
  annotateSession,
  type AnnotatedExercise,
  type SessionStructure,
} from "./annotate";
