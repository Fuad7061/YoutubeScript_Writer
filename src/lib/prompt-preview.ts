// Client-safe live-prompt preview builders.
// ------------------------------------------------------------------
// For every registered PromptId, produce the FINAL string the model
// would receive if generated right now against the current project.
//
// These builders mirror the substitution logic in the corresponding
// server-fn handlers. They intentionally live in a separate file so
// they can be imported from the browser (PromptEditor) without
// pulling any server-only dependency graph.
//
// If you edit a server handler's placeholder substitution, mirror the
// change here too — otherwise the preview drifts from reality.

import type { PromptId } from "./prompt-registry";
import { renderPrompt, resolvePromptTextById } from "./prompt-registry";
import type { Config, ProjectState } from "./store";
import { buildCommentaryPromptPreview } from "./commentary-script.functions";
import { buildScriptPrompt } from "./script.functions";
import { extractVoiceoverText } from "./voiceover-text";

export type LivePromptResult = {
  /** Fully-rendered prompt text (placeholders substituted with real project data). */
  text: string;
  /** Placeholders that could not be resolved from the current project. */
  missing: string[];
  /** Human-readable notes about which sources were used / missing (data ↔ preview transparency). */
  notes: string[];
};

// ─── Placeholder legend ─────────────────────────────────────────────
// Free-form documentation the editor renders in a small popover so
// users can see what each placeholder actually stores at runtime.

export const PLACEHOLDER_DOCS: Record<string, string> = {
  "{{TITLE}}": "Video title (from analysis source or meta).",
  "{{AUTHOR}}": "Video author / channel handle.",
  "{{PLATFORM}}": "Platform label (youtube / tiktok / uploaded etc.).",
  "{{DURATION}}": "Source video duration in seconds.",
  "{{URL}}": "Original source URL.",
  "{{FRAMES_BLOCK}}": "Bulleted list of frame captions with timestamps + on-screen text.",
  "{{BATCH_BLOCK}}": "One-line per-batch scene summaries paired with frame captions.",
  "{{TRANSCRIPT_LABEL}}": "Empty when a transcript exists, ' (not available)' otherwise.",
  "{{TRANSCRIPT}}": "First 6k chars of the spoken transcript.",
  "{{DRAFT_BLOCK}}": "Gemini video-draft block (empty when no draft has been generated).",
  "{{USER_CORRECTIONS}}": "User-authored fact corrections from the Analyze → Corrections panel. Highest-priority evidence — overrides everything else.",
  "{{DRAFT_MODE_NOTE}}": "One-line switch: 'use draft as primary source of truth' vs. 'fall back to summary + scenes'.",
  
  "{{DERIVED_LENGTH}}": "Auto-derived target voice-over length in seconds, based on the source duration.",
  "{{BRIEF}}": "Assembled analysis brief — summary, scenes, entities, transcript excerpt.",
  "{{FRAME_COUNT}}": "Number of frames in the current batch.",
  "{{SOURCE_DESC}}": "Short description of the source, e.g. 'youtube video titled \"…\"'.",
  "{{TIMESTAMPS}}": "Comma-separated timestamps of the batch frames.",
  "{{EXTRA_INSTRUCTIONS}}": "Optional extra guidance appended to the video-draft prompt (includes user corrections when present).",
  "{{ANGLE}}": "Commentary angle — either Mirror-derived or the user's custom override.",
  "{{TONE}}": "Commentary tone — matches Mirror-derived voice register or user pick.",
  "{{HOOK}}": "Hook archetype spec (e.g. 'Roast', 'Absurd Analogy', 'AUTO …').",
  "{{VISUAL_FORMAT}}": "Delivery format (voice-over only / green-screen / PiP / split-screen / talking-head).",
  "{{AUDIENCE}}": "Target-audience descriptor.",
  "{{CREATOR_PERSONA}}": "Static creator persona line used to steer voice.",
  "{{TARGET}}": "Target script length in seconds.",
  "{{LO}}": "Lower length bound (target − 6s).",
  "{{HI}}": "Upper length bound (target + 8s, capped 90s).",
  "{{ROWS_MIN}}": "Minimum table row count for the script.",
  "{{ROWS_MAX}}": "Maximum table row count for the script.",
  "{{WORD_TARGET}}": "Approximate spoken-word target (≈ target × 3).",
  "{{MIRROR_MODE}}": "'on' when Mirror Source Mode is active, 'off' otherwise.",
  "{{MIRROR_CONTEXT}}": "Compact mirror-context block (BEAT_MAP, sympathetic party, must-keep details).",
  "{{CLIP_TYPE}}": "Free-form clip-type label from analysis (karma_justice, wholesome_rescue, tutorial_howto…).",
  "{{SCENES_BLOCK}}": "Numbered scenes block used as the beat map.",
  "{{BEAT_MAP}}": "Ordered beat labels (setup → impact → response → resolution).",
  "{{PRODUCT_INFO}}": "Product list serialized for the script writer.",
  "{{COMPETITOR_SCRIPT}}": "Transcript of a competitor / source video, used as reference.",
  "{{VIDEO_VISUALS}}": "Frame-caption cues the script writer uses for b-roll.",
  "{{FORMAT}}": "Script format (Rapid Listicle / Deep Dive).",
  "{{TARGET_AUDIENCE}}": "Buyer / viewer persona for the script.",
  "{{SCRIPT}}": "The final commentary / review script text.",
  "{{PRODUCT_LIST}}": "Numbered product list with affiliate URLs.",
  "{{LINKS_BLOCK}}": "Same as PRODUCT_LIST — used by the SEO review template.",
  "{{SOURCE_INLINE}}": "Inline source hint appended to the SEO title context.",
  "{{SOURCE_LINK}}": "Trailing source-link phrase for the SEO description.",
  "{{SOURCE_LINE}}": "One-line source citation for the fair-use checker.",
  "{{CHANNEL_HANDLE}}": "Creator channel handle used for FTC disclosure.",
  "{{CONTEXT_BLOCK}}": "Multi-line context for the voice-over enhancer (angle / tone / audience).",
  "{{VIBE_LINE}}": "Optional user vibe line prefixed to the voice-over enhancer.",
  "{{ORIGINAL_TEXT}}": "The current voice-over chunk being enhanced.",
};

