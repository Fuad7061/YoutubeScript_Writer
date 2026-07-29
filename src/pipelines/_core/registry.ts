/**
 * Central pipeline registry.
 *
 * ─── Adding a new STAGE ────────────────────────────────────────────────────
 * 1. Create src/pipelines/stages/<slug>/meta.ts exporting a StageDefinition.
 * 2. Add one import + one entry to the STAGE_DEFINITIONS array below.
 * 3. Add the matching route file at src/routes/<slug>.tsx.
 * 4. Done — sidebar, command palette, token picker, and profile editor all
 *    pick it up automatically.
 *
 * ─── Adding a new WORKFLOW ─────────────────────────────────────────────────
 * 1. Create src/pipelines/workflows/<slug>/workflow.ts exporting a WorkflowDefinition.
 * 2. Add one import + one entry to the WORKFLOW_DEFINITIONS array below.
 * 3. Done — the profile picker and sidebar auto-discover the new workflow.
 *
 * No other files need to change.
 */

import type { StageDefinition, WorkflowDefinition } from "./types";

// ── Stage imports ────────────────────────────────────────────────────────────

import analyze from "../stages/analyze/meta";
import transcript from "../stages/transcript/meta";
import frames from "../stages/frames/meta";
import products from "../stages/products/meta";
import commentary from "../stages/commentary/meta";
import script from "../stages/script/meta";
import voiceover from "../stages/voiceover/meta";
import seo from "../stages/seo/meta";
import fairuse from "../stages/fairuse/meta";

// ── Workflow imports ─────────────────────────────────────────────────────────

import youtubeProductReview from "../workflows/youtube-product-review/workflow";
import amazonListicle from "../workflows/amazon-listicle/workflow";
import anyVideoCommentary from "../workflows/any-video-commentary/workflow";

// ─────────────────────────────────────────────────────────────────────────────
// STAGE DEFINITIONS — order determines sidebar position
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_DEFINITIONS: StageDefinition[] = [
  analyze,
  transcript,
  frames,
  products,
  commentary,
  script,
  voiceover,
  seo,
  fairuse,
];

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOW DEFINITIONS — order determines profile picker order
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  youtubeProductReview,
  amazonListicle,
  anyVideoCommentary,
  // ← Add new workflow imports here. One line. That's it.
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived exports (consumed by the rest of the app)
// ─────────────────────────────────────────────────────────────────────────────

export const STAGES: StageDefinition[] = [...STAGE_DEFINITIONS].sort(
  (a, b) => a.order - b.order,
);

export const stageById: Record<string, StageDefinition> = STAGES.reduce(
  (acc, s) => {
    acc[s.id] = s;
    return acc;
  },
  {} as Record<string, StageDefinition>,
);

export const WORKFLOWS: WorkflowDefinition[] = WORKFLOW_DEFINITIONS;

export const workflowById: Record<string, WorkflowDefinition> = WORKFLOWS.reduce(
  (acc, w) => {
    acc[w.id] = w;
    return acc;
  },
  {} as Record<string, WorkflowDefinition>,
);

/** All token outputs available to a stage that runs after `beforeStageId`. */
export function collectAvailableOutputs(
  beforeStageId: string,
): Array<{ token: string; label: string }> {
  const cutoff = stageById[beforeStageId]?.order ?? Infinity;
  const out: Array<{ token: string; label: string }> = [];
  for (const s of STAGES) {
    if (s.order >= cutoff) continue;
    for (const [key, spec] of Object.entries(s.outputs)) {
      out.push({ token: `{{${s.id}.${key}}}`, label: `${s.label} → ${spec.label}` });
    }
  }
  return out;
}
