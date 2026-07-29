// Central pipeline registry.
//
// To add a new pipeline stage: create src/pipelines/<slug>/meta.ts exporting a
// StageDefinition, then add one import + one entry below. Everything else
// (sidebar, profiles, command palette, next-step CTA) picks it up automatically.

import type { StageDefinition, StageKey } from "./_types";

import analyze from "./analyze/meta";
import transcript from "./transcript/meta";
import frames from "./frames/meta";
import products from "./products/meta";
import commentary from "./commentary/meta";
import script from "./script/meta";
import voiceover from "./voiceover/meta";
import seo from "./seo/meta";
import fairuse from "./fairuse/meta";

export const STAGES: StageDefinition[] = [
  analyze,
  transcript,
  frames,
  products,
  commentary,
  script,
  voiceover,
  seo,
  fairuse,
].sort((a, b) => a.order - b.order);

export const stageById: Record<StageKey, StageDefinition> = STAGES.reduce(
  (acc, s) => {
    acc[s.id] = s;
    return acc;
  },
  {} as Record<StageKey, StageDefinition>,
);

/** All tokens available to a stage that runs after `before` — powers token pickers. */
export function collectAvailableOutputs(before: StageKey): Array<{ token: string; label: string }> {
  const cutoff = stageById[before].order;
  const out: Array<{ token: string; label: string }> = [];
  for (const s of STAGES) {
    if (s.order >= cutoff) continue;
    for (const [key, spec] of Object.entries(s.outputs)) {
      out.push({ token: `{{${s.id}.${key}}}`, label: `${s.label} → ${spec.label}` });
    }
  }
  return out;
}