// ─── helpers ────────────────────────────────────────────────────────

function clip(s: string | undefined, n: number): string {
  return (s ?? "").slice(0, n);
}

function commentaryData(project: ProjectState, tplOverride?: string) {
  const src = project.analysisSource;
  const vm = project.meta;
  const duration = src?.duration ?? (vm?.duration ? Number(vm.duration) || undefined : undefined);
  const meta = {
    title: src?.title ?? vm?.title,
    author: src?.author ?? vm?.author,
    platform: src?.platform,
    duration,
    sourceUrl: src?.sourceUrl ?? vm?.url ?? project.url,
  };
  const knobs = (project.mirrorKnobs ?? {}) as {
    angle?: string;
    tone?: string;
    hookArchetype?: string;
    visualFormat?: string;
    lengthTargetSec?: number;
    briefAddendum?: string;
  };
  const angle = (project.customAngle?.trim() || knobs.angle || "").trim();
  const tone = (knobs.tone ?? "").trim();
  const mirrorContext = [knobs.briefAddendum, project.customBriefAddendum?.trim()]
    .filter(Boolean)
    .join("\n\n");
  return {
    meta,
    analysis: project.analysis,
    transcript: project.analysisTranscript ?? "",
    videoDraft: project.videoDraft ?? "",
    userCorrections: project.userCorrections ?? "",
    angle,
    tone,
    hookArchetype: (knobs.hookArchetype as "auto" | undefined) ?? "auto",
    visualFormat: knobs.visualFormat,
    lengthTargetSec: knobs.lengthTargetSec,
    mirrorMode: true,
    mirrorContext,
    promptTemplate: tplOverride,
  };
}

function framesBlockFromProject(project: ProjectState): string {
  const caps = project.analysisCaptions ?? [];
  if (caps.length) {
    return caps
      .map((c) => `[${c.t.toFixed(1)}s] ${c.visual}${c.onScreenText ? ` — on-screen: "${c.onScreenText}"` : ""}`)
      .join("\n");
  }
  const fr = project.frames ?? [];
  if (fr.length) {
    return fr
      .map((f, i) => {
        const visible = (f.products_visible ?? []).filter(Boolean).join(", ");
        return `- Frame ${i + 1} [${f.timestamp ?? "?"}${f.scene ? ` · ${f.scene}` : ""}]: ${f.description ?? ""}${visible ? `\n  visible: ${visible}` : ""}`;
      })
      .join("\n");
  }
  return "";
}

function batchBlockFromProject(project: ProjectState): string {
  const b = project.analysisBatchSummaries ?? [];
  return b.map((s, i) => `Batch ${i + 1}: ${s}`).join("\n");
}

