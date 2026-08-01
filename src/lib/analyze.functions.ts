import { createServerFn } from "@tanstack/react-start";
import { generateObject, APICallError } from "ai";
import { z } from "zod";
import { resolveModel, resolveFallbackModel, runAi, type StageOverride } from "./ai-provider";
import type { LanguageModel } from "ai";

/**
 * Generate text with retries on empty/transient upstream failures.
 * Some OpenAI-compatible proxies occasionally return an empty body or a
 * transient 5xx; the AI SDK surfaces those as `AI_APICallError` with an
 * empty message. We back off briefly and try again before giving up so
 * the caller sees a real, descriptive error instead of `<none>`.
 */
async function generateObjectWithRetry<T>(
  label: string,
  args: any,
  attempts = 3,
  timeoutMs = 90_000,
  fallbackModel?: LanguageModel | null,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const attemptLabel = `${label} (attempt ${i + 1}/${attempts})`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`${label}: timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await runAi(attemptLabel, () =>
        generateObject({ ...args, abortSignal: ctrl.signal }),
      );
      if (!res.object) {
        throw new Error(`${label}: empty response from model`);
      }
      return res as unknown as { object: T };
    } catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message || "";
      const status = APICallError.isInstance(e) ? e.statusCode ?? 0 : 0;
      const nonRetryable = (e as Error & { nonRetryable?: boolean })?.nonRetryable === true;
      const retryable =
        !nonRetryable &&
        (!status ||
          status === 408 ||
          status === 429 ||
          status >= 500 ||
          /empty response|invalid json|network|timeout|<none>|fetch failed|aborted|validation/i.test(msg));
      console.warn(`[analyze] ${attemptLabel} failed:`, msg || e);
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 800 * (i + 1) + Math.floor(Math.random() * 400)));
    } finally {
      clearTimeout(timer);
    }
  }

  // If primary model failed and a fallback model is configured, attempt fallback execution
  if (fallbackModel) {
    console.warn(`[analyze] ${label}: primary model failed (${(lastErr as Error)?.message}) — switching to fallback model`);
    const fallbackCtrl = new AbortController();
    const fallbackTimer = setTimeout(() => fallbackCtrl.abort(new Error(`${label}: fallback timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await runAi(`${label} (fallback)`, () =>
        generateObject({ ...args, model: fallbackModel, abortSignal: fallbackCtrl.signal }),
      );
      if (res.object) {
        return res;
      }
    } catch (fbErr) {
      console.error(`[analyze] ${label}: fallback model also failed:`, fbErr);
    } finally {
      clearTimeout(fallbackTimer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`${label}: unknown error`);
}



/**
 * Vision + text merge pipeline used by the /analyze page.
 *
 * Two server functions:
 *   1. analyzeFrameBatch  — captions a batch of frames (base64 data URLs) and
 *                            returns per-frame text + a mini scene summary.
 *   2. mergeAnalysis      — merges every batch summary + the transcript + the
 *                            source metadata into a single structured report.
 *
 * All calls go through the existing `resolveModel` helper (defaults to
 * google/gemini-3-flash-preview — the cheapest multimodal on the gateway).
 */

// -----------------------
// 1. Per-batch vision call
// -----------------------

const FrameBatchInput = z.object({
  frames: z.array(z.object({ t: z.number(), dataUrl: z.string().min(1) })).min(1).max(150),
  imagePayloads: z.array(z.object({ dataUrl: z.string().min(1) })).optional(),
  meta: z
    .object({ title: z.string().optional(), platform: z.string().optional() })
    .optional(),
  /** Optional custom prompt template (from Prompt Registry). */
  promptTemplate: z.string().optional(),
  override: z.any().optional(),
});

export type FrameBatchResult = {
  frameCaptions: { t: number; visual: string; onScreenText?: string }[];
  batchSummary: string;
};

const FrameBatchSchema = z.object({
  frames: z.array(z.object({ t: z.number(), visual: z.string(), onScreenText: z.string().optional() })),
  batchSummary: z.string()
});

/**
 * Normalize any angle shape into a plain string.
 * Models sometimes return `{angle, rationale}` objects instead of strings;
 * coerce them so downstream schemas and React rendering never see raw objects.
 */
export function normalizeAngle(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const primary = o.angle ?? o.text ?? o.premise ?? o.title ?? o.framing;
    if (typeof primary === "string" && primary.trim()) return primary.trim();
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v ?? "").trim();
}

export function normalizeAngles(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeAngle).filter((s) => s.length > 0);
}

