import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";
import { resolveModel, type StageOverride } from "./ai-provider";

const ProductInput = z.object({
  name: z.string(),
  brand: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  key_feature: z.string().optional(),
  estimated_price: z.string().optional(),
  mentioned_context: z.string().optional(),
  affiliate_url: z.string().optional(),
});

const AmazonInput = z.object({
  title: z.string().optional(),
  price: z.string().optional(),
  rating: z.string().optional(),
  brand: z.string().optional(),
  affiliateUrl: z.string().optional(),
});

const FrameInput = z.object({
  timestamp: z.string().optional(),
  scene: z.string().optional(),
  description: z.string().optional(),
  products_visible: z.array(z.string()).optional(),
});

const Input = z.object({
  title: z.string().optional(),
  transcript: z.string().optional(),
  products: z.array(ProductInput),
  amazon: z.record(z.string(), z.array(AmazonInput)).optional(),
  frames: z.array(FrameInput).optional(),
  format: z.string().optional(),
  tone: z.string().optional(),
  targetAudience: z.string().optional(),
  videoVisuals: z.string().optional(),
  promptTemplate: z.string().optional(),
  override: z.any().optional(),
});

export type ScriptOptions = z.infer<typeof Input>;

function buildProductInfo(
  products: z.infer<typeof ProductInput>[],
  amazon?: Record<string, z.infer<typeof AmazonInput>[]>,
) {
  return products
    .map((p, i) => {
      const top = amazon?.[p.name]?.[0];
      const link = p.affiliate_url || top?.affiliateUrl || "";
      const price = p.estimated_price || top?.price || "";
      const feature = p.key_feature || p.description || top?.title || "";
      return `Product #${i + 1}: ${p.name}${p.brand ? ` (${p.brand})` : ""}
- Key Features: ${feature || "—"}${price ? `\n- Price: ${price}` : ""}${
        link ? `\n- Link: ${link}` : ""
      }`;
    })
    .join("\n\n");
}

function buildTargetAudience(products: z.infer<typeof ProductInput>[], custom?: string) {
  const names = products.map((p) => p.name).filter(Boolean).join(", ");
  const suffix = names ? ` (specifically interested in: ${names})` : "";
  if (custom && custom.trim()) return `${custom.trim()}${suffix}`;
  return `Audience interested in ${names || "smart, helpful household gadgets"}. High-utility lifestyle hacks, product reviews, and smart household gadgets.${suffix}`;
}

const DEFAULT_VISUALS =
  "By default, build visuals tailored for listicle and single product review commentary videos. Show the products in action with clean close-ups, highlighting real-use features and satisfying tactile demonstrations.";

