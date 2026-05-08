// lib/morning/tools.ts
//
// Anthropic tool def for the morning intake LLM tail step. Claude can call
// this once per turn to promote symptoms it heard in the user's free text
// into structured columns (e.g. user typed "back is killing me" → emit
// {soreness_areas: ['back'], soreness_severity: 'sharp'}).

import type Anthropic from "@anthropic-ai/sdk";

export const UPDATE_INTAKE_SLOTS_TOOL: Anthropic.Tool = {
  name: "update_intake_slots",
  description:
    "Promote symptoms mentioned in the user's free-text reply into structured " +
    "checkin columns. Only emit slots that are clearly stated. Never guess. " +
    "If the user mentions illness, set sick=true. If they mention a body area " +
    "and intensity, set soreness_areas + soreness_severity. If they mention " +
    "fatigue, set fatigue. Do not call this tool if no symptoms map cleanly.",
  input_schema: {
    type: "object",
    properties: {
      sick: { type: "boolean" },
      sickness_notes: { type: "string" },
      fatigue: { type: "string", enum: ["none", "some", "heavy"] },
      soreness_areas: {
        type: "array",
        items: { type: "string", enum: ["chest", "back", "legs", "shoulders", "arms", "core"] },
      },
      soreness_severity: { type: "string", enum: ["mild", "sharp"] },
      bloating: { type: "boolean" },
    },
  },
};