/** Placeholders: {{FRAME_COUNT}}, {{PAYLOAD_COUNT}}, {{SOURCE_DESC}}, {{TIMESTAMPS}} */
export const DEFAULT_FRAME_CAPTION_TEMPLATE = `You are a video scene analyst. Below are {{PAYLOAD_COUNT}} image payload(s) representing {{FRAME_COUNT}} sequential video frames from a {{SOURCE_DESC}}.
The target frame timestamps (in seconds) to analyze are: {{TIMESTAMPS}}.
Note: If composite grid tiles are provided, each grid cell features a timestamp badge overlay (#<index> @ <timestamp>s).

For EACH frame timestamp listed above, describe exactly what is visible — subjects, action, setting, notable objects/products, and any on-screen text (transcribe it verbatim). Be concrete: "man pours espresso from a red moka pot" not "a person is doing something".

Then write ONE 1-2 sentence summary of what happens across this batch as a scene.

Return STRICT JSON only with the exact timestamp "t" for each frame:
{"frames":[{"t":<seconds>,"visual":"...","onScreenText":"..."}, ...],"batchSummary":"..."}`;

function fillTemplate(template: string, subs: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z_]+)\}\}/g, (m, key: string) => {
    const normalized = `{{${key.toUpperCase()}}}`;
    return subs[normalized] ?? m;
  });
}

export const analyzeFrameBatch = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => FrameBatchInput.parse(i))
  .handler(async ({ data }): Promise<FrameBatchResult> => {
    const override = data.override as StageOverride | undefined;
    const model = resolveModel(override);
    const fallbackModel = resolveFallbackModel(override);

    const sourceDesc =
      `${data.meta?.platform ? data.meta.platform + " " : ""}video` +
      `${data.meta?.title ? ` titled "${data.meta.title}"` : ""}`;

    const tpl =
      data.promptTemplate && data.promptTemplate.trim().length > 0
        ? data.promptTemplate
        : DEFAULT_FRAME_CAPTION_TEMPLATE;

    const payloads = data.imagePayloads && data.imagePayloads.length > 0 ? data.imagePayloads : data.frames;

    const promptText = fillTemplate(tpl, {
      "{{FRAME_COUNT}}": String(data.frames.length),
      "{{PAYLOAD_COUNT}}": String(payloads.length),
      "{{SOURCE_DESC}}": sourceDesc,
      "{{TIMESTAMPS}}": data.frames.map((f) => f.t.toFixed(1)).join(", "),
    });

    const res = await generateObjectWithRetry(
      "frame batch caption",
      {
        model,
        temperature: 0.2,
        maxOutputTokens: 16384,
        schema: FrameBatchSchema,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              ...payloads.map((p) => ({
                type: "image" as const,
                image: p.dataUrl,
              })),
            ],
          },
        ],
      },
      3,
      45_000,
      fallbackModel,
    );
    const parsed = (res.object ?? {}) as any;

    try {
      return { frameCaptions: parsed.frames ?? [], batchSummary: parsed.batchSummary ?? "" };
    } catch (e) {
      // Degrade gracefully — never crash the pipeline on a single bad batch
      return {
        frameCaptions: data.frames.map((f) => ({ t: f.t, visual: "(caption unavailable)" })),
        batchSummary: `(batch summary failed to parse: ${(e as Error).message})`,
      };
    }
  });


// -----------------------
// 2. Final merge
// -----------------------

const MergeInput = z.object({
  meta: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    platform: z.string().optional(),
    duration: z.number().optional(),
    sourceUrl: z.string().optional(),
  }),
  frameCaptions: z.array(
    z.object({ t: z.number(), visual: z.string(), onScreenText: z.string().optional() }),
  ),
  batchSummaries: z.array(z.string()),
  transcript: z.string().optional(),
  videoDraft: z.string().optional(),
  /** Optional custom prompt template (from Prompt Registry). */
  promptTemplate: z.string().optional(),
  /** User-authored corrections — highest-priority evidence, overrides everything else. */
  userCorrections: z.string().optional(),
  override: z.any().optional(),
});


