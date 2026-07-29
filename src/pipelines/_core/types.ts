/**
 * Pipeline core types.
 *
 * Key design decisions for extensibility:
 *
 *   - StageKey is `string` (open), NOT a closed union. New stages can be
 *     added in new folders without touching this file.
 *
 *   - InputMode is `string` (open). New workflow types (tutorial, podcast,
 *     news-brief, etc.) can define their own mode without modifying this file.
 *
 *   - WorkflowDefinition is the new top-level concept. Each workflow folder
 *     under src/pipelines/workflows/ exports one. The profile system reads
 *     all registered workflows automatically.
 */

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ProjectState } from "@/lib/store";

// ── Stage ────────────────────────────────────────────────────────────────────

/** Open string key — NOT a closed union. Add new stages freely. */
export type StageKey = string;

/** Open string mode — new workflows can define their own modes. */
export type InputMode = string;

/** A declared input token — surfaces in the token-picker as {{stage.field}}. */
export type StageInputSpec = {
  label: string;
  /** Token expression, e.g. "{{analyze.summary}}". */
  token: string;
  required: boolean;
};

/** A declared output token — other stages can reference these. */
export type StageOutputSpec = {
  label: string;
  type: "text" | "url" | "json" | "blob";
};

/** Per-profile stage configuration (persisted). */
export type StageConfig = {
  enabled: boolean;
  autoRun: boolean;
  inputs: Record<string, string>;
  /** Snapshot of stage-specific settings — shape is opaque to the registry. */
  overrides?: Record<string, unknown>;
};

/** Contract that every pipeline stage must export from its meta.ts file. */
export type StageDefinition = {
  id: StageKey;
  label: string;
  route: string;
  icon: LucideIcon;
  description: string;
  order: number;
  /** Which input modes this stage is relevant to. Leave empty to support all. */
  supportedModes: InputMode[];
  inputs: Record<string, StageInputSpec>;
  outputs: Record<string, StageOutputSpec>;
  /** Optional per-stage settings panel rendered inside the Profile editor. */
  Config?: ComponentType<{ profileId: string }>;
  defaults: StageConfig;
  /** True when this stage produces something for the given project state. */
  hasOutput?: (project: ProjectState) => boolean;
};

// ── Workflow ─────────────────────────────────────────────────────────────────

/**
 * A workflow bundles a set of stages into a named pipeline.
 *
 * To add a new pipeline for a different video script type:
 *   1. Create src/pipelines/workflows/<slug>/workflow.ts
 *   2. Export a WorkflowDefinition
 *   3. Register it in src/pipelines/workflows/index.ts (one import line)
 *
 * Everything else — sidebar, profile picker, command palette, progress bar —
 * auto-discovers the new workflow.
 */
export type WorkflowDefinition = {
  /** Stable unique id, e.g. "youtube-product-review". Never change after creation. */
  id: string;
  /** Display name shown in the profile picker dropdown. */
  name: string;
  /**
   * Input mode this workflow handles. This controls which tab on the home page
   * pre-selects this workflow and which input form is shown.
   *
   * Built-in modes: "youtube" | "amazon" | "analysis"
   * You can define new modes freely — just add a matching input card in index.tsx.
   */
  mode: InputMode;
  /** Ordered stage ids to run in this workflow. */
  stageOrder: StageKey[];
  /** Optional per-stage overrides applied on top of each stage's defaults. */
  stageDefaults?: Partial<Record<StageKey, Partial<StageConfig>>>;
  /** Optional icon shown next to the workflow name. */
  icon?: LucideIcon;
  /** One-line description shown in the profile picker. */
  description?: string;
  /** Built-in workflows cannot be deleted, only duplicated. */
  isBuiltIn?: boolean;
};
