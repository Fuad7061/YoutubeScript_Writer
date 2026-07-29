// Prompt Registry
// -----------------------------------------------------------------------------
// Central catalog of every user-editable AI prompt in the app.
//
// Goals:
//   • One place to see, edit, reset every prompt used by the pipeline stages.
//   • Overrides persist in Config.promptOverrides (bag of stringly-keyed
//     entries) so we can add new prompts without changing the store schema.
//   • Two hard-wired prompts (commentary + script) also mirror to their
//     legacy Config fields so existing generators keep reading them
//     unchanged — zero-risk migration.
//   • renderPrompt() fills {{PLACEHOLDER}}s and warns on missing ones,
//     never crashes a run because a user edited badly.
//
// Not a runtime restructure — just a UX surface on top of what's already there.

import type { StageKey } from "@/pipelines/_core/types";
import {
  DEFAULT_COMMENTARY_PROMPT_TEMPLATE,
  DEFAULT_COMMENTARY_PROMPT_TEMPLATE_V2,
  DEFAULT_MIRROR_DERIVE_TEMPLATE,
  DEFAULT_VIDEO_DRAFT_TEMPLATE,
} from "./commentary-script.functions";
import {
  DEFAULT_SCRIPT_PROMPT_TEMPLATE,
  DEFAULT_SCRIPT_PROMPT_TEMPLATE_V2,
} from "./script.functions";
import {
  DEFAULT_FRAME_CAPTION_TEMPLATE,
  DEFAULT_REPORT_MERGE_TEMPLATE,
} from "./analyze.functions";
import { DEFAULT_FRAME_DESCRIBE_TEMPLATE } from "./frames.functions";

import { DEFAULT_PRODUCTS_EXTRACT_TEMPLATE } from "./products.functions";
import { DEFAULT_SEO_COMMENTARY_TEMPLATE, DEFAULT_SEO_REVIEW_TEMPLATE } from "./seo.functions";
import { DEFAULT_FAIRUSE_TEMPLATE } from "./fairuse.functions";
import {
  DEFAULT_VO_ENHANCE_PRODUCT_TEMPLATE,
  DEFAULT_VO_ENHANCE_COMMENTARY_TEMPLATE,
} from "./voiceover.functions";

export type PromptId =
  | "commentary.v1"
  | "commentary.v2"
  | "script.v1"
  | "script.v2"
  | "analyze.frameCaption"
  | "analyze.reportMerge"

  | "analyze.videoDraft"
  | "analyze.mirrorDerive"
  | "frames.describe"
  | "products.extract"
  | "seo.commentary"
  | "seo.review"
  | "fairuse.compliance"
  | "voiceover.enhanceProduct"
  | "voiceover.enhanceCommentary";

/**
 * A prompt is either an "alternate" (user picks one of several versions to be
 * ACTIVE — e.g. commentary v1 vs v2) or a "step" (runs sequentially in a
 * pipeline; every step prompt is always active, only its text is editable).
 */
export type PromptKind = "alternate" | "step";

export type PromptMeta = {
  id: PromptId;
  stage: StageKey;
  kind: PromptKind;
  label: string;
  description: string;
  placeholders: string[];
  getDefault: () => string;
  /** Legacy Config field to mirror to (keeps old readers working). */
  legacyConfigKey?: "commentaryPromptTemplate" | "scriptPromptTemplate";
};

const COMMENTARY_PLACEHOLDERS_V1 = [
  "{{ANGLE}}",
  "{{TONE}}",
  "{{HOOK}}",
  "{{VISUAL_FORMAT}}",
  "{{AUDIENCE}}",
  "{{CREATOR_PERSONA}}",
  "{{TARGET}}",
  "{{LO}}",
  "{{HI}}",
  "{{ROWS_MIN}}",
  "{{ROWS_MAX}}",
  "{{WORD_TARGET}}",
  "{{BRIEF}}",
  "{{MIRROR_MODE}}",
  "{{MIRROR_CONTEXT}}",
  "{{BEAT_MAP}}",
  "{{CLIP_TYPE}}",
  "{{SCENES_BLOCK}}",
];