export type AnalysisReport = {
  summary: string;
  hookMoments: { t: number; description: string; role?: "sympathetic" | "villain" | "hero" | "neutral" | "opening" | "attack" | "hero_save" | "payoff" | "cta" }[];
  scenes: {
    start: number;
    end: number;
    visual: string;
    spoken?: string;
    onScreenText?: string;
    keyTakeaway: string;
    beatType?: string;
  }[];
  topics: string[];
  entities: string[];
  tone: string;
  pacing: string;
  targetAudience: string;
  /** v3 — source genre. Free-form string so the prompt can adapt to any viral short (karma, cute pet, tutorial, moral, oddly satisfying, nature, etc.). */
  clipType?: string;
  /**
   * v3 — raw material the commentary writer uses to trigger viewer connection.
   * Fields are universal: they describe the video's focal subject and its pivot moment,
   * whether the subject is a person, an animal, an object, or a phenomenon.
   * Any field may be "" when the video doesn't have that element.
   */
  emotionalAnchor?: {
    focalDetail: string;
    pivotAction: string;
    contrastMoment: string;
  };
  commentaryAngles: string[];
  transcriptExcerpt?: string;
};


/**
 * Placeholders: {{TITLE}}, {{AUTHOR}}, {{PLATFORM}}, {{DURATION}}, {{URL}},
 * {{FRAMES_BLOCK}}, {{BATCH_BLOCK}}, {{TRANSCRIPT_LABEL}}, {{TRANSCRIPT}},
 * {{DRAFT_BLOCK}}
 */
