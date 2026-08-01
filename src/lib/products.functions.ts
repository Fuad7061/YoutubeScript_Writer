import { createServerFn } from "@tanstack/react-start";
import { generateObject } from "ai";
import { z } from "zod";
import { renderPrompt } from "./prompt-registry";
import { resolveModel, type StageOverride } from "./ai-provider";
const ProductSchema = z.object({
  products: z.array(
    z.object({
      name: z.string(),
      category: z.string().optional(),
      brand: z.string().optional(),
      description: z.string().optional(),
      key_feature: z.string().optional(),
      estimated_price: z.string().optional(),
      mentioned_context: z.string().optional(),
      amazon_search_query: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
});

const FrameInput = z.object({
  timestamp: z.string().optional(),
  scene: z.string().optional(),
  description: z.string().optional(),
  products_visible: z.array(z.string()).optional(),
});

const Input = z.object({
  transcript: z.string().min(1),
  title: z.string().optional(),
  frames: z.array(FrameInput).optional(),
  promptTemplate: z.string().optional(),
  override: z.any().optional(),
});


export const DEFAULT_PRODUCTS_EXTRACT_TEMPLATE = `You are a product research assistant specializing in Amazon affiliate marketing.

Analyze the following YouTube video TRANSCRIPT and identify the physical, purchasable products the video is actually about. Optional VISUAL EVIDENCE from key frames is provided as supporting context ONLY — it helps disambiguate brand/model, but the transcript is the source of truth for WHICH products count.

STRICT RULES:
- The TRANSCRIPT drives the product list. If the transcript reviews/features N products, return those N products (best matched) — no more, no less. Do NOT add extra products just because they appear in a frame.
- If a frame shows items that the narrator never actually reviews (background clutter, b-roll, competing products in a comparison shot), EXCLUDE them.
- Use frame evidence to (a) recover an exact brand/model when the transcript is vague ("this little grey vacuum" + frame shows "Baseus AP02" → name it "Baseus AP02 Handheld Vacuum"), and (b) confirm a product is really shown.
- Only include physical, purchasable products (gadgets, tools, kitchenware, electronics, appliances, accessories).
- EXCLUDE: software, services, subscriptions, generic categories, body parts, foods eaten, brand mentions without a product, tangential references.
- Deduplicate: same product described multiple ways = one entry.
- Each product MUST have a "mentioned_context" — a short verbatim quote (<120 chars) from the TRANSCRIPT referencing it. Frames alone are not enough grounding.
- Never invent products. If nothing qualifies, return {"products":[]}.
- Prefer the specific model / product name over generic category.

For each valid product, output:
- name: clear, searchable product name (specific model preferred; use frame evidence when transcript is vague)
- brand: brand name if identified from transcript OR frames, otherwise omit
- description: one plain sentence describing what the product does
- key_feature: the single strongest USP / benefit shown in the video (max 20 words)
- category: e.g. "Kitchen", "Consumer Electronics", "Tools & Home Improvement", "Home & Garden"
- estimated_price: realistic USD price band like "$25-60" or "$300-500"
- mentioned_context: short verbatim quote from TRANSCRIPT that mentions/describes it
- amazon_search_query: 3–6 word OPTIMIZED keyword phrase tailored for Amazon's search engine. Transform vague transcript language into concrete, high-recall keywords (e.g. "this small handheld grey vacuum thing" -> "handheld cordless car vacuum cleaner"). Include brand + model number when known (pull from frames if transcript omitted them). No punctuation, no filler words.
- confidence: 0.0–1.0 how sure you are this is a real distinct product actually featured

Return ONLY valid JSON, no markdown fences, no prose:
{"products":[{...}, ...]}

VIDEO TITLE: {{TITLE}}

{{FRAMES_BLOCK}}TRANSCRIPT (source of truth):
{{TRANSCRIPT}}`;

export const extractProducts = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const model = resolveModel(data.override as StageOverride | undefined);

    const framesBlock = (data.frames ?? [])
      .map((f, i) => {
        const visible = (f.products_visible ?? []).filter(Boolean).join(", ");
        return `- Frame ${i + 1} [${f.timestamp ?? "?"}${f.scene ? ` · ${f.scene}` : ""}]: ${f.description ?? ""}${visible ? `\n  visible: ${visible}` : ""}`;
      })
      .join("\n");

    const framesSection = framesBlock
      ? `VISUAL EVIDENCE FROM FRAMES (supporting context only):\n${framesBlock}\n\n`
      : "";

    const rawTpl =
      data.promptTemplate && data.promptTemplate.trim().length > 0
        ? data.promptTemplate
        : DEFAULT_PRODUCTS_EXTRACT_TEMPLATE;

    const { text: prompt } = renderPrompt(rawTpl, {
      "{{TITLE}}": data.title ?? "(unknown)",
      "{{FRAMES_BLOCK}}": framesSection,
      "{{TRANSCRIPT}}": data.transcript.slice(0, 50000),
    });

    const { object } = await generateObject({
      model,
      temperature: 0.2,
      maxOutputTokens: 16384,
      schema: ProductSchema,
      prompt,
    });

    const parsed = object;
    // Drop low-confidence noise and require a mentioned_context (grounds relevance)
    const filtered = parsed.products.filter(
      (p) =>
        p.name &&
        p.name.trim().length > 1 &&
        (p.confidence == null || p.confidence >= 0.5) &&
        (p.mentioned_context ?? "").trim().length > 0,
    );
    return { products: filtered.length ? filtered : parsed.products };
  });