function productListBlock(project: ProjectState): string {
  const ps = project.products ?? [];
  if (!ps.length) return "";
  return ps
    .map((p, i) => {
      const url = p.affiliate_url || "(no link)";
      return `${i + 1}. ${p.name} — ${url}`;
    })
    .join("\n");
}

function voiceoverChunk(project: ProjectState, n = 2000): string {
  // Mirror the runtime: enhancer receives project.voiceoverText when present,
  // otherwise the parsed/stripped voiceover column from the script table.
  const raw = (project.voiceoverText?.trim() || extractVoiceoverText(project.script)).trim();
  if (!raw) return "";
  return raw.length > n ? raw.slice(0, n) + "\n… (truncated for preview — enhancer sends the full text)" : raw;
}

// ─── main dispatcher ────────────────────────────────────────────────

export function buildLivePrompt(
  id: PromptId,
  project: ProjectState,
  cfg: Config,
  templateOverride?: string,
): LivePromptResult {
  const template = (templateOverride && templateOverride.trim())
    ? templateOverride
    : resolvePromptTextById(cfg, id);
  const notes: string[] = [];

  switch (id) {
    case "commentary.v1":
    case "commentary.v2": {
      if (!project.analysis && !project.videoDraft) {
        notes.push("no analysis or draft in current project — brief block will be empty");
      }
      if (project.userCorrections?.trim()) notes.push(`user corrections attached (${project.userCorrections.trim().length} chars)`);
      if (project.videoDraft?.trim()) notes.push(`video draft attached (${project.videoDraft.trim().length} chars)`);
      if (project.customAngle?.trim()) notes.push("custom angle override active");
      const text = buildCommentaryPromptPreview(commentaryData(project, template));
      return { text, missing: findMissing(text), notes };
    }

    case "script.v1":
    case "script.v2": {
      const products = project.products ?? [];
      const frames = project.frames ?? [];
      if (!products.length) notes.push("no products loaded — PRODUCT_INFO will use fallback");
      if (!frames.length) notes.push("no frames captured — VIDEO_VISUALS falls back to defaults");
      const text = buildScriptPrompt({
        products,
        amazon: project.amazon,
        frames,
        transcript: project.transcript?.map((s) => s.text).join(" ") ?? "",
        promptTemplate: template,
      } as Parameters<typeof buildScriptPrompt>[0]);
      return { text, missing: findMissing(text), notes };
    }

    case "analyze.frameCaption":
    case "frames.describe": {
      const fr = project.analysisFrames ?? [];
      const meta = project.analysisSource;
      const sourceDesc =
        `${meta?.platform ? meta.platform + " " : ""}video` +
        `${meta?.title ? ` titled "${meta.title}"` : ""}`;
      const timestamps = fr.length ? fr.map((f) => f.t.toFixed(1)).join(", ") : "0.0, 1.0, 2.0";
      if (!fr.length) notes.push("no analysis frames sampled yet — using placeholder timestamps");
      const { text, missing } = renderPrompt(template, {
        "{{FRAME_COUNT}}": String(fr.length || 3),
        "{{SOURCE_DESC}}": sourceDesc,
        "{{TIMESTAMPS}}": timestamps,
      });
      notes.push("(each batch also carries the frame images themselves as vision inputs — not shown here)");
      return { text, missing, notes };
    }

    case "analyze.reportMerge": {
      const meta = project.analysisSource ?? {};
      const framesBlock = framesBlockFromProject(project) || "(none)";
      const batchBlock = batchBlockFromProject(project) || "(none)";
      const draftBlock = project.videoDraft
        ? project.videoDraft.slice(0, 12000)
        : "(no video draft available — fall back to frames + transcript below)";
      const transcript = clip(project.analysisTranscript, 6000) || "(none)";
      const corrections = project.userCorrections?.trim();
      if (project.videoDraft?.trim()) notes.push(`draft attached (${project.videoDraft.trim().length} chars, sliced to 12k)`);
      else notes.push("no video draft — merge will fall back to frames + transcript");
      if (corrections) notes.push(`user corrections attached (${corrections.length} chars, HIGHEST priority)`);
      const { text, missing } = renderPrompt(template, {
        "{{TITLE}}": meta.title ?? "(none)",
        "{{AUTHOR}}": meta.author ?? "(none)",
        "{{PLATFORM}}": meta.platform ?? "(unknown)",
        "{{DURATION}}": meta.duration ? meta.duration.toFixed(1) + "s" : "(unknown)",
        "{{URL}}": meta.sourceUrl ?? "(none)",
        "{{FRAMES_BLOCK}}": framesBlock,
        "{{BATCH_BLOCK}}": batchBlock,
        "{{TRANSCRIPT_LABEL}}": project.analysisTranscript ? "" : " (not available)",
        "{{TRANSCRIPT}}": transcript,
        "{{DRAFT_BLOCK}}": draftBlock,
        "{{USER_CORRECTIONS}}": corrections ? corrections.slice(0, 4000) : "(none)",
      });
      return { text, missing, notes };
    }

    case "analyze.videoDraft": {
      const corrections = project.userCorrections?.trim();
      const extra = corrections
        ? `\n\n=== USER CORRECTIONS (HIGHEST PRIORITY — OVERRIDES EVERYTHING YOU SEE OR HEAR IN THE VIDEO ON ANY CONFLICT. Treat each sentence below as a verified fact from the creator. If what you observe contradicts a correction, silently defer to the correction and write the draft accordingly.) ===\n${corrections.slice(0, 4000)}`
        : "";
      if (corrections) notes.push(`user corrections appended (${corrections.length} chars)`);
      else notes.push("no user corrections — {{EXTRA_INSTRUCTIONS}} resolves to empty string");
      notes.push("(the actual YouTube video is attached as a file_data part on the wire — not shown here)");
      const text = template.replace(/\{\{EXTRA_INSTRUCTIONS\}\}/gi, extra);
      return { text, missing: findMissing(text), notes };
    }

    case "analyze.mirrorDerive": {
      const draft = (project.videoDraft ?? "").trim();
      const corrections = (project.userCorrections ?? "").trim();
      const scenes = project.analysis?.scenes ?? [];
      const summary = project.analysis?.summary ?? "";
      const briefBase =
        summary || scenes.length
          ? [
              summary && `=== SUMMARY ===\n${summary}`,
              scenes.length &&
                `=== SCENES ===\n${scenes.map((s, i) => `#${i + 1} [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.visual}${s.onScreenText ? ` | on-screen: "${s.onScreenText}"` : ""} | takeaway: ${s.keyTakeaway}`).join("\n")}`,
            ]
              .filter(Boolean)
              .join("\n\n")
          : "";
      const brief = corrections
        ? `=== USER CORRECTIONS (HIGHEST PRIORITY — OVERRIDES SUMMARY / SCENES / DRAFT ON ANY CONFLICT.) ===\n${corrections.slice(0, 4000)}\n\n${briefBase}`
        : briefBase;
      const srcDur = project.analysisSource?.duration;
      const derived = srcDur ? Math.max(5, Math.round(srcDur)) : 35;
      const draftModeNote = draft
        ? "Use the DRAFT below as your primary source of truth (it was written by a model that watched the actual video)."
        : "NO draft is attached — fall back to SUMMARY + SCENES + on-screen text in the brief.";
      const draftBlock = draft
        ? `===========================================\nDRAFT SCRIPT (Gemini watched the video — PRIMARY source of truth)\n===========================================\n${draft.slice(0, 6000)}\n`
        : "";
      if (draft) notes.push(`draft attached (${draft.length} chars)`);
      else notes.push("no draft — mirror deriver will use summary + scenes only");
      if (corrections) notes.push(`user corrections attached (${corrections.length} chars, HIGHEST priority)`);
      const { text, missing } = renderPrompt(template, {
        "{{DRAFT_MODE_NOTE}}": draftModeNote,
        "{{DERIVED_LENGTH}}": String(derived),
        "{{BRIEF}}": brief || "(none)",
        "{{DRAFT_BLOCK}}": draftBlock,
      });
      return { text, missing, notes };
    }

    case "products.extract": {
      const framesBlock = framesBlockFromProject(project);
      const transcriptText = project.transcript?.map((s) => s.text).join(" ") ?? project.analysisTranscript ?? "";
      if (!transcriptText.trim()) notes.push("no transcript — extractor will refuse");
      if (framesBlock) notes.push(`${(project.frames ?? project.analysisCaptions ?? []).length} frame(s) attached as evidence`);
      const framesSection = framesBlock
        ? `VISUAL EVIDENCE FROM FRAMES (supporting context only):\n${framesBlock}\n\n`
        : "";
      const { text, missing } = renderPrompt(template, {
        "{{TITLE}}": project.meta?.title ?? project.analysisSource?.title ?? "(unknown)",
        "{{FRAMES_BLOCK}}": framesSection,
        "{{TRANSCRIPT}}": transcriptText.slice(0, 50000) || "(no transcript loaded)",
      });
      return { text, missing, notes };
    }

    case "seo.commentary": {
      const script = project.script?.trim() ?? "";
      if (!script) notes.push("no script generated yet — SCRIPT will be empty");
      const meta = project.analysisSource ?? project.meta;
      const { text, missing } = renderPrompt(template, {
        "{{TITLE}}": meta?.title ?? "(untitled)",
        "{{SOURCE_INLINE}}": project.url ? ` (source: ${project.url})` : "",
        "{{SOURCE_LINK}}": project.url ? ` (link: ${project.url})` : "",
        "{{SCRIPT}}": script.slice(0, 8000) || "(no script)",
      });
      return { text, missing, notes };
    }

    case "seo.review": {
      const script = project.script?.trim() ?? "";
      const linksBlock = productListBlock(project);
      if (!script) notes.push("no script generated yet");
      if (!linksBlock) notes.push("no products loaded — LINKS_BLOCK will be empty");
      const { text, missing } = renderPrompt(template, {
        "{{TITLE}}": project.meta?.title ?? "(untitled)",
        "{{LINKS_BLOCK}}": linksBlock || "(none)",
        "{{SCRIPT}}": script.slice(0, 8000) || "(no script)",
      });
      return { text, missing, notes };
    }

    case "fairuse.compliance": {
      const src = project.analysisSource;
      const vm = project.meta;
      const title = src?.title ?? vm?.title;
      const author = src?.author ?? vm?.author;
      const sourceUrl = src?.sourceUrl ?? vm?.url ?? project.url;
      const sourceLine = sourceUrl
        ? `${title ?? "source video"} by ${author ?? "original creator"} (${sourceUrl})`
        : `${title ?? "source video"} by ${author ?? "original creator"}`;
      const productList = productListBlock(project) || "(none)";
      const script = project.script?.trim() ?? "";
      if (!script) notes.push("no script yet");
      const { text, missing } = renderPrompt(template, {
        "{{SOURCE_LINE}}": sourceLine,
        "{{CHANNEL_HANDLE}}": "@yourchannel",
        "{{PRODUCT_LIST}}": productList,
        "{{SCRIPT}}": script.slice(0, 4000) || "(no script)",
      });
      return { text, missing, notes };
    }

    case "voiceover.enhanceProduct":
    case "voiceover.enhanceCommentary": {
      const chunk = voiceoverChunk(project);
      const isCommentary = id === "voiceover.enhanceCommentary";
      if (!chunk) notes.push("no voiceover text yet — ORIGINAL_TEXT will be empty");
      else notes.push(`voiceover text attached (${chunk.length} chars) — enhancer sends the full text in one request`);
      const knobs = (project.mirrorKnobs ?? {}) as { angle?: string; tone?: string };
      const angle = project.customAngle?.trim() || knobs.angle || project.selectedAngle || "";
      const tone = knobs.tone || project.selectedTone || "";
      const audience = project.analysis?.targetAudience ?? "";
      const contextLines = isCommentary
        ? [
            angle && `Angle: ${angle}`,
            tone && `Tone: ${tone}`,
            audience && `Audience: ${audience}`,
          ].filter(Boolean)
        : [];
      const contextBlock = contextLines.length ? `Creator context:\n${contextLines.join("\n")}\n\n` : "";
      const vibe = cfg.voiceover?.instructions?.trim() ?? "";
      const vibeLine = vibe
        ? (isCommentary
            ? `User's overall vibe (respect if compatible with LOUD commentary — if it asks for whisper/ASMR/quiet, override it because the delivery target is loud faceless-video commentary): ${vibe}\n\n`
            : `User's overall vibe (respect if compatible with LOUD retail-hype — if it asks for whisper/ASMR/quiet, override it because the delivery target is loud faceless-video commerce): ${vibe}\n\n`)
        : "";
      if (vibe) notes.push(`vibe line derived from Voice direction (${vibe.length} chars)`);
      if (!isCommentary) notes.push("product mode — CONTEXT_BLOCK is not used by this template");
      const { text, missing } = renderPrompt(template, {
        "{{CONTEXT_BLOCK}}": contextBlock,
        "{{VIBE_LINE}}": vibeLine,
        "{{ORIGINAL_TEXT}}": chunk || "(no voiceover text yet)",
      });
      return { text, missing, notes };
    }

    default: {
      // Fallback: return template unresolved with a hint.
      return {
        text: template,
        missing: findMissing(template),
        notes: ["no preview builder registered for this prompt — showing raw template"],
      };
    }
  }
}

