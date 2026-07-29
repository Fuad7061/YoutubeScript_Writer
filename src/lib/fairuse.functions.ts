import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { renderPrompt } from "./prompt-registry";
import { resolveModel, type StageOverride } from "./ai-provider";

const ProductInput = z.object({
  name: z.string(),
  affiliate_url: z.string().optional(),
});

const Input = z.object({
  sourceTitle: z.string().optional(),
  sourceAuthor: z.string().optional(),
  sourceUrl: z.string().optional(),
  channelHandle: z.string().optional(),
  products: z.array(ProductInput).optional(),
  script: z.string(),
  promptTemplate: z.string().optional(),
  override: z.any().optional(),
});

/**
 * Generates a YouTube-ready fair-use + affiliate disclosure package.
 *
 * The output markdown contains four clearly-marked sections that the UI
 * parses so each can be copied on its own:
 *
 *   ## 📋 YouTube description disclosure    <- copy-paste directly into
 *                                              the video description
 *   ## 📌 Pinned comment                    <- optional pinned comment
 *   ## ✅ Compliance checklist               <- self-audit before publish
 *   ## 💡 Extra recommendations              <- optional strengthening tips
 *
 * The disclosure combines the three things a monetised review video needs
 * on YouTube:
 *   1. FTC / Amazon Associates paid-relationship disclosure (required by
 *      the FTC 16 CFR Part 255 and by the Amazon Associates Operating
 *      Agreement — must be "clear and conspicuous", not buried).
 *   2. A short fair-use / §107 statement explaining transformative purpose
 *      when third-party clips or images are used (commentary, criticism,
 *      review — one of the enumerated §107 purposes).
 *   3. Source attribution / credit lines.
 *
 * Note: YouTube has no "fair use" opt-in — a "no copyright infringement
 * intended" line has no legal effect and does not stop Content ID claims.
 * The disclosure is documentation for viewers and a signal to reviewers,
 * not a shield. The checklist section makes that explicit.
 */
export const DEFAULT_FAIRUSE_TEMPLATE = `You are a YouTube policy specialist writing the compliance block for a monetised product-review video that reuses short third-party clips.

Return Markdown with EXACTLY these four sections and headings (do NOT add fences around the whole thing):

## 📋 YouTube description disclosure
A block the creator can paste VERBATIM at the bottom of the YouTube description. It must contain, in order, each on its own paragraph:
- An Amazon Associates disclosure using this exact sentence: "As an Amazon Associate I earn from qualifying purchases." followed by an FTC paid-relationship line stating some links are affiliate links at no extra cost to the viewer.
- A source-credit paragraph naming the original creator and linking the source: "Clips & footage credit: {{SOURCE_LINE}}. Used under fair use (17 U.S.C. §107) for purposes of commentary, criticism, and review."
- A short fair-use statement (2-3 sentences) explaining that any third-party material is transformative commentary, limited in amount, and not a substitute for the original.
- A copyright-contact line for takedown requests: "Copyright owners: if you believe material has been used improperly, please contact {{CHANNEL_HANDLE}} before filing a claim — we will remove it promptly."
Use plain text only — no markdown headings inside this block, no bullet lists, no emojis except the section heading. It must be ready to paste with zero edits.

## 📌 Pinned comment
A 1-2 sentence pinned comment that repeats the affiliate disclosure in friendly language and thanks viewers for supporting the channel via the links.

## ✅ Compliance checklist
Bullet list. Include ONLY items about: transformative commentary present, each clip used ≤10 seconds, affiliate disclosure in first ~200 chars of description, affiliate disclosure spoken in the video, no full-screen unaltered copies, background music is royalty-free or licensed, thumbnail does not reuse copyrighted imagery, video qualifies as "significantly different" under YouTube's reused-content / YPP rules. Do NOT include any item about spoken fair-use statements or on-screen source/credit overlays — those live only in the written description. Mark items you can confirm from the script with ✅ and items the creator must verify manually with ⬜.

## 💡 Extra recommendations
3-5 short bullets with actionable improvements focused on affiliate / FTC / Amazon Associates compliance and retention (e.g. add spoken FTC affiliate disclosure in first 30 seconds, add on-screen "AD" badge over affiliate mentions, keep b-roll to voiceover ratio ≥ 60/40, mention Amazon price-changes disclaimer, avoid superlatives Amazon Associates prohibits like "cheapest" or "best price"). Do NOT suggest speaking a fair-use / copyright statement or adding on-screen source credits — the creator handles fair use in the written description only.

Context:
- Source: {{SOURCE_LINE}}
- Channel handle: {{CHANNEL_HANDLE}}
- Featured products (with affiliate URLs):
{{PRODUCT_LIST}}

Script excerpt (for tone + to judge transformativeness):
{{SCRIPT}}`;

export const generateFairUse = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const model = resolveModel(data.override as StageOverride | undefined);

    const productList =
      (data.products ?? [])
        .map((p, i) => `${i + 1}. ${p.name}${p.affiliate_url ? ` — ${p.affiliate_url}` : ""}`)
        .join("\n") || "(none)";

    const sourceLine = data.sourceUrl
      ? `${data.sourceTitle ?? "source video"} by ${data.sourceAuthor ?? "original creator"} (${data.sourceUrl})`
      : `${data.sourceTitle ?? "source video"} by ${data.sourceAuthor ?? "original creator"}`;

    const rawTpl =
      data.promptTemplate && data.promptTemplate.trim().length > 0
        ? data.promptTemplate
        : DEFAULT_FAIRUSE_TEMPLATE;

    const { text: prompt } = renderPrompt(rawTpl, {
      "{{SOURCE_LINE}}": sourceLine,
      "{{CHANNEL_HANDLE}}": data.channelHandle ?? "@yourchannel",
      "{{PRODUCT_LIST}}": productList,
      "{{SCRIPT}}": data.script.slice(0, 4000),
    });

    const { text } = await generateText({
      model,
      temperature: 0.3,
      prompt,
    });
    return { fairuse: text };
  });