const COMMENTARY_PLACEHOLDERS_V2 = [
  "{{ANGLE}}",
  "{{TONE}}",
  "{{HOOK}}",
  "{{VISUAL_FORMAT}}",
  "{{AUDIENCE}}",
  "{{CREATOR_PERSONA}}",
  "{{TARGET}}",
  "{{LO}}",
  "{{HI}}",
  "{{ROWS_MIN}}",
  "{{ROWS_MAX}}",
  "{{WORD_TARGET}}",
  "{{BRIEF}}",
  "{{MIRROR_MODE}}",
  "{{MIRROR_CONTEXT}}",
];

const SCRIPT_PLACEHOLDERS = [
  "{{TONE}}",
  "{{FORMAT}}",
  "{{TARGET_AUDIENCE}}",
  "{{PRODUCT_INFO}}",
  "{{COMPETITOR_SCRIPT}}",
  "{{VIDEO_VISUALS}}",
];

export const PROMPTS: PromptMeta[] = [
  {
    id: "commentary.v1",
    stage: "commentary",
    kind: "alternate",
    label: "Commentary — v1 (default)",
    description:
      "Main commentary writer prompt. Controls hook style, mirror mode, SFX/overlay schema, and CapCut column output.",
    placeholders: COMMENTARY_PLACEHOLDERS_V1,
    getDefault: () => DEFAULT_COMMENTARY_PROMPT_TEMPLATE,
    legacyConfigKey: "commentaryPromptTemplate",
  },
  {
    id: "commentary.v2",
    stage: "commentary",
    kind: "alternate",
    label: "Commentary — v2 (legacy alt)",
    description:
      "Alternate commentary template kept for A/B experiments. Load into the active slot from Settings.",
    placeholders: COMMENTARY_PLACEHOLDERS_V2,
    getDefault: () => DEFAULT_COMMENTARY_PROMPT_TEMPLATE_V2,
  },
  {
    id: "script.v1",
    stage: "script",
    kind: "alternate",
    label: "Script — v1 (default)",
    description:
      "Main product-review scriptwriter prompt. Powers YouTube-review and Amazon-listicle profiles.",
    placeholders: SCRIPT_PLACEHOLDERS,
    getDefault: () => DEFAULT_SCRIPT_PROMPT_TEMPLATE,
    legacyConfigKey: "scriptPromptTemplate",
  },
  {
    id: "script.v2",
    stage: "script",
    kind: "alternate",
    label: "Script — v2 (retention-optimized)",
    description:
      "Alternate scriptwriter template — tuned for higher retention. Load into the active slot from Settings.",
    placeholders: SCRIPT_PLACEHOLDERS,
    getDefault: () => DEFAULT_SCRIPT_PROMPT_TEMPLATE_V2,
  },
  {
    id: "analyze.frameCaption",
    stage: "analyze",
    kind: "step",
    label: "Analyze — Frame batch captioner",
    description:
      "Vision prompt that turns each batch of sampled video frames into structured captions + a batch summary. Feeds the Frames tab and the report merge.",
    placeholders: ["{{FRAME_COUNT}}", "{{SOURCE_DESC}}", "{{TIMESTAMPS}}"],
    getDefault: () => DEFAULT_FRAME_CAPTION_TEMPLATE,
  },
  {
    id: "analyze.reportMerge",
    stage: "analyze",
    kind: "step",
    label: "Analyze — Final report merge",
    description:
      "Assembles the summary, scenes, entities, tone, and commentary angles from frame captions + transcript + video draft. Powers the Summary / Scenes / JSON tabs.",
    placeholders: [
      "{{TITLE}}",
      "{{AUTHOR}}",
      "{{PLATFORM}}",
      "{{DURATION}}",
      "{{URL}}",
      "{{FRAMES_BLOCK}}",
      "{{BATCH_BLOCK}}",
      "{{TRANSCRIPT_LABEL}}",
      "{{TRANSCRIPT}}",
      "{{DRAFT_BLOCK}}",
      "{{USER_CORRECTIONS}}",
    ],
    getDefault: () => DEFAULT_REPORT_MERGE_TEMPLATE,
  },
  {
    id: "analyze.videoDraft",
    stage: "analyze",
    kind: "step",
    label: "Analyze — Video draft (Gemini watches the video)",
    description:
      "Prompt Gemini uses to watch the YouTube video end-to-end and produce the Draft ✓ script. Falls back to text-only mode for non-YouTube URLs.",
    placeholders: ["{{EXTRA_INSTRUCTIONS}}"],
    getDefault: () => DEFAULT_VIDEO_DRAFT_TEMPLATE,
  },
  {
    id: "analyze.mirrorDerive",
    stage: "analyze",
    kind: "step",
    label: "Analyze — Mirror knob deriver",
    description:
      "Derives the grounded Mirror-mode angle, tone, hook archetype, length, visual format, and brief addendum from the draft + brief. Runs when Mirror Source Mode is on.",
    placeholders: ["{{DRAFT_MODE_NOTE}}"],
    getDefault: () => DEFAULT_MIRROR_DERIVE_TEMPLATE,
  },
  {
    id: "frames.describe",
    stage: "frames",
    kind: "step",
    label: "Frames — Batch vision captioner",
    description:
      "Vision prompt used by the Frames stage to describe a batch of sampled frames. Output feeds the Frames tab and downstream product / commentary stages.",
    placeholders: ["{{FRAME_COUNT}}", "{{SOURCE_DESC}}", "{{TIMESTAMPS}}"],
    getDefault: () => DEFAULT_FRAME_DESCRIBE_TEMPLATE,
  },
  {
    id: "products.extract",
    stage: "products",
    kind: "step",
    label: "Products — Extractor & researcher",
    description:
      "Reads the frame captions + transcript and returns a structured product list with claims, buyer intent, and evidence quotes.",
    placeholders: ["{{TITLE}}", "{{FRAMES_BLOCK}}", "{{TRANSCRIPT}}"],
    getDefault: () => DEFAULT_PRODUCTS_EXTRACT_TEMPLATE,
  },
  {
    id: "seo.commentary",
    stage: "seo",
    kind: "step",
    label: "SEO — Commentary pack",
    description:
      "Generates curiosity-gap title, description, chapters, and tags for commentary videos (no product list).",
    placeholders: ["{{TITLE}}", "{{SOURCE_INLINE}}", "{{SOURCE_LINK}}", "{{SCRIPT}}"],
    getDefault: () => DEFAULT_SEO_COMMENTARY_TEMPLATE,
  },
  {
    id: "seo.review",
    stage: "seo",
    kind: "step",
    label: "SEO — Product review pack",
    description:
      "Generates SEO title, description, chapters, and tags for product-review videos with a product list.",
    placeholders: ["{{TITLE}}", "{{LINKS_BLOCK}}", "{{SCRIPT}}"],
    getDefault: () => DEFAULT_SEO_REVIEW_TEMPLATE,
  },
  {
    id: "fairuse.compliance",
    stage: "fairuse",
    kind: "step",
    label: "Fair Use — Compliance checker",
    description:
      "Reviews the script + product list for FTC disclosure, fair-use, and platform-policy issues; returns a checklist and suggested edits.",
    placeholders: ["{{SOURCE_LINE}}", "{{CHANNEL_HANDLE}}", "{{PRODUCT_LIST}}", "{{SCRIPT}}"],
    getDefault: () => DEFAULT_FAIRUSE_TEMPLATE,
  },
  {
    id: "voiceover.enhanceProduct",
    stage: "voiceover",
    kind: "step",
    label: "Voiceover — Enhance (Product mode)",
    description:
      "Director prompt that rewrites a product-review script into TTS-ready voice direction with emotion tags.",
    placeholders: ["{{VIBE_LINE}}", "{{ORIGINAL_TEXT}}"],
    getDefault: () => DEFAULT_VO_ENHANCE_PRODUCT_TEMPLATE,
  },
  {
    id: "voiceover.enhanceCommentary",
    stage: "voiceover",
    kind: "step",
    label: "Voiceover — Enhance (Commentary mode)",
    description:
      "Director prompt for commentary scripts. Enforces the Curiosity-Gap hook rule and the Loud Palette (no whisper tags).",
    placeholders: ["{{CONTEXT_BLOCK}}", "{{VIBE_LINE}}", "{{ORIGINAL_TEXT}}"],
    getDefault: () => DEFAULT_VO_ENHANCE_COMMENTARY_TEMPLATE,
  },
];