export const DEFAULT_REPORT_MERGE_TEMPLATE = `You are analysing a short video for a creator who will make an ORIGINAL commentary / reaction video about it.
Your job: produce a structured analysis report they can build fresh content on top of — WITHOUT copying the source.

The source can be ANY viral-shorts genre: karma, rescue, cute pet / animal, funny fail, oddly satisfying, tutorial, moral lesson, nature moment, observational humor, etc. Do NOT force a human-hero / human-victim framing onto a video that isn't about people.

Source metadata:
- Title: {{TITLE}}
- Author: {{AUTHOR}}
- Platform: {{PLATFORM}}
- Duration: {{DURATION}}
- URL: {{URL}}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVIDENCE HIERARCHY (read carefully — this decides who wins on conflicts)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

USER CORRECTIONS — HIGHEST PRIORITY, OVERRIDES EVERY OTHER SOURCE BELOW (including the Video Draft). Treat every sentence here as an established fact the creator has personally verified. Where a correction conflicts with the Draft, frames, transcript, or your own inference, the correction WINS. Silently rewrite any conflicting beat so the report agrees with the corrections. If this block is "(none)", ignore it.
{{USER_CORRECTIONS}}

PRIMARY SOURCE — Video Draft (a model that watched the ENTIRE video at 1 fps end-to-end):
{{DRAFT_BLOCK}}
SECONDARY SOURCE — Frame captions (SPARSE SAMPLE — only a handful of thumbnails/timestamps; many frames of the real video are NOT included here and short/fast actions are almost always missing):
{{FRAMES_BLOCK}}

Batch scene summaries (also derived from the same sparse frames):
{{BATCH_BLOCK}}

Spoken transcript{{TRANSCRIPT_LABEL}}:
{{TRANSCRIPT}}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRUTH LOCK — non-negotiable
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- The Video Draft is the SOURCE OF TRUTH for WHAT the video is about, WHO/WHAT the actors are (person, animal, object, phenomenon), the SPECIES / TYPE of each actor, and the ORDER of events.
- Frame captions and batch summaries are only for adding concrete visual detail (colors, objects, setting, on-screen text) the Draft does not mention.
- On ANY conflict about an actor, subject, species, or action — the Draft WINS. Do NOT average, hedge, or "combine" versions. Never swap an animal for a human (or vice versa) just because a sampled frame happened to catch a human nearby.
- Frames are a SPARSE SAMPLE. Absence of a subject or action in the frame list is NOT evidence it didn't happen. Do not remove or downgrade a beat from the Draft just because no sampled frame captured it.
- If (and only if) the Draft is empty or missing, fall back to frames + transcript.
- Do NOT quote transcript lines longer than 8 words in any field.
- If transcript is empty, infer spoken content from on-screen text or set "spoken" to "".
- Do NOT invent an archetype the Draft doesn't support. No fabricated heroes, villains, or victims. A cat knocking a glass off a table is not a "hero" and has no "villain".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACTOR-REFERENCE & PRONOUN RULE (applies to summary, every scenes[].visual / keyTakeaway, and every emotionalAnchor.* field)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Re-mention every actor with a SHORT VISUAL DESCRIPTOR ("the blue-robe passenger", "the tabby cat", "the red moka pot"). Do not use a bare pronoun on the first re-mention.
- Use gendered singular pronouns (he / she / him / her / his / hers) ONLY when the Draft explicitly asserts the person's gender. Otherwise use the visual descriptor again.
- Use it / its for animals and objects when the species / type is clear but gender isn't.
- NEVER use singular "they / them / their" for an individual actor — it blurs who did what and reads as a group.
- Plural "they" is only allowed for a genuinely multi-actor group ("the bystanders", "both cats").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return STRICT JSON matching this exact shape (no extra fields, no prose, no markdown):
{
  "summary": "3-5 sentence plain-English description of what happens in the video, start to finish. Refer to actors using the ACTOR-REFERENCE & PRONOUN RULE above. Name actors the same way the Draft names them (species / type + distinguishing visual). If the Draft says a dog performs the rescue, the summary says a dog performs the rescue.",
  "hookMoments": [{"t": <seconds>, "description": "...", "role": "opening|pivot|payoff|cta"}],
  "scenes": [{"start": <s>, "end": <s>, "visual": "...", "spoken": "...", "onScreenText": "...", "keyTakeaway": "...", "beatType": "setup|impact|response|resolution|payoff|CTA|b-roll"}],
  "topics": ["...", "..."],
  "entities": ["people/animals/objects/products/brands seen or named — match the Draft, include species/type"],
  "tone": "one short phrase describing the source's overall tone (e.g. 'deadpan satisfying', 'wholesome rescue', 'chaotic slapstick', 'quiet observational', 'gentle tutorial')",
  "pacing": "fast|medium|slow with detail",
  "targetAudience": "one short phrase describing who this video is FOR",
  "clipType": "one short lowercase snake_case label describing the SOURCE'S DOMINANT ENERGY. Pick the single best fit — either from this suggested set: karma_justice, wholesome_rescue, funny_fail, shocking_moment, anticlimactic_bait, funny_observation, respect_moment, cute_pet, nature_moment, moral_lesson, tutorial_howto, oddly_satisfying, craft_process, reaction, review, sports_highlight, gaming_moment — or invent your own short label if none fit. Do NOT force a hero/victim label onto a video that isn't about that.",
  "emotionalAnchor": {
    "focalDetail": "the single most specific visual detail about the video's FOCAL SUBJECT (whoever / whatever the viewer's attention lands on — a person, an animal, an object, a phenomenon) that pulls the viewer in. Examples: 'small child in yellow shirt walking alone, unaware' / 'tabby kitten with one white paw peeking out from a cardboard box' / 'red moka pot hissing steam on a bright blue gas flame'. Sourced from the Draft's scene visuals. Empty string ('') if nothing distinct stands out.",
    "pivotAction": "the exact moment the video TURNS — the rescue, the punchline, the reveal, the aha, the payoff. State it as a plain fact of what happens on screen. Examples: 'a stray dog runs in from the left and tackles the attacker' / 'the cat pushes the glass off the table with one paw and stares straight at the camera' / 'the batter finally rises after the third fold and doubles in volume'. Do NOT require a human 'hero' — a cat, an object, a chemical reaction can all be the pivot. Empty string ('') if the video has no single turning point (e.g. a slow observational clip).",
    "contrastMoment": "any expectation-vs-reality, before-vs-after, slow-vs-fast, or role gap that makes the pivot land. Examples: 'adults still looking around while the dog was already between the child and the attacker' / 'the batter looked completely flat right before it suddenly rose' / 'the owner was mid-sentence about how well-behaved the cat is, then the cat knocked the glass over'. Empty string ('') if no meaningful contrast exists."
  }
}

Rules:
- scenes should segment the video into 4-8 chunks; align start/end to the Draft's beats first, then use frame timestamps to refine.
- tone / pacing / targetAudience describe the SOURCE as observed — grounded in the Draft, not invented.
- Do NOT propose commentary angles, hooks, or creator takes here. Angle work happens in a later step.
- beatType labels: "setup" for calm / pre-action scenes, "impact" for the physical or emotional hit (the moment something happens — a fall, a punchline landing, a reveal), "response" for immediate reactions after the hit, "resolution" for the ending / safety beat, "payoff" for the single scene that earned the video its shares, "CTA" for any call-to-action overlay scene, "b-roll" for filler / cutaway. Every scene gets exactly one beatType. If the video HAS a clear turn, never skip the "impact" beat — even if it lasts only 1 second, it must be its own scene entry.
- hookMoments role labels: "opening" = the hook device used in the first 3s, "pivot" = the video's turning point (rescue, punchline, reveal), "payoff" = the peak viral beat, "cta" = any comment/share prompt. Only include roles that actually occur.
- clipType is a hint for downstream framing — pick the label that best matches the video's actual energy, don't force it into a "karma" or "rescue" bucket if it isn't one.
- emotionalAnchor captures the raw material the commentary writer needs to make the viewer feel something. Every sub-field is a plain sentence grounded in the Draft, in simple language (these sentences will be read by the commentary writer and translated into plain VO). Never invent detail. If the Draft does not support a field, write "".`;