export const DEFAULT_SCRIPT_PROMPT_TEMPLATE = `You are an elite, highly-paid YouTube Shorts, TikTok, and Instagram Reels scriptwriter and algorithm expert. Your specialty is writing hyper-fast, high-retention vertical video scripts (under 60 seconds) that drive massive affiliate link clicks and viral shares.

============================
USER_GIVEN_INPUT (read once here; every rule below refers back by tag)
============================
<TONE>
{{TONE}}
</TONE>

<FORMAT>
{{FORMAT}}
</FORMAT>

<TARGET_AUDIENCE>
{{TARGET_AUDIENCE}}
</TARGET_AUDIENCE>

<PRODUCT_INFO>
{{PRODUCT_INFO}}
</PRODUCT_INFO>

<COMPETITOR_SCRIPT>
{{COMPETITOR_SCRIPT}}
</COMPETITOR_SCRIPT>

<VIDEO_VISUALS>
{{VIDEO_VISUALS}}
</VIDEO_VISUALS>
============================

INSTRUCTION: Whenever a rule below mentions a tag like <TONE>, <FORMAT>, <PRODUCT_INFO>, <COMPETITOR_SCRIPT>, <VIDEO_VISUALS>, or <TARGET_AUDIENCE>, look up its value inside USER_GIVEN_INPUT above. NEVER print the tag literally in your final output. If a tag's block is empty, describe accordingly (e.g. "No specific product information provided"). These rules are UNIVERSAL — apply them the same for any niche, product category, or content format.

Task:
Analyze the provided inputs (<PRODUCT_INFO>, <COMPETITOR_SCRIPT>, <VIDEO_VISUALS>, <TARGET_AUDIENCE>) and generate a complete, ready-to-produce script along with optimized metadata in the requested output format.

Tone Guideline: Write in a <TONE> style.

Core Directives:

1. SEO & Viral Metadata
- Rule: Generate a highly clickable, curiosity-inducing title and an SEO-rich description.
- Title: Keep it under 50 characters. Capitalize impact words. Use 1-2 emojis. (e.g., "5 Amazon Finds You ACTUALLY Need 🤯").
- Description: Write 2 short sentences heavily utilizing primary search keywords for the niche. Include a CTA pointing to the comments/bio, and 3-5 hyper-relevant, high-volume hashtags.

2. The 3-Second Hook (Visual & Audio Synergy)
- Rule: ZERO introductions ("Hey guys", "Watch this", "POV:", "Story time", "Wait for it", "You won't believe", "Let me tell you", "I stopped believing", "This is your sign"). Start immediately with a bold claim, a bizarre visual cue, or a deep pain point. Target a strong emotion (curiosity, frustration, awe, surprise, humor).
- Sound-off test: the opening frame must stop the scroll with audio muted. If it needs sound to work, rewrite it.
- ONE SENTENCE ONLY: the spoken hook is a single sentence, max 8 words, containing one concrete noun OR one specific non-price number.
- Vary the opener EVERY generation — never reuse the same archetype or sentence structure as a previous script. Pick ONE archetype at random and label it at the top of the script as "// Hook archetype: X":
  A) Myth-Break — invert a common belief ("Turns out non-stick pans aren't the problem.")
  B) Absurd Result — payoff first, reason later ("My kitchen sponge lasted 4 months.")
  C) Mid-Action Cold Open — start inside the action ("Watch what happens when I drop this.")
  D) Direct Callout — name the exact viewer or moment ("If you rent, you need this on your wall.")
  E) Question Loop — open a curiosity gap ("Why is nobody talking about this fix?")
  F) Number Tease — non-price number ("7 things that replaced my entire toolbox.")
  G) Category Rapid Hook — niche + promise ("Best Amazon coffee finds nobody talks about.")
  H) Confession — small vulnerable admission ("I've been cleaning my kitchen wrong for years.")
  I) Contrarian Take — challenge the mainstream pick ("Stop buying the viral one — this one actually works.")
- Do NOT read the product name in the hook. Do NOT introduce yourself. Do NOT restate the title.
- Listicle Example (Myth-Break): "Turns out your kitchen doesn't need half these gadgets."
- Single Product Example (Confession): "I've been ruining every non-stick pan I own."


3. The Pacing & Formula (Chosen Format: <FORMAT>)
If the chosen format is "Format A: The Rapid Listicle (Multiple Products)" or has multiple products:
- Rule: You MUST include ALL the products listed under <PRODUCT_INFO> in the script (do NOT skip or omit any of them).
- Word budget per product: Keep descriptions extremely concise and punchy (e.g., 1 benefit-driven sentence of about 10-15 words per product) so they fit together and don't drag.
- Visual Rule: ALWAYS instruct the editor to place a visual countdown (e.g., 10, 9, 8, ... based on the total number of products) on screen, but NEVER say the numbers in the voiceover.
- Audio Rule: Vary your sentence structures. Do not start every sentence with "This is a...". Use the Name + Action + Ultimate Benefit formula.
  * Example: "This mini leaf blower sweeps debris and dust simultaneously, clearing your tight patio corners in seconds."

If the chosen format is "Format B: The Deep Dive (Single Product)" or focuses on a single product:
- Rule: Use the "Because, But, So" framework to create a mini-story with continuous conflict and resolution.
  * Because (Context): "...because most camping chairs kill your back after an hour."
  * But (Conflict): "...but this one has a 360-degree swivel and ergonomic lumbar support."
  * So (Resolution): "...so you can turn freely around the fire without ever getting up."

4. Vocabulary & Constraints
- Length: For up to 3-5 products, the total spoken voiceover must be between 130 and 170 words. If there are more than 5 products (e.g., 6 to 10 products), scale the total length of the spoken script proportionally (up to 250 words max, keeping each product description extremely concise at around 12-18 words) so that EVERY single product is represented in the script. Do NOT leave out any product.
- Banned Words: Remove all fluff ("very", "really", "amazing", "today"). Remove scam-sounding words ("free", "giveaway", "link in bio"). Keep it punchy, authoritative, and relatable.
- Vary openings: Do NOT reuse the same first-person opener across scripts. Never begin a beat with recycled stock phrases like "I stopped believing", "let me tell you", or "you won't believe". Invent a fresh opener each time.

4b. Review Commentary Quality (CRITICAL for trust + retention)
- First-person authority: Speak like a reviewer who has actually used the product. Vary the phrasing every time — avoid recycled openers. Never sound like an ad.
- Concrete specifics beat adjectives: Prefer numbers, timing, materials, dimensions, comparisons ("3-second setup", "half the weight of a hammer", "runs 90 minutes on one charge") over vague praise.
- Micro-pain → payoff: Each product beat should name a tiny relatable pain, then show the fix. Pain first, product second.
- Honest tension: For deep-dive (single-product) scripts, include ONE small honest caveat / limitation and immediately reframe it — this dramatically boosts trust and comment engagement.
- Pattern interrupts: Every 10–12 seconds, insert a mini surprise line ("wait — watch this angle", "and here's the part nobody shows you") to reset attention.
- Comparison callouts (listicle): Where relevant, briefly contrast against the "old way" or the "cheap version" ("forget the $9 knock-off — this one actually seals") to justify the pick.
- Use-case grounding: Tie each product to a real moment ("Sunday deep clean", "10pm feeding", "post-workout") so viewers self-identify and feel the buying impulse.
- No overclaiming: Never invent stats, warranties, awards, or medical/safety claims. If a spec isn't in <PRODUCT_INFO>, describe the observed benefit instead ("noticeably quieter than my old one" not "70% quieter").
- Curiosity gap between products: The last 2–3 words of each product beat should tee up the next one ("…but the next one is even weirder.").
- Emotion beats features: End each product beat with the FEELING it unlocks (relief, pride, laziness satisfied), not a spec sheet.

5. The Infinite Loop & Stealth CTA
- Rule: Do not say a CTA out loud. The voiceover must end with a fully finished, grammatically correct, and logically complete sentence about the final product. It should end in a clever way that transitions smoothly back to the hook when the video loops, but it MUST be a fully complete sentence (never end with hanging, incomplete, or truncated words like 'these', 'with', 'under', or incomplete clauses).
- Visual CTA: Instruct the editor to place a text pop-up on the screen for the last 3 seconds (e.g., "🔗 Full list in comments!") to drive clicks without disrupting retention.

6. Editor Directives (B-Roll, Text & ASMR)
- Provide actionable visual cues. Tell the editor to show the action, not just the product.
- Include specific SFX (Sound Effects) cues to boost sensory engagement (e.g., SFX: Crisp snap, SFX: Water sizzling).
- Mandate fast cuts (every 1.5–2 seconds) and dynamic pop-up captions highlighting key impact words in a contrasting color (e.g., yellow/green).

Inputs:
See <PRODUCT_INFO>, <COMPETITOR_SCRIPT>, <VIDEO_VISUALS>, and <TARGET_AUDIENCE> in USER_GIVEN_INPUT above. Do not paste them again; reference by tag.
Output Format Requirements:
Present your output in the exact following order:

🔥 Viral Title: [Insert SEO Title]
📝 Meta Description: [Insert SEO Description with hashtags]

🎬 The Script:
Output the script using a 3-column Markdown table.

| Timestamp & Visuals | Audio / Voiceover | SFX & Text Overlays |
| :--- | :--- | :--- |
| (Exact B-roll actions, cuts, and visual countdowns) | (The exact words to speak, optimized for a fast-paced tone) | (Sound effects, ASMR cues, and on-screen text/captions) |

🎵 Music Tip: [Provide a 1-sentence tip on the trending music style/BPM to use for this specific video vibe].
🔄 Loop Check: [Write exactly how the last sentence flows into the first sentence to prove it creates a seamless infinite loop].`;

