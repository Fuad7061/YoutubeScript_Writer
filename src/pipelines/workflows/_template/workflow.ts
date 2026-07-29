/**
 * TEMPLATE: Copy this to src/pipelines/workflows/<your-slug>/workflow.ts
 * to add a new pipeline workflow.
 *
 * Steps:
 *   1. Fill in the fields below.
 *   2. Import and register in src/pipelines/_core/registry.ts (one line).
 *   3. If you're using a new `mode`, add an input card in src/routes/index.tsx.
 *   4. Done — profile picker, sidebar, and progress bar all auto-update.
 *
 * Available built-in stages:
 *   "analyze"    — vision + audio analysis report
 *   "transcript" — YouTube/video captions
 *   "frames"     — key frame extraction
 *   "products"   — Amazon product matching
 *   "commentary" — viral commentary script
 *   "script"     — full review script
 *   "voiceover"  — TTS audio generation
 *   "seo"        — SEO pack (title, description, tags)
 *   "fairuse"    — fair-use checklist
 *
 * You can also define entirely new stages — see src/pipelines/stages/
 * for examples. Each stage is a folder with meta.ts + a route at src/routes/.
 */

import type { WorkflowDefinition } from "@/pipelines/_core/types";

const workflow: WorkflowDefinition = {
  id: "my-new-workflow",          // CHANGE: unique slug, never change after deploy
  name: "My New Workflow",         // CHANGE: shown in the profile picker
  mode: "youtube",                 // CHANGE: "youtube" | "amazon" | "analysis" | custom
  isBuiltIn: true,                 // set false if user-created
  description: "What this does",   // CHANGE: one-line description
  stageOrder: [                    // CHANGE: which stages to run and in what order
    "transcript",
    "script",
    "voiceover",
    "seo",
  ],
  // Optional: override per-stage defaults for this workflow.
  stageDefaults: {
    script: {
      overrides: {
        tone: "educational",
        format: "step-by-step",
      },
    },
  },
};

export default workflow;