export const promptById: Record<PromptId, PromptMeta> = PROMPTS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<PromptId, PromptMeta>,
);


export function promptsForStage(stage: StageKey): PromptMeta[] {
  return PROMPTS.filter((p) => p.stage === stage);
}

export function alternatesForStage(stage: StageKey): PromptMeta[] {
  return PROMPTS.filter((p) => p.stage === stage && p.kind === "alternate");
}

export function stepsForStage(stage: StageKey): PromptMeta[] {
  return PROMPTS.filter((p) => p.stage === stage && p.kind === "step");
}

/**
 * Resolve which registered PromptId is the "active" one for a stage, honoring
 * the user's per-stage selection in cfg.activePrompts. Only "alternate" prompts
 * participate — step prompts always run in place and are never "active".
 * Falls back to the first alternate for the stage. Returns null if the stage
 * has no alternates.
 */
export function getActivePromptId(
  cfg: { activePrompts?: Partial<Record<string, string>> },
  stage: StageKey,
): PromptId | null {
  const list = alternatesForStage(stage);
  if (list.length === 0) return null;
  const picked = cfg.activePrompts?.[stage];
  if (picked && list.some((p) => p.id === picked)) return picked as PromptId;
  return list[0].id;
}

/**
 * Resolve a specific registered prompt's text (works for any kind).
 * Priority: user override → personal baseline → factory default.
 */