export const mergeAnalysis = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => MergeInput.parse(i))
  .handler(async ({ data }): Promise<AnalysisReport> => {
    const model = resolveModel(data.override as StageOverride | undefined);

    const framesBlock = data.frameCaptions
      .map((f) => `[${f.t.toFixed(1)}s] ${f.visual}${f.onScreenText ? ` — on-screen: "${f.onScreenText}"` : ""}`)
      .join("\n");

    const batchBlock = data.batchSummaries.map((s, i) => `Batch ${i + 1}: ${s}`).join("\n");

    const draftBlock = data.videoDraft
      ? data.videoDraft.slice(0, 12000)
      : "(no video draft available — fall back to frames + transcript below)";

    const tpl =
      data.promptTemplate && data.promptTemplate.trim().length > 0
        ? data.promptTemplate
        : DEFAULT_REPORT_MERGE_TEMPLATE;

    const correctionsText = (data.userCorrections ?? "").trim();
    const promptText = fillTemplate(tpl, {
      "{{TITLE}}": data.meta.title ?? "(none)",
      "{{AUTHOR}}": data.meta.author ?? "(none)",
      "{{PLATFORM}}": data.meta.platform ?? "(unknown)",
      "{{DURATION}}": data.meta.duration ? data.meta.duration.toFixed(1) + "s" : "(unknown)",
      "{{URL}}": data.meta.sourceUrl ?? "(none)",
      "{{FRAMES_BLOCK}}": framesBlock || "(none)",
      "{{BATCH_BLOCK}}": batchBlock || "(none)",
      "{{TRANSCRIPT_LABEL}}": data.transcript ? "" : " (not available)",
      "{{TRANSCRIPT}}": (data.transcript ?? "").slice(0, 6000) || "(none)",
      "{{DRAFT_BLOCK}}": draftBlock,
      "{{USER_CORRECTIONS}}": correctionsText ? correctionsText.slice(0, 4000) : "(none)",
    });

    const MergeAnalysisSchema = z.object({
      summary: z.string(),
      hookMoments: z.array(z.object({ t: z.number(), description: z.string(), role: z.enum(["sympathetic", "villain", "hero", "neutral", "opening", "attack", "hero_save", "payoff", "cta"]).optional() })),
      scenes: z.array(z.object({
        start: z.number(),
        end: z.number(),
        visual: z.string(),
        spoken: z.string().optional(),
        onScreenText: z.string().optional(),
        keyTakeaway: z.string(),
        beatType: z.string().optional()
      })),
      topics: z.array(z.string()),
      entities: z.array(z.string()),
      tone: z.string(),
      pacing: z.string(),
      targetAudience: z.string(),
      clipType: z.string().optional(),
      emotionalAnchor: z.object({
        focalDetail: z.string(),
        pivotAction: z.string(),
        contrastMoment: z.string()
      }).optional(),
      commentaryAngles: z.array(z.string()).optional()
    });

    const res = await generateObjectWithRetry("final report merge", { 
      model, 
      temperature: 0.3, 
      maxOutputTokens: 16384, 
      schema: MergeAnalysisSchema,
      prompt: promptText 
    });
    const parsed = (res.object ?? {}) as any;


    try {
      // Normalize legacy emotionalAnchor keys (sympatheticDetail/heroAction) → new universal keys.
      let emotionalAnchor: AnalysisReport["emotionalAnchor"] | undefined;
      const raw = parsed.emotionalAnchor as Record<string, unknown> | undefined;
      if (raw && typeof raw === "object") {
        const pick = (...keys: string[]): string => {
          for (const k of keys) {
            const v = raw[k];
            if (typeof v === "string" && v.trim()) return v.trim();
          }
          return "";
        };
        emotionalAnchor = {
          focalDetail: pick("focalDetail", "sympatheticDetail"),
          pivotAction: pick("pivotAction", "heroAction"),
          contrastMoment: pick("contrastMoment"),
        };
      }
      return {
        ...parsed,
        emotionalAnchor,
        commentaryAngles: normalizeAngles((parsed as { commentaryAngles?: unknown }).commentaryAngles ?? []),
        transcriptExcerpt: data.transcript ? data.transcript.slice(0, 2000) : undefined,
      };
    } catch (e) {
      throw new Error(`analysis merge failed to parse model output: ${(e as Error).message}`);
    }

  });