function findMissing(rendered: string): string[] {
  const set = new Set<string>();
  rendered.replace(/\{\{([A-Za-z_]+)\}\}/g, (_m, k: string) => {
    set.add(`{{${k.toUpperCase()}}}`);
    return "";
  });
  return [...set];
}

// ─── segmentation for colored live-prompt preview ──────────────────
// Diffs the raw template against the fully-rendered text so the UI can
// highlight exactly which spans came from placeholder substitution.

export type PromptSegment =
  | { kind: "literal"; text: string }
  | { kind: "value"; text: string; placeholder: string }
  | { kind: "unresolved"; text: string; placeholder: string }
  | { kind: "extra"; text: string };

export function segmentRenderedPrompt(template: string, rendered: string): PromptSegment[] {
  const parts = template.split(/(\{\{[A-Za-z0-9_]+\}\})/g).filter((p) => p !== "");
  const segments: PromptSegment[] = [];
  let cursor = 0;
  let pendingPh: string | null = null;
  const isPh = (s: string) => /^\{\{[A-Za-z0-9_]+\}\}$/.test(s);

  for (const part of parts) {
    if (isPh(part)) {
      pendingPh = `{{${part.slice(2, -2).toUpperCase()}}}`;
      continue;
    }
    const idx = rendered.indexOf(part, cursor);
    if (idx === -1) {
      // literal from template not found — dump remainder as best-effort value
      const rest = rendered.slice(cursor);
      if (rest) {
        if (pendingPh) segments.push({ kind: "value", text: rest, placeholder: pendingPh });
        else segments.push({ kind: "extra", text: rest });
      }
      cursor = rendered.length;
      pendingPh = null;
      continue;
    }
    if (idx > cursor) {
      const between = rendered.slice(cursor, idx);
      if (pendingPh) {
        const unresolved = between === pendingPh;
        segments.push({
          kind: unresolved ? "unresolved" : "value",
          text: between,
          placeholder: pendingPh,
        });
      } else {
        segments.push({ kind: "extra", text: between });
      }
    } else if (pendingPh) {
      segments.push({ kind: "value", text: "", placeholder: pendingPh });
    }
    segments.push({ kind: "literal", text: part });
    cursor = idx + part.length;
    pendingPh = null;
  }
  if (cursor < rendered.length) {
    const rest = rendered.slice(cursor);
    if (pendingPh) {
      const unresolved = rest === pendingPh;
      segments.push({
        kind: unresolved ? "unresolved" : "value",
        text: rest,
        placeholder: pendingPh,
      });
    } else {
      segments.push({ kind: "extra", text: rest });
    }
  } else if (pendingPh) {
    segments.push({ kind: "value", text: "", placeholder: pendingPh });
  }
  return segments;
}