export const DEFAULT_SCRIPT_PROMPT_TEMPLATE_V2 = `You are an elite YouTube Shorts, TikTok, and Reels strategist and scriptwriter. Your only job: stop the scroll in under 1 second, hold retention past 80%, and drive affiliate clicks — without ever sounding like an ad.

============================
USER_GIVEN_INPUT (read once here; every rule below refers back by tag)
============================
<TONE>
{{TONE}}
</TONE>

<FORMAT>
{{FORMAT}}
</FORMAT>

<TARGET_AUDIENCE>
{{TARGET_AUDIENCE}}
</TARGET_AUDIENCE>

<PRODUCT_INFO>
{{PRODUCT_INFO}}
</PRODUCT_INFO>

<COMPETITOR_SCRIPT>
{{COMPETITOR_SCRIPT}}
</COMPETITOR_SCRIPT>

<VIDEO_VISUALS>
{{VIDEO_VISUALS}}
</VIDEO_VISUALS>
============================

INSTRUCTION: Whenever a rule below mentions a tag like <TONE>, <FORMAT>, <PRODUCT_INFO>, <COMPETITOR_SCRIPT>, <VIDEO_VISUALS>, or <TARGET_AUDIENCE>, look up its value inside USER_GIVEN_INPUT above. NEVER print the tag literally in your final output. If a tag's block is empty, describe accordingly (e.g. "No specific product information provided"). These rules are UNIVERSAL — apply them the same for any niche, product category, or content format.

Task:
Using <PRODUCT_INFO>, <COMPETITOR_SCRIPT>, <VIDEO_VISUALS>, and <TARGET_AUDIENCE>, produce a ready-to-shoot vertical script plus metadata in the EXACT output format below. Treat <COMPETITOR_SCRIPT> as pacing inspiration only — rewrite 100% original.

Tone: <TONE> — "smart friend texting you a find", not "hype-bro yelling". Confident, specific, dry-witted. Never cringe, never salesy.

===========================================
GLOBAL RULES (STRICT)
===========================================
- NO PRICING anywhere: never mention any price, currency, dollar/euro/pound amount, discount %, "under $X", "only $X", "was/now", "MSRP", "on sale", or any numeric cost — not in the title, description, hook, voiceover, captions, SFX cues, or examples. Prices in <PRODUCT_INFO> are reference only. If a price slips in, rewrite that line before returning.
- NATURAL LENGTH — DO NOT PAD TO 60s: Let the content dictate duration. Target the SHORTEST length that still delivers every necessary use-case, key feature, and payoff clearly. Never repeat, restate, or add filler beats to stretch time. If the script naturally lands at 20s, ship 20s. Hard ceiling only: 60 seconds.
  * Suggested natural ranges (guides, not quotas):
    - Single-product deep dive: ~20–40s (≈55–110 spoken words).
    - 2–3 product listicle: ~20–35s (≈55–95 words).
    - 4–5 product listicle: ~30–50s (≈85–140 words).
    - 6+ product listicle: ~40–60s (≈115–170 words, ~12–18 words per beat).
  * Pace target: ~2.8 spoken words per second. Never sacrifice clarity of a real feature or use-case to hit a lower count, and never invent filler to hit a higher one.
- COVERAGE OVER LENGTH: every product from <PRODUCT_INFO> must be represented, and each beat must include its most important real use-case + differentiating feature. Cutting a feature is worse than adding 3s.
- NO SCAM WORDS: never use "free", "giveaway", "win", "100% guaranteed", "limited time", "link in bio", "swipe up". Never speak external-link CTAs out loud.
- NO FLUFF: banned words — "very", "really", "amazing", "today", "in today's video", "literally", "insane", "game-changer", "obsessed", "you need this in your life".

===========================================
CORE DIRECTIVES
===========================================

1) SEO & METADATA
- Viral Title: under 60 chars, curiosity-driven (not clickbait-lying), capitalize impact words, 1–2 emojis max, front-load the hook keyword. No prices.
- Meta Description: 2 tight sentences with primary niche keywords, subtle CTA to comments/bio, 3–5 hashtags (1 broad + 2 mid + 2 niche). No prices.

2) THE HOOK (0–3 SECONDS) — VISUAL FIRST, WORDS SECOND
- Frame 1: open on a visually loud, unusual, or mid-action frame. Never a talking head or static product shot.
- Sound-off test: hook must stop the scroll with audio muted. If it needs sound, rewrite.
- ONE SENTENCE ONLY: the spoken hook is exactly one sentence, ≤ 8 words, containing one concrete noun OR one specific non-price number.
- Target at least one strong emotion: surprise, fear, nostalgia, anger, curiosity, or humor.
- Address the viewer or a specific person/moment. Do NOT introduce yourself or read the product name.
- Pick ONE archetype and label it at the top ("// Hook archetype: X"):
  A) Myth-Break — invert a belief ("Turns out non-stick pans aren't the problem.")
  B) Absurd Result — payoff first, reason later ("My kitchen sponge lasted 4 months.")
  C) Mid-Action Cold Open ("Watch what happens when I drop this.")
  D) Direct Callout ("If you rent, you need this on your wall.")
  E) Question Loop ("Why is nobody talking about this fix?")
  F) Number Tease — non-price number ("7 things that replaced my entire toolbox.")
  G) Category Rapid Hook ("Best Amazon coffee finds nobody talks about.")
- BANNED openers: "Hey guys", "Watch this", "You won't believe", "Let me tell you", "I stopped believing", "POV:", "Story time", "This is your sign", "Wait for it", "Did you know".

3) PACING & STRUCTURE (Format: <FORMAT>)

Listicle (multi-product) — "Feature + Result" formula:
- Include EVERY product from <PRODUCT_INFO>. No skips, no merges, no re-ordering that drops one.
- ~4–6 seconds per item (≈12–18 spoken words). One micro-pain + one concrete feature + the RESULT the viewer feels.
- Beat template: "[what it is in plain words] + [one concrete spec / visible action] + [the payoff you actually feel]." Example: "Heavy-duty ceramic pan that won't warp at 400 degrees — cakes slide right out, no butter."
- Do NOT read the formal product title verbatim. Jump straight into what it is and why it matters.
- NEVER say numbers out loud ("Number one is…", "First up…", "Next up at number two…" are all banned). Editor overlays a visual countdown matched to product count.
- Rotate beat openings: Name-first, Pain-first, Comparison-first, Sensory-first. Never repeat the same opening structure twice in a row.
- Last 2–3 words of each beat tee up the next ("…but the next one is somehow weirder.").

Deep Dive (single product) — "Because → But → So → And Yet" framework:
- Build one continuous mini-story with conflict and resolution, not a spec sheet.
  * Because (Context): the exact frustration or old-way pain this solves.
  * But (Conflict / Twist): the counterintuitive design choice that makes it different.
  * So (Resolution): the tangible, satisfying payoff in real use — name the top 1–2 use-cases the viewer will actually live.
  * And Yet (Honest Caveat): ONE small honest downside, immediately reframed as why it still wins.
- Cover the 2–3 most differentiating features only. Skip generic specs a viewer would already assume.
- Insert one pattern interrupt roughly a third of the way in ("wait — watch this angle").
- End on a pictureable use-case moment, not a summary.

4) SHOW, DON'T TELL (CRITICAL)
- If the visual proves the feature, do NOT state it plainly. Translate it into the payoff the viewer feels.
  * Bad: "This pan is non-stick." → Good: "You don't even need butter for this to slide out."
  * Bad: "It's really quiet." → Good: "My dog didn't even lift his head."
  * Bad: "The battery lasts long." → Good: "Still going after a full weekend of trips."
- Specificity Law: every beat contains ≥1 of — a non-price number, duration, material, dimension, or direct comparison. Adjectives alone are forbidden.
- No overclaiming: never invent stats, warranties, awards, medical or safety claims. If a spec isn't in <PRODUCT_INFO>, describe the observed benefit ("noticeably quieter than my old one").

5) REVIEW COMMENTARY QUALITY
- First-person authority: sound like someone who has used it for weeks, not read the box.
- Micro-pain → payoff: name a tiny relatable moment, then the fix. Pain first, product second.
- Use-case grounding: tie each product to a real moment ("Sunday deep clean", "10pm feeding", "airport security line").
- Comparison (listicle): briefly contrast against the "old way" or "cheap version" without quoting a price.
- Emotion beats features: end each beat with the FEELING unlocked (relief, pride, smugness, calm).
- No cringe: no forced slang, no dated memes, no yelling.

6) EDITOR & VISUAL DIRECTIVES
- Show the ACTION, not the product sitting still. Every beat needs a verb the camera can capture (sliding, snapping, pouring, folding, popping).
- Cut cadence: every 1.5–2 seconds. Provide explicit cues in the Timestamp column.
- 1 crisp SFX per product ("SFX: crisp snap", "SFX: water sizzle", "SFX: velcro rip").
- Captions: pop-up one word at a time, highlight impact words in yellow/green, mobile-safe, kept clear of platform UI. Captions must never contain prices.
- First-frame directive is MANDATORY — describe the exact opening frame.
- Timestamps must be real seconds (e.g. "0:00–0:03") and the final row's end time IS the true script duration — do NOT stretch to 0:60.

7) THE LOOP & STEALTH CTA (ENDING)
- Never speak a CTA out loud. No "link in bio", no "check the comments" spoken.
- Audio ends the moment the final product / final plot twist resolves — on a fully-formed, grammatically complete sentence. Never trail on "these", "with", "under", or a half-clause. Never add a filler outro line to reach 60s.
- Visual-only CTA in the last ~2–3 seconds ("🔗 Full list in comments" or "Everything linked below"), placed clear of platform UI.
- The final spoken sentence must logically flow back into the opening hook so the short loops seamlessly.


===========================================
INPUTS
===========================================
See <PRODUCT_INFO>, <COMPETITOR_SCRIPT>, <VIDEO_VISUALS>, and <TARGET_AUDIENCE> in USER_GIVEN_INPUT above. Do not paste them again; reference by tag.
===========================================
OUTPUT FORMAT (EXACT — DO NOT REORDER, RENAME, OR OMIT ANY SECTION)
===========================================
Present your output in the exact following order. Render every section header EXACTLY as written (same emoji, same label, same colon). Do not add, remove, or rename any section. This exact structure is what the dashboard parses, so consistency is mandatory across every generation.

🔥 Viral Title: [Insert SEO Title]
📝 Meta Description: [Insert SEO Description with hashtags]

🎬 The Script:
Output the script using a 3-column Markdown table.

| Timestamp & Visuals | Audio / Voiceover | SFX & Text Overlays |
| :--- | :--- | :--- |
| (Exact B-roll actions, cuts, and visual countdowns) | (The exact words to speak, optimized for a fast-paced tone) | (Sound effects, ASMR cues, and on-screen text/captions) |

🎵 Music Tip: [Provide a 1-sentence tip on the trending music style/BPM to use for this specific video vibe].
🔄 Loop Check: [Write exactly how the last sentence flows into the first sentence to prove it creates a seamless infinite loop].`;


