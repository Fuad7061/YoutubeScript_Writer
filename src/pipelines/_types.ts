// Pipeline stage contract.
//
// Each stage under src/pipelines/<slug>/ exports a StageDefinition via meta.ts.
// The central registry (_registry.ts) imports every meta and everything else in
// the app (sidebar, profile editor, token picker, next-step CTA) reads from
// the registry. Adding a new pipeline = new folder + one line in the registry.

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ProjectState } from "@/lib/store";

export type StageKey =
  | "analyze"
  | "transcript"
  | "frames"
  | "products"
  | "commentary"
  | "script"
  | "voiceover"
  | "seo"
  | "fairuse";

export type InputMode = "youtube" | "amazon" | "analysis";

/** Declared input token — surfaces in the token-picker as {{stage.field}}. */
export type StageInputSpec = {
  label: string;
  /** Token expression, e.g. "{{analyze.summary}}". */
  token: string;
  required: boolean;
};

/** Declared output token — other stages can reference these. */
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

export type StageDefinition = {
  id: StageKey;
  label: string;
  route: string;
  icon: LucideIcon;
  description: string;
  order: number;
  supportedModes: InputMode[];
  inputs: Record<string, StageInputSpec>;
  outputs: Record<string, StageOutputSpec>;
  /** Optional per-stage settings panel rendered inside the Profile editor. */
  Config?: ComponentType<{ profileId: string }>;
  defaults: StageConfig;
  /** True when this stage produces something for the given project state. */
  hasOutput?: (project: ProjectState) => boolean;
};