// Deterministic palette for placeholder-value spans.
// Same placeholder → same color across the preview.
const PALETTE = [
  { bg: "bg-sky-500/15", text: "text-sky-700 dark:text-sky-300", ring: "ring-sky-500/30" },
  { bg: "bg-emerald-500/15", text: "text-emerald-700 dark:text-emerald-300", ring: "ring-emerald-500/30" },
  { bg: "bg-violet-500/15", text: "text-violet-700 dark:text-violet-300", ring: "ring-violet-500/30" },
  { bg: "bg-pink-500/15", text: "text-pink-700 dark:text-pink-300", ring: "ring-pink-500/30" },
  { bg: "bg-orange-500/15", text: "text-orange-700 dark:text-orange-300", ring: "ring-orange-500/30" },
  { bg: "bg-teal-500/15", text: "text-teal-700 dark:text-teal-300", ring: "ring-teal-500/30" },
  { bg: "bg-fuchsia-500/15", text: "text-fuchsia-700 dark:text-fuchsia-300", ring: "ring-fuchsia-500/30" },
  { bg: "bg-lime-500/15", text: "text-lime-700 dark:text-lime-300", ring: "ring-lime-500/30" },
  { bg: "bg-indigo-500/15", text: "text-indigo-700 dark:text-indigo-300", ring: "ring-indigo-500/30" },
  { bg: "bg-rose-500/15", text: "text-rose-700 dark:text-rose-300", ring: "ring-rose-500/30" },
];

export function colorForPlaceholder(placeholder: string) {
  let h = 0;
  for (let i = 0; i < placeholder.length; i++) h = (h * 31 + placeholder.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