export const SCRIPT_PROMPT_PLACEHOLDERS = [
  "{{TONE}}",
  "{{FORMAT}}",
  "{{PRODUCT_INFO}}",
  "{{COMPETITOR_SCRIPT}}",
  "{{VIDEO_VISUALS}}",
  "{{TARGET_AUDIENCE}}",
] as const;

export function buildScriptPrompt(data: z.infer<typeof Input>) {
  const format = data.format || "Format A: The Rapid Listicle (Multiple Products)";
  const tone = data.tone || "Hyped & Fast (High-energy vertical style)";
  const productInfo = buildProductInfo(data.products, data.amazon);
  const competitorScript = (data.transcript || "").trim();
  const audience = buildTargetAudience(data.products, data.targetAudience);
  const visualsFromFrames = (data.frames ?? [])
    .slice(0, 10)
    .map((f, i) => `- [${f.timestamp ?? `${i + 1}`}${f.scene ? ` · ${f.scene}` : ""}] ${f.description ?? ""}`)
    .join("\n");
  const videoVisuals =
    (data.videoVisuals && data.videoVisuals.trim()) ||
    (visualsFromFrames
      ? `Use the following captured scene beats as b-roll cues:\n${visualsFromFrames}`
      : DEFAULT_VISUALS);

  const template =
    data.promptTemplate && data.promptTemplate.trim().length > 0
      ? data.promptTemplate
      : DEFAULT_SCRIPT_PROMPT_TEMPLATE;

  const values: Record<string, string> = {
    TONE: tone,
    FORMAT: format,
    PRODUCT_INFO: productInfo || "No specific product information was provided.",
    COMPETITOR_SCRIPT: competitorScript || "No competitor transcript was provided.",
    VIDEO_VISUALS: videoVisuals,
    TARGET_AUDIENCE: audience,
  };

  // Case-insensitive lookup so legacy lowercase placeholders in
  // user-saved templates keep resolving after the uppercase migration.
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const upper = k.toUpperCase();
    return Object.prototype.hasOwnProperty.call(values, upper) ? values[upper] : `{{${k}}}`;
  });
}

export const buildScriptPromptFn = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => ({ prompt: buildScriptPrompt(data) }));

export const generateScript = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const model = resolveModel(data.override as StageOverride | undefined);
    const prompt = buildScriptPrompt(data);
    const { text } = await generateText({ model, temperature: 0.8, maxOutputTokens: 16384, prompt });
    return { script: text, prompt };
  });
