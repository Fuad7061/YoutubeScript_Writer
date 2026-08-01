import { createServerFn } from "@tanstack/react-start";
import { generateObject } from "ai";
import { z } from "zod";
import { renderPrompt } from "./prompt-registry";
import { resolveModel, type StageOverride } from "./ai-provider";

const AmazonInput = z.object({
  title: z.string().optional(),
  affiliateUrl: z.string().optional(),
});

const ProductInput = z.object({
  name: z.string(),
  affiliate_url: z.string().optional(),
});

const Input = z.object({
  title: z.string().optional(),
  script: z.string(),
  products: z.array(ProductInput).optional().default([]),
  amazon: z.record(z.string(), z.array(AmazonInput)).optional(),
  channelHandle: z.string().optional(),
  sourceUrl: z.string().optional(),
  promptTemplateCommentary: z.string().optional(),
  promptTemplateReview: z.string().optional(),
  override: z.any().optional(),
});

const SeoSchema = z.object({
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  chapters: z.string(),
});

function resolveLinks(
  products: z.infer<typeof ProductInput>[],
  amazon?: Record<string, z.infer<typeof AmazonInput>[]>,
) {
  return products.map((p) => ({
    name: p.name,
    url: p.affiliate_url || amazon?.[p.name]?.[0]?.affiliateUrl || "",
  }));
}

// Replace common placeholder patterns the model tends to emit with real
// affiliate links (in order), plus fill "Product N" / product-name markers.
export function fillLinkPlaceholders(
  text: string,
  links: { name: string; url: string }[],
) {
  if (!text) return text;
  let out = text;

  // 1. Replace exact product-name placeholders like [Product 1 Link] or {ProductName link}
  links.forEach((l, i) => {
    if (!l.url) return;
    const idx = i + 1;
    const patterns: RegExp[] = [
      new RegExp(`\\[\\s*Product\\s*#?${idx}\\s*(?:Link|URL|Affiliate)?\\s*\\]`, "gi"),
      new RegExp(`\\{\\s*Product\\s*#?${idx}\\s*(?:Link|URL|Affiliate)?\\s*\\}`, "gi"),
      new RegExp(`\\[\\s*Link\\s*${idx}\\s*\\]`, "gi"),
      new RegExp(`\\{\\s*link_?${idx}\\s*\\}`, "gi"),
    ];
    patterns.forEach((re) => (out = out.replace(re, l.url)));
    // Product name reference: [ProductName Link]
    const nameEsc = l.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameRe = new RegExp(
      `\\[\\s*${nameEsc}\\s*(?:Link|URL|Affiliate)?\\s*\\]`,
      "gi",
    );
    out = out.replace(nameRe, l.url);
  });

  // 2. Sequential generic placeholders — replace in order of appearance
  const genericPatterns = [
    /\[\s*Insert\s+Link\s*\]/gi,
    /\[\s*Insert\s+(?:Product\s+)?URL\s*\]/gi,
    /\[\s*Affiliate\s+Link\s*\]/gi,
    /\[\s*Amazon\s+Link\s*\]/gi,
    /\[\s*Product\s+Link\s*\]/gi,
    /\[\s*Link\s*\]/gi,
    /\{\s*link\s*\}/gi,
    /<\s*link\s*>/gi,
    /YOUR_AFFILIATE_LINK/gi,
    /AFFILIATE_LINK_HERE/gi,
  ];
  const combined = new RegExp(
    genericPatterns.map((r) => r.source).join("|"),
    "gi",
  );
  let idx = 0;
  out = out.replace(combined, () => {
    while (idx < links.length && !links[idx].url) idx++;
    const url = links[idx]?.url;
    idx++;
    return url || "(link)";
  });

  // 3. Channel placeholder cleanup
  out = out.replace(/\[\s*Your\s+Channel(?:\s+Handle)?\s*\]/gi, "@yourchannel");

  return out;
}

export const DEFAULT_SEO_COMMENTARY_TEMPLATE = `Generate a YouTube SEO pack for a commentary/reaction video titled "{{TITLE}}"{{SOURCE_INLINE}}.

Return ONLY valid JSON — no markdown fences — matching:
{"title":"<=70 chars, click-worthy, curiosity-gap style (no spoilers)","description":"see rules","tags":["15-20 lowercase tags without #"],"chapters":"YouTube timestamps like 00:00 Intro\\n00:35 The setup ..."}

DESCRIPTION RULES (commentary):
- 3 short paragraphs. Paragraph 1: strong hook that teases the story WITHOUT spoiling the reveal. Paragraph 2: 2–3 bullet points of what viewers will see / learn. Paragraph 3: credit the original source{{SOURCE_LINK}}, a short fair-use / commentary note, then 5–8 relevant hashtags.
- No bracketed placeholders. No emojis in title. No markdown fences.
- Chapters must reflect a commentary structure (Intro / Setup / Escalation / Reveal / Takeaway) — not a product list.

SCRIPT:
{{SCRIPT}}`;

export const DEFAULT_SEO_REVIEW_TEMPLATE = `Generate a YouTube SEO pack for a review video based on "{{TITLE}}".

Return ONLY valid JSON — no markdown fences — matching:
{"title":"<=70 chars, click-worthy","description":"see rules","tags":["15-20 lowercase tags without #"],"chapters":"YouTube timestamps like 00:00 Intro\\n00:35 First product ..."}

DESCRIPTION RULES:
- 3 short paragraphs. Paragraph 1: hook + what the video covers. Paragraph 2: product list with EACH product on its own line, formatted EXACTLY as: "🔗 <Product name>: <URL>" using the REAL affiliate URLs given below (do NOT invent, do NOT use placeholders like [Insert Link]). Paragraph 3: affiliate disclosure ("As an Amazon Associate I earn from qualifying purchases."), then 5-8 hashtags.
- Do NOT use bracketed placeholders anywhere. If a product has "(no link)", write "🔗 <Product name>: link in comments" — never invent a URL.
- No markdown fences, no emojis in title.

PRODUCTS WITH AFFILIATE LINKS (use verbatim):
{{LINKS_BLOCK}}

SCRIPT:
{{SCRIPT}}`;

export const generateSeo = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const model = resolveModel(data.override as StageOverride | undefined);
    const links = resolveLinks(data.products, data.amazon);
    const linksBlock = links
      .map((l, i) => `${i + 1}. ${l.name} — ${l.url || "(no link)"}`)
      .join("\n");

    const isCommentary = links.length === 0;
    const rawTpl = isCommentary
      ? (data.promptTemplateCommentary?.trim() ? data.promptTemplateCommentary : DEFAULT_SEO_COMMENTARY_TEMPLATE)
      : (data.promptTemplateReview?.trim() ? data.promptTemplateReview : DEFAULT_SEO_REVIEW_TEMPLATE);

    const { text: prompt } = renderPrompt(rawTpl, {
      "{{TITLE}}": data.title ?? "",
      "{{SOURCE_INLINE}}": data.sourceUrl ? ` (source: ${data.sourceUrl})` : "",
      "{{SOURCE_LINK}}": data.sourceUrl ? ` (link: ${data.sourceUrl})` : "",
      "{{LINKS_BLOCK}}": linksBlock,
      "{{SCRIPT}}": data.script.slice(0, 8000),
    });

    const { object } = await generateObject({
      model,
      temperature: 0.5,
      maxOutputTokens: 16384,
      schema: SeoSchema,
      prompt,
    });

    const parsed = object;
    parsed.description = fillLinkPlaceholders(parsed.description, links);
    parsed.chapters = fillLinkPlaceholders(parsed.chapters, links);
    return parsed;
  });