export function resolvePromptTextById(
  cfg: {
    promptOverrides?: Record<string, string>;
    promptBaselines?: Record<string, string>;
  },
  id: PromptId,
): string {
  const meta = promptById[id];
  const override = cfg.promptOverrides?.[id];
  const baseline = cfg.promptBaselines?.[id];
  const raw =
    (override && override.trim().length > 0 && override) ||
    (baseline && baseline.trim().length > 0 && baseline) ||
    meta.getDefault();
  return normalizePromptPlaceholders(raw);
}

/**
 * Resolve the actual prompt text the runtime should send for a stage.
 * Priority: user override → personal baseline → factory default.
 * Returns undefined if the stage has no registered prompts (caller uses its own default).
 */
export function resolveActivePromptText(
  cfg: {
    activePrompts?: Partial<Record<string, string>>;
    promptOverrides?: Record<string, string>;
    promptBaselines?: Record<string, string>;
  },
  stage: StageKey,
): { id: PromptId; text: string } | undefined {
  const id = getActivePromptId(cfg, stage);
  if (!id) return undefined;
  const meta = promptById[id];
  const override = cfg.promptOverrides?.[id];
  const baseline = cfg.promptBaselines?.[id];
  const raw =
    (override && override.trim().length > 0 && override) ||
    (baseline && baseline.trim().length > 0 && baseline) ||
    meta.getDefault();
  return { id, text: normalizePromptPlaceholders(raw) };
}

// ─────────── Placeholder validation + safe render ───────────

/** Fill {{PLACEHOLDER}} substitutions. Missing → left in-place + warned. */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{([A-Za-z_]+)\}\}/g, (m, key: string) => {
    const upperKey = key.toUpperCase();
    const bracedKey = `{{${upperKey}}}`;
    if (bracedKey in vars) return vars[bracedKey];
    if (upperKey in vars) return vars[upperKey];
    missing.push(bracedKey);
    return bracedKey;
  });
  if (missing.length && typeof console !== "undefined") {
    console.warn("[prompt-registry] unfilled placeholders:", [...new Set(missing)]);
  }
  return { text, missing };
}

/** Normalize legacy/custom placeholders like {{tone}} → {{TONE}} for display + saving. */
export function normalizePromptPlaceholders(template: string): string {
  return template.replace(/\{\{([A-Za-z_]+)\}\}/g, (_m, key: string) => `{{${key.toUpperCase()}}}`);
}

/**
 * Compare an edited template to its default and flag any placeholders that
 * were declared as required but no longer appear in the edited copy.
 * Runtime uses this to decide whether to silently fall back to the default.
 */
export function validateAgainstDefault(
  meta: PromptMeta,
  edited: string,
): { ok: boolean; missing: string[] } {
  // Case-insensitive: legacy overrides saved before the uppercase migration
  // may contain {{tone}}/{{format}} — the runtime resolves those too, so
  // don't flag them as missing.
  const editedUpper = normalizePromptPlaceholders(edited).toUpperCase();
  const missing = meta.placeholders.filter((p) => !editedUpper.includes(p.toUpperCase()));
  return { ok: missing.length === 0, missing };
}
