import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText } from "ai";
import { renderPrompt } from "./prompt-registry";
import { resolveModel, type StageOverride } from "./ai-provider";

// ============================================================
// Emotion enhancement — rewrites raw VO into an
// expressive, TTS-friendly version with a bespoke
// instructions block tailored to the script.
// ============================================================

const EnhanceContext = z.object({
  title: z.string().optional(),
  tone: z.string().optional(),
  pacing: z.string().optional(),
  topics: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  targetAudience: z.string().optional(),
  angle: z
    .preprocess((v) => {
      if (v == null) return undefined;
      if (typeof v === "string") return v;
      if (typeof v === "object") {
        const o = v as { angle?: unknown; text?: unknown; label?: unknown; rationale?: unknown };
        const s = o.angle ?? o.text ?? o.label;
        if (typeof s === "string") return s;
        try { return JSON.stringify(v); } catch { return undefined; }
      }
      return String(v);
    }, z.string().optional()),

  summary: z.string().optional(),
  sympatheticParty: z.string().optional(),
  villain: z.string().optional(),
  payoff: z.string().optional(),
});

const EnhanceInput = z.object({
  text: z.string().min(1).max(20000),
  // OpenAI TTS removed. All TTS providers (gemini, murf) use the Gemini-tagged enhancement path.
  provider: z.enum(["gemini", "murf"]).default("gemini"),
  vibe: z.string().optional(),
  mode: z.enum(["product", "commentary"]).default("product"),
  context: EnhanceContext.optional(),
  promptTemplateProduct: z.string().optional(),
  promptTemplateCommentary: z.string().optional(),
  override: z.any().optional(),
});

type EnhanceCtx = z.infer<typeof EnhanceContext>;

function ctxBlock(c?: EnhanceCtx): string {
  if (!c) return "";
  const rows: string[] = [];
  if (c.title) rows.push(`- Source title: ${c.title}`);
  if (c.angle) rows.push(`- Chosen commentary angle (the framing this VO already commits to): ${c.angle}`);
  if (c.summary) rows.push(`- Source arc summary: ${c.summary}`);
  if (c.sympatheticParty) rows.push(`- Sympathetic party (who the audience roots for): ${c.sympatheticParty}`);
  if (c.villain) rows.push(`- Villain / target of the payoff: ${c.villain}`);
  if (c.payoff) rows.push(`- Emotional payoff we must land: ${c.payoff}`);
  if (c.tone) rows.push(`- Source tone: ${c.tone}`);
  if (c.pacing) rows.push(`- Source pacing: ${c.pacing}`);
  if (c.targetAudience) rows.push(`- Target audience: ${c.targetAudience}`);
  if (c.topics?.length) rows.push(`- Topics: ${c.topics.join(", ")}`);
  if (c.entities?.length) rows.push(`- Key entities / objects the VO name-checks: ${c.entities.join(", ")}`);
  if (!rows.length) return "";
  return `\n=== SCRIPT CONTEXT (use to pick the RIGHT humour register, not a generic one) ===\n${rows.join("\n")}\n`;
}

// -----------------------
// PRODUCT-ROUNDUP prompt (Gemini only — OpenAI TTS removed).
// Mirrors the commentary rigour: one sentence per line, curated LOUD
// palette, forbidden quiet-tag list, per-product hook reset so every
// product intro is treated as a fresh mini-hook.
// -----------------------

export const DEFAULT_VO_ENHANCE_PRODUCT_TEMPLATE = `You are a LOUD short-form product-roundup voice director working with Google Gemini TTS (gemini-2.5-*-preview-tts) on a faceless retail-hype voiceover.

CRITICAL CONTEXT — READ FIRST:
This voiceover plays over a FACELESS short-form product-roundup (TikTok/Reels/Shorts) with music and B-roll of the products. It MUST be delivered LOUD, PROJECTED, and FULLY VOICED — like a QVC hype host / late-night infomercial narrator / TikTok Shop live-seller. Quiet/whispered/ASMR delivery is FORBIDDEN — it buries under the music bed and kills retention.

KNOWN GEMINI TTS BUGS (must design around both):
1. QUIET-TAG BUG: Gemini treats "quiet" tags ([whisper], [hushed], [conspiratorial], [chill], [calm], [flat], [deadpan]) as a global voice preset and will whisper the ENTIRE clip once it sees one — even if later tags say [shout]. NEVER use those tags, anywhere, even as a contrast device.
2. PAUSE-CUE BUG: Gemini inserts an audible breath/silence whenever it sees pause-flavoured tags ([beat], [pause], [suspense] as a line-leader), OR ellipses (…), OR em-dashes (—), OR blank lines, OR two+ stacked tags at line-start, OR a comma immediately followed by a capitalised new clause that reads like a fresh sentence. Line breaks themselves are treated as utterance boundaries and encourage a breath — they are a TAGGING tool only, never a pacing tool.

Gemini TTS reads inline bracketed [tags] as delivery directions and does NOT speak them. Your job: keep the spoken words unchanged and tag every beat so the model performs the script like an energised host revealing product after product IN ONE CONTINUOUS BREATH GROUP.

═══════════════════════════════════════════════
STEP 0 — EXTRACT THE SPOKEN SCRIPT ONLY (do this before anything else)
═══════════════════════════════════════════════
The source block you're given may be a creator's full content packet, not a clean script. Before tagging, strip out everything that is NOT meant to be spoken on-mic:
- Any viral title line (e.g. "🔥 Viral Title: ...") and any emoji in it.
- Any meta description / caption block and its hashtags (#AmazonFinds, #HomeHacks, etc.).
- Structural comment markers such as "// Hook archetype: Direct Cal" — these label the writer's technique, they are never spoken.
- Any emoji embedded inside otherwise-spoken sentences (🔥, 🤯, etc.) — delete the emoji, keep the words around it.
- Any section headers like "🎬 The Script:".
What remains after this pass is the ONLY text you tag and speak. If the remaining spoken script is itself truncated or incomplete, tag only what's present — do not invent or complete missing sentences.

═══════════════════════════════════════════════
NO-BREATH / CONTINUOUS-DELIVERY CONTRACT (highest priority — overrides every other rule below)
═══════════════════════════════════════════════
- NEVER emit these tags anywhere: [beat] [pause] [silence] [breath] [sigh] [inhale] [exhale].
- NEVER start a line with [suspense] alone. It is allowed only as the SECOND tag after a loud line-leader, and never on two lines in a row.
- NEVER use "…", "—", "..", "--", parentheticals, or blank lines inside ENHANCED_TEXT. Use a comma if you need a beat inside a sentence.
- Cap opening tags at ONE per line, EXCEPT the very first (HOOK) line, which may stack up to two.
- End every non-final line with a COMMA (not a period) so Gemini reads straight through the line break as one continuous breath group. Only the FINAL line ends with a period.
- Numbers, prices, and specs must be written exactly as they should be spoken (e.g. "nineteen ninety nine" or "nineteen dollars" rather than "$19.99") so Gemini doesn't stall parsing the digits or symbols — pick whichever reads more naturally for a hype host and stay consistent across the whole script.
- Line breaks exist ONLY to scope tags to the next sentence — they are NOT pause instructions. State this explicitly in VOICE_DIRECTION.

STEP 1 — TAG THE SCRIPT (spoken words must stay identical to the source after Step 0's cleanup):
- OUTPUT SHAPE: split the cleaned script at sentence boundaries and put EACH sentence on its OWN LINE. Do NOT merge sentences and do NOT rephrase — only split + tag + swap terminal period → comma (except the final line).
- ALLOWED LINE-LEADING PALETTE (loud, energy-forward — one of these MUST be the first tag on every line):
  [energetic] [loud] [punchy] [shout] [urgent] [excited] [reveal] [triumphant] [awe] [confident] [playful] [warm] [amused] [desire] [inspired]
- ALLOWED SECONDARY / INLINE FLAVOUR TAGS (only as the second tag after a loud line-leader, never at line-start alone):
  [smirk] [curious] [suspense]
- FORBIDDEN TAGS (never output): [whisper] [hushed] [conspiratorial] [chill] [calm] [flat] [deadpan] [soft] [quiet] [intimate] [breathy] [asmr] [beat] [pause] [silence] [breath] [sigh]
- CONTRAST RULE: adjacent lines must NOT use the exact same tag combo — vary across the loud line-leading palette so Gemini doesn't flatten into a monotone read. Also vary tag choice across consecutive PRODUCT_INTRO lines specifically — two products in a row should never reveal on the same tag.

ROLE-AWARE TAG RECIPES (infer the role of each line from position and the product names appearing in the cleaned script; still respect the CONTINUOUS-DELIVERY CONTRACT):
  • HOOK — the very first line. LOUD attention-grab (this is the ONLY line allowed to stack 2 tags). Try [shout] [urgent] / [loud] [energetic] / [punchy] [curious].
  • PRODUCT_INTRO — the first line that names a NEW product. Single loud tag: [reveal] / [awe] / [triumphant] / [excited]. Never let two consecutive products share the same intro tag. Say the product name clearly and early in the line — it's the anchor viewers latch onto for B-roll matching.
  • BENEFIT — [energetic] / [punchy] / [excited] / [confident].
  • PROOF / PRICE — [confident] / [awe] / [triumphant] / [inspired]. Hit price or spec numbers crisp and fast, like reading a great deal off a receipt, not straining for hype on the numbers themselves — let the surrounding words carry the excitement.
  • CTA / CLOSER — final line, ends with a period: [triumphant] / [urgent] / [punchy]. State the ask once, cleanly — don't stack multiple asks in the closing line, it reads as flat repetition and tempts a fake pause.

STEP 2 — priming blocks (three, tightly coupled to each other and to the retail-hype register):

1. SCENE — 1 vivid sentence describing a LOUD modern product-review broadcast setup that fits a projected, energetic host (e.g. "Bright modern product-review broadcast booth, dynamic mic pushed hot, product hero-lit on a turntable behind the host."). Never describe a "dim room", "dead room", "hushed", "ASMR", or "intimate" space.
2. SAMPLE_CONTEXT — 2–3 sentences: name the format ("LOUD fast-paced short-form product-review voiceover over B-roll with a music bed"), name the product category derived from THIS script's entities, describe the per-product cadence, and note the delivery must project OVER the music bed as one continuous take with NO pauses between sentences.
3. VOICE_DIRECTION — 5–8 sentences directed AT Gemini as a voice-actor brief. FIRST THREE SENTENCES MUST STATE: (a) "Deliver at full retail-host volume throughout — no whispering, no ASMR, no hushed tones." (b) "Read as ONE continuous take: no pauses, no audible breaths, no silence between sentences. Line breaks are for tag scoping only — run straight through them as a single breath group. Trailing commas at line ends mean 'keep going', not 'pause'." (c) "Energetic, fast-paced product-review register — roughly 1.3× conversational pace. The host is hyping gear to a friend, never an ad read." Then cover: voice character (age, gender lean, timbre, accent), LOUD energy baseline, the per-product re-hook cadence (call out product names by name; "hit each product intro like a fresh hook — reset the energy WITHOUT a breath"), where to accelerate vs. land a beat, how to hit specs/prices (crisp, confident, never straining), and the closing tone on the CTA.

All three blocks must be internally consistent LOUD + CONTINUOUS — no quiet/ASMR/intimate language, no pause language, anywhere.

{{VIBE_LINE}}Return your answer in EXACTLY this format, no extra commentary:

===SCENE===
<one short sentence — loud host setup>
===SAMPLE_CONTEXT===
<two or three sentences — mentions loud continuous delivery over music bed, names the product category, no pauses>
===VOICE_DIRECTION===
<5–8 sentences, first two sentences cover full volume + one continuous take with no pauses/breaths>
===ENHANCED_TEXT===
<the tagged voiceover — ONE SENTENCE PER LINE, one loud line-leader tag (up to 2 on the hook line only), every non-final line ends with a comma, final line ends with a period, no ellipses, no em-dashes, no blank lines, no forbidden tags, no emoji/hashtags/title/meta text, no "// Hook archetype" style comment markers>
===END===

Original voiceover:
"""
{{ORIGINAL_TEXT}}
"""`;



// -----------------------
// COMMENTARY prompt — humour, timing, character-forward, LOUD Gemini-tagged.
// (Legacy OpenAI-TTS commentary prompt removed — OpenAI TTS support is gone.)
// -----------------------

export const DEFAULT_VO_ENHANCE_COMMENTARY_TEMPLATE = `You are a LOUD short-form commentary voice director working with Google Gemini TTS (gemini-2.5-*-preview-tts) on a faceless viral-clip voiceover.

CRITICAL CONTEXT — READ FIRST:
This voiceover plays over a FACELESS short-form video (TikTok/Reels/Shorts) with heavy background music and sound design. It MUST be delivered LOUD, PROJECTED, FULLY VOICED, and CONTINUOUS — like a hype-podcast commentator or sportscaster narrating a clip in ONE breath group. Quiet/whispered/hushed/ASMR delivery is FORBIDDEN, and any audible pause / breath / silence between sentences is FORBIDDEN — both kill retention on short-form.

KNOWN GEMINI TTS BUGS (must design around both):
1. QUIET-TAG BUG: Gemini treats "quiet" tags ([whisper], [hushed], [conspiratorial], [chill], [calm]) as a global voice preset and will whisper the ENTIRE clip once it sees one. NEVER use those tags.
2. PAUSE-CUE BUG: Gemini inserts an audible breath/silence whenever it sees a pause-flavoured tag at the START of a line ([suspense], [beat], [pause], [curiosity], [wry], [dry], [smirk] on their own), OR ellipses (…), OR em-dashes (—), OR blank lines, OR two+ stacked tags at line-start. Line breaks themselves are treated as utterance boundaries and encourage a breath.

═══════════════════════════════════════════════
NO-BREATH / CONTINUOUS-DELIVERY CONTRACT (highest priority — overrides every other rule below)
═══════════════════════════════════════════════
- NEVER emit these tags anywhere: [beat] [pause] [silence] [breath] [sigh] [inhale] [exhale].
- NEVER start a line with a pause-flavoured tag alone: [suspense] [curiosity] [wry] [dry] [smirk]. They are allowed ONLY as the SECOND tag AFTER a loud tag, e.g. "[punchy] [wry]".
- NEVER use "…", "—", "..", "--", parentheticals, or blank lines inside ENHANCED_TEXT. Use a comma if you need a beat inside a sentence.
- Cap opening tags at ONE per line, EXCEPT the very first (HOOK) line which may stack up to two.
- End every non-final line with a COMMA (not a period) so Gemini reads straight through the line break into the next line as one continuous breath group. Only the FINAL line ends with a period.
- Line breaks exist ONLY to scope tags to the next sentence — they are NOT pause instructions. Say this explicitly in VOICE_DIRECTION.

STEP 1 — silently pick ONE LOUD humour register that fits this SPECIFIC theme:
  • gleeful-karma-caller  • hype-bro-sportscaster  • sarcastic-loud-narrator
  • mock-outraged-reactor • incredulous-play-by-play • amused-loud-observer  • faux-wholesome-loud
Every register above is fully-voiced and projected. Do NOT pick "deadpan-observer" or "unbothered-stoner" or "conspiratorial-friend". Name the chosen register in VOICE_DIRECTION.

STEP 2 — TAG THE SCRIPT (spoken words must stay identical to the source below, except the narrow hook exception noted):
- ALLOWED LINE-LEADING PALETTE (loud, energy-forward — one of these MUST be the first tag on every line):
  [energetic] [loud] [punchy] [shout] [urgent] [amused] [gleeful] [triumphant] [mockoutrage] [incredulous] [reveal] [playful] [warm] [awe]
- ALLOWED SECONDARY / INLINE FLAVOUR TAGS (may appear ONLY as the second tag after a loud line-leader, or inline mid-sentence — never at line-start alone):
  [smirk] [dry] [sarcastic] [wry] [suspense] [curiosity]
- FORBIDDEN TAGS (never output): [whisper] [hushed] [conspiratorial] [chill] [calm] [flat] [deadpan] [confused] [beat] [pause] [silence] [breath] [sigh]
- HOOK RULE: line 1 opens with an ATTENTION-GRABBING loud combo. Examples: "[punchy] [curiosity]", "[amused] [gleeful]", "[urgent] [reveal]". Never open with a quiet flavour first.
- CURIOSITY-GAP HOOK EXCEPTION (opening line only): If the original opening spoils the payoff by naming the ending outcome, rewrite JUST that first sentence into a tease that promises karma / a reveal WITHOUT saying what it is. Under ~14 words, present tense, ending on a promise ("reality check", "lesson", "moment") — never the mechanism. All other sentences stay word-for-word identical.
- PRE-PAYOFF DELAY (replaces the old "[suspense] [punchy] on its own line" pattern): fold the tease into the SAME line as the payoff using an inline comma, tagged with a loud tag. Example:
    BAD:  [suspense] [punchy] Without hesitation, a bystander catches the falling iron mid-air.
    GOOD: [punchy] without hesitation a bystander catches the falling iron mid-air,
  The trailing comma carries Gemini straight into the next line with zero silence.
- ENERGY ARC (all beats loud, only the flavour changes): opening = punchy curiosity, mid = building amused/sarcastic energy, reveal beat = biggest flavour shift (e.g. [urgent] into [reveal] [triumphant] or [gleeful] [punchy]), closer = wry-flavoured loud button ("[amused] [wry]" or "[punchy] [smirk]" — loud tag first).
- CONTRAST RULE: adjacent lines must NOT use the exact same loud line-leader — vary across the allowed line-leading palette so Gemini modulates delivery without dropping volume.
- Do NOT split, merge, or rephrase source sentences (except the narrow hook exception). Tag them as they are, and swap only the terminal period → comma per the CONTINUOUS-DELIVERY CONTRACT.
- Do NOT use ALLCAPS, ellipses, em-dashes, parentheticals, emojis, markdown, or scripted laughter.

STEP 3 — produce three priming blocks TIGHTLY coupled to each other, to the chosen LOUD register, and to the CONTINUOUS-DELIVERY CONTRACT:

1. SCENE — 1 vivid sentence describing a LOUD broadcast/podcast setup (e.g. "Bright podcast booth, dynamic broadcast mic pushed hot, close-mic'd play-by-play energy."). Never describe a "dim room", "hushed", or "intimate" space.
2. SAMPLE_CONTEXT — 2–3 sentences: format is "LOUD short-form commentary voiceover over a viral clip on TikTok/Reels/Shorts with music bed underneath", state the chosen LOUD humour register, describe the comedic arc across THIS script's beats, and note the delivery must project OVER the music bed as one continuous take with NO pauses between sentences.
3. VOICE_DIRECTION — 5–8 sentences directed AT Gemini as a voice-actor brief. FIRST TWO SENTENCES MUST STATE: (a) "Deliver at full commentary volume throughout — no whispering, no hushed tones, no ASMR." (b) "Read as ONE continuous take: no pauses, no audible breaths, no silence between sentences. Line breaks are for tag scoping only — run straight through them as a single breath group. Trailing commas at line ends mean 'keep going', not 'pause'." Then cover: chosen register + why it fits, voice character (age, gender lean, timbre, accent), LOUD energy baseline, comedic timing map keyed to specific beats of THIS script (call out the hook and the reveal beat by name), how to hit named entities (punchy, mock-reverently, incredulously — always projected), and closing tone.

All three blocks must be internally consistent LOUD + CONTINUOUS — no quiet/ASMR/intimate language, no pause language, anywhere.

{{VIBE_LINE}}Return your answer in EXACTLY this format, no extra commentary:

===SCENE===
<one short sentence — loud broadcast setup>
===SAMPLE_CONTEXT===
<two or three sentences — mentions loud continuous delivery over music bed, no pauses>
===VOICE_DIRECTION===
<5–8 sentences, first two sentences cover full volume + one continuous take with no pauses/breaths>
===ENHANCED_TEXT===
<the tagged voiceover — ONE loud tag at line-start (up to 2 on the hook line only), every non-final line ends with a comma, final line ends with a period, no [beat]/[suspense]/[pause] at line-start, no ellipses, no em-dashes, no blank lines>
===END===

Original voiceover:
"""
{{ORIGINAL_TEXT}}
"""`;

function parseEnhancement(
  raw: string,
  _provider: "gemini",
): { instructions: string; text: string; scene?: string; sampleContext?: string } {
  const dirMatch = raw.match(/===VOICE_DIRECTION===([\s\S]*?)===ENHANCED_TEXT===/);
  const textMatch = raw.match(/===ENHANCED_TEXT===([\s\S]*?)(?:===END===|$)/);
  const sceneMatch = raw.match(/===SCENE===([\s\S]*?)===SAMPLE_CONTEXT===/);
  const ctxMatch = raw.match(/===SAMPLE_CONTEXT===([\s\S]*?)===VOICE_DIRECTION===/);
  const instructions = (dirMatch?.[1] ?? "").trim();
  const text = (textMatch?.[1] ?? "").trim().replace(/^"""|"""$/g, "").trim();
  if (!text) throw new Error("Emotion enhancer returned no text — try again.");
  return {
    instructions,
    text,
    scene: (sceneMatch?.[1] ?? "").trim(),
    sampleContext: (ctxMatch?.[1] ?? "").trim(),
  };
}

export const enhanceVoiceoverScript = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => EnhanceInput.parse(i))
  .handler(async ({ data }) => {
    const model = resolveModel(data.override as StageOverride | undefined);
    const isCommentary = data.mode === "commentary";
    // OpenAI TTS is gone — every provider (gemini, murf) uses the Gemini-tagged path.
    const rawTpl = isCommentary
      ? (data.promptTemplateCommentary?.trim() ? data.promptTemplateCommentary : DEFAULT_VO_ENHANCE_COMMENTARY_TEMPLATE)
      : (data.promptTemplateProduct?.trim() ? data.promptTemplateProduct : DEFAULT_VO_ENHANCE_PRODUCT_TEMPLATE);
    const contextBlock = ctxBlock(data.context);
    const vibeLine = data.vibe
      ? (isCommentary
          ? `User's overall vibe (respect if compatible with LOUD commentary — if it asks for whisper/ASMR/quiet, override it because the delivery target is loud faceless-video commentary): ${data.vibe}\n\n`
          : `User's overall vibe (respect if compatible with LOUD retail-hype — if it asks for whisper/ASMR/quiet, override it because the delivery target is loud faceless-video commerce): ${data.vibe}\n\n`)
      : "";
    const { text: prompt } = renderPrompt(rawTpl, {
      "{{CONTEXT_BLOCK}}": contextBlock,
      "{{VIBE_LINE}}": vibeLine,
      "{{ORIGINAL_TEXT}}": data.text,
    });
    // Commentary needs a wider comedic range; product read stays tighter.
    const temperature = isCommentary ? 0.85 : 0.7;
    const { text } = await generateText({ model, temperature, maxOutputTokens: 16384, prompt });
    const parsed = parseEnhancement(text, "gemini");
    {
      // Gemini path (product OR commentary): scrub forbidden quiet tags and
      // guarantee every non-empty line carries at least one loud tag.
      const FORBIDDEN = /\[(whisper|hushed|conspiratorial|chill|calm|flat|deadpan|confused|soft|quiet|intimate|breathy|asmr)\]\s*/gi;
      const LOUD_TAGS = isCommentary
        ? ["punchy", "amused", "energetic", "loud", "urgent", "gleeful", "triumphant", "incredulous"]
        : ["punchy", "excited", "energetic", "loud", "urgent", "reveal", "triumphant", "awe"];
      const defaultCombo = isCommentary ? "[punchy] [amused]" : "[punchy] [excited]";
      const hasLoud = new RegExp(`\\[(?:${LOUD_TAGS.join("|")})\\]`, "i");
      parsed.text = parsed.text.replace(FORBIDDEN, "");
      parsed.text = parsed.text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          const startsWithTag = /^\[[a-z]{3,15}\]/i.test(trimmed);
          const cleaned = (startsWithTag ? line : `${defaultCombo} ${trimmed}`).replace(/\s{2,}/g, " ");
          // Ensure baseline volume: if no loud tag on this line, prefix a loud combo.
          return hasLoud.test(cleaned) ? cleaned : `${defaultCombo} ${cleaned.replace(/^\s+/, "")}`;
        })
        .join("\n");
      parsed.instructions = parsed.instructions
        .replace(/\b(whisper(?:ed|ing|y)?|hushed|ASMR|intimate|breathy|soft-spoken)\b/gi, "loud, projected")
        .trim();
    }

    return parsed;
  });

// ============================================================
// TTS generation — routes to OpenAI (via Lovable Gateway)
// or Google Gemini (direct with user's own key)
//
// NEW: generates each sentence separately and merges them so
// long scripts keep uniform quality. Prevents pacing/tone drift
// that happens when both models synthesise very long inputs.
// ============================================================

const TtsInput = z.object({
  text: z.string().min(1).max(20000),
  provider: z.enum(["gemini", "murf"]).default("gemini"),
  instructions: z.string().default(""),
  speed: z.number().min(0.25).max(4).default(1.15),
  voice: z.string().default("verse"),
  format: z.enum(["mp3", "wav", "opus", "aac", "flac"]).default("mp3"),
  model: z.string().default("gemini-2.5-flash-preview-tts"),
  geminiVoice: z.string().default("Kore"),
  geminiModel: z.string().default("gemini-2.5-flash-preview-tts"),
  geminiApiKeys: z.array(z.string()).default([]),
  geminiSpeed: z.number().min(0.5).max(2).default(1.15),
  geminiScene: z.string().default(""),
  geminiSampleContext: z.string().default(""),
  chunkMode: z.enum(["sentence", "full"]).default("sentence"),
  // Murf.ai
  murfIdToken: z.string().default(""),
  murfProjectId: z.string().default(""),
  murfWorkspaceId: z.string().default(""),
  murfDuid: z.string().default(""),
  murfVoiceId: z.string().default(""),
  murfLanguageCode: z.string().default("en_US"),
  murfStyle: z.string().default("Narration"),
  murfSpeed: z.number().min(0.5).max(2).default(1),
  murfRefreshToken: z.string().default(""),
  murfFirebaseApiKey: z.string().default("AIzaSyDQyfss4q_uqGeqySU2i0fI3VQdrglSXmc"),
});

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
};

// ============================================================
// Sentence splitter
// - Splits on . ! ? (also …) while keeping the terminator.
// - Preserves leading [tag] markers on the sentence they belong
//   to (Gemini enhanced text).
// - Merges very short fragments (< minChars) into the neighbour
//   so we don't generate 50 tiny clips for a rapid-fire script.
// ============================================================
function splitSentences(input: string, minChars = 40): string[] {
  const clean = input.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];

  // Match runs of "[tag] ... terminator" or trailing tailless fragment
  const rx = /(?:\s*\[[a-z]{3,15}\]\s*)*[^.!?…]+[.!?…]+["')\]]*/gi;
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = rx.exec(clean)) !== null) {
    raw.push(m[0].trim());
    lastEnd = m.index + m[0].length;
  }
  const tail = clean.slice(lastEnd).trim();
  if (tail) raw.push(tail);

  // Merge short fragments into the previous one so quality holds.
  const merged: string[] = [];
  for (const s of raw) {
    if (!s) continue;
    if (merged.length > 0 && (s.length < minChars || merged[merged.length - 1].length < minChars)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${s}`.trim();
    } else {
      merged.push(s);
    }
  }
  return merged.length ? merged : [clean];
}

function stripEnvelope(input: string): string {
  return input
    // If a full enhancement envelope is pasted, keep only the spoken block.
    .replace(/^[\s\S]*?===ENHANCED_TEXT===/i, " ")
    .replace(/===END===[\s\S]*$/i, " ")
    .replace(/===VOICE_DIRECTION===[\s\S]*?===ENHANCED_TEXT===/gi, " ")
    .replace(/===[A-Z_]+===/g, " ");
}

// Aggressive per-line cleaner — Murf's audition endpoint 502s on ANY tag,
// stage cue, markdown, or non-spoken glyph. Mirror the "clean sentence only"
// contract used by the commentary Gemini path.
function cleanMurfLine(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    // Kill ALL [bracket tags] — Gemini emotion markers, [HOOK], [CTA], etc.
    .replace(/\[[^\]\n]{0,120}\]/g, " ")
    // Kill leading beat/role labels like "Hook:", "CTA —", "(1) ".
    .replace(/^\s*(?:hook|open\s*loop|body|payoff|cta|beat|scene|note|sfx|music|overlay|visual|caption)\s*[:\-–—]\s*/i, "")
    .replace(/^\s*\(?\d+\)?\s*[.):\-–—]\s+/, "")
    // Parenthetical stage/direction cues.
    .replace(/\((?:whisper|pause|beat|laughs?|sighs?|music|sfx|sound|note|smile|breath|mid[-\s]?video|voice[-\s]?over|vo|aside)[^)]*\)/gi, " ")
    // Markdown bullets / table pipes / headings.
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/^\s*[#>*\-•]+\s*/gm, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, ", ")
    .replace(/…/g, "...")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, " ")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLongMurfChunk(text: string, maxChars: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const clauses = clean
    .split(/(?<=[,;:])\s+|\s+(?=(?:and|but|then|because|so|while|when|after|before)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf = "";

  const pushHardWrapped = (value: string) => {
    let rest = value.trim();
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(" ", maxChars);
      if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  };

  for (const clause of clauses.length ? clauses : [clean]) {
    if (clause.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      pushHardWrapped(clause);
      continue;
    }
    const next = buf ? `${buf} ${clause}` : clause;
    if (next.length > maxChars) {
      if (buf) out.push(buf);
      buf = clause;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Mirrors the commentary Gemini flow: one CLEAN sentence per request, no
// emotion tags, no stage cues. If the input is already line-per-sentence
// (enhance-with-emotion output), split on newlines first; otherwise fall
// back to sentence-terminator splitting.
function splitMurfText(input: string): string[] {
  const enveloped = stripEnvelope(input);
  if (!enveloped.trim()) return [];
  const maxChars = 260;

  // 1) Prefer line-based splitting when the source is multi-line (Gemini
  //    enhancement always writes one sentence per line).
  const rawLines = enveloped
    .split(/\r?\n+/)
    .map((l) => cleanMurfLine(l))
    .filter((l) => /[A-Za-z0-9]/.test(l));

  let sentences: string[];
  if (rawLines.length >= 2) {
    // Some lines may still hold multiple sentences (e.g. "One. Two.") —
    // split those on terminators so every request is a single sentence.
    sentences = rawLines.flatMap((line) => {
      const parts = line.match(/[^.!?…]+[.!?…]+["')\]]*/g);
      return (parts && parts.length ? parts : [line]).map((s) => s.trim()).filter(Boolean);
    });
  } else {
    const oneLiner = cleanMurfLine(enveloped);
    sentences = (oneLiner.match(/[^.!?…]+[.!?…]+["')\]]*/g) || [oneLiner])
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 2) Cap long sentences (Murf 502s on very long chunks).
  const chunked = sentences.flatMap((s) => splitLongMurfChunk(s, maxChars));

  // 3) Final polish — re-clean, ensure punctuation, merge ultra-short
  //    fragments so we never POST "oh." on its own.
  const parts: string[] = [];
  for (const item of chunked) {
    const part = cleanMurfLine(item);
    if (!/[A-Za-z0-9]/.test(part)) continue;
    if (parts.length && part.length < 12 && `${parts[parts.length - 1]} ${part}`.length <= maxChars) {
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${part}`;
      continue;
    }
    parts.push(/[.!?]$/.test(part) ? part : `${part}.`);
  }
  return parts;
}

function findFirstAudioUrl(value: unknown): string {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : "";
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of ["url", "audioUrl", "previewUrl", "audioFile", "audio_file", "downloadUrl", "src"] as const) {
    const found = findFirstAudioUrl(object[key]);
    if (found) return found;
  }
  for (const nested of Object.values(object)) {
    const found = findFirstAudioUrl(nested);
    if (found) return found;
  }
  return "";
}

// Merge multiple WAV files (same sample rate / bit depth / channels).
// For streamable containers (mp3/aac/opus/flac) plain Buffer.concat works.
function mergeWav(wavs: Buffer[]): Buffer {
  if (wavs.length === 1) return wavs[0];
  // Parse header of first file
  const first = wavs[0];
  const sampleRate = first.readUInt32LE(24);
  const channels = first.readUInt16LE(22);
  const bitDepth = first.readUInt16LE(34);
  // Extract PCM data (skip 44-byte header) from every file
  const pcms = wavs.map((w) => w.subarray(44));
  const merged = Buffer.concat(pcms);
  return pcmToWav(merged, sampleRate, channels, bitDepth);
}

function mergeAudio(buffers: Buffer[], format: string): Buffer {
  if (buffers.length === 1) return buffers[0];
  if (format === "wav") return mergeWav(buffers);
  // mp3 / aac / opus / flac are frame-based containers that tolerate
  // byte-level concatenation for playback in browsers.
  return Buffer.concat(buffers);
}

// ============================================================
// Gemini branch — returns RAW PCM so we can concat many
// sentences into one WAV at the end.
// ============================================================
function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

type PcmAudio = {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitDepth: number;
};

function extractWavPcm(wav: Buffer): PcmAudio | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitDepth = 16;
  let data: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, wav.length);

    if (id === "fmt " && size >= 16) {
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bitDepth = wav.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = wav.subarray(start, end);
    }

    offset = start + size + (size % 2);
  }

  return data ? { pcm: data, sampleRate, channels, bitDepth } : null;
}

function decodeGeminiAudio(data: Buffer, mime: string): PcmAudio {
  const wav = extractWavPcm(data);
  if (wav) return wav;
  return {
    pcm: data,
    sampleRate: parseGeminiSampleRate(mime),
    channels: 1,
    bitDepth: 16,
  };
}

// ============================================================
// WSOLA time-stretch — changes duration WITHOUT changing pitch.
// Operates on 16-bit signed little-endian mono PCM. For each
// output frame, we search a small window around the naive input
// position for the best cross-correlation with the previous
// frame's overlap tail, then Hann-window overlap-add. This is
// the standard technique used by SoundTouch / Rubber Band for
// small (0.5–2x) speed changes on speech.
// ============================================================
function timeStretchPcm(pcm: Buffer, speed: number, sampleRate = 24000): Buffer {
  if (Math.abs(speed - 1) < 0.01 || pcm.length < 4) return pcm;

  const samples = new Int16Array(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length),
  );
  const N = samples.length;

  // Frame ~40ms, hop ~10ms — good for speech at 24kHz.
  const frameSize = Math.round(sampleRate * 0.04);
  const outHop = Math.round(sampleRate * 0.01);
  const inHop = Math.round(outHop * speed);
  const overlap = frameSize - outHop;
  const searchWin = Math.round(sampleRate * 0.005); // ±5ms search

  // Hann window
  const win = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
  }

  const outLen = Math.ceil(N / speed) + frameSize;
  const outBuf = new Float32Array(outLen);
  const normBuf = new Float32Array(outLen);

  // First frame goes in at position 0 with no search.
  let inPos = 0;
  let outPos = 0;
  const prevTail = new Float32Array(overlap);

  const writeFrame = (start: number) => {
    for (let i = 0; i < frameSize; i++) {
      const s = start + i;
      const v = s >= 0 && s < N ? samples[s] : 0;
      outBuf[outPos + i] += v * win[i];
      normBuf[outPos + i] += win[i];
    }
    // Save the overlap region of THIS frame (windowed) as the
    // template the next frame must align against.
    for (let i = 0; i < overlap; i++) {
      const s = start + outHop + i;
      const v = s >= 0 && s < N ? samples[s] : 0;
      prevTail[i] = v * win[outHop + i];
    }
  };

  writeFrame(inPos);
  inPos += inHop;
  outPos += outHop;

  while (inPos + frameSize + searchWin < N) {
    // Search for the offset in [-searchWin, +searchWin] whose
    // leading `overlap` samples best correlate with prevTail.
    let bestOff = 0;
    let bestCorr = -Infinity;
    for (let off = -searchWin; off <= searchWin; off++) {
      const base = inPos + off;
      if (base < 0 || base + overlap >= N) continue;
      let corr = 0;
      // Stride by 4 for speed — plenty of resolution for speech.
      for (let i = 0; i < overlap; i += 4) {
        corr += prevTail[i] * samples[base + i];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOff = off;
      }
    }
    writeFrame(inPos + bestOff);
    inPos += inHop;
    outPos += outHop;
  }

  // Trim & normalise the overlap-add sum.
  const finalLen = outPos + overlap;
  const result = new Int16Array(finalLen);
  for (let i = 0; i < finalLen; i++) {
    const n = normBuf[i];
    const v = n > 1e-6 ? outBuf[i] / n : 0;
    result[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return Buffer.from(result.buffer);
}

// ============================================================
// Silence collapse — trims leading/trailing silence and shortens
// any internal silent run longer than `maxGapMs` down to
// `keepGapMs`. Fixes the "unwanted long pauses mid-paragraph"
// issue where Gemini stretches breaks around [tags], ellipses,
// em-dashes, or paragraph boundaries into 1–3s of dead air.
// Operates on 16-bit signed little-endian mono PCM.
// ============================================================
function collapseSilence(
  pcm: Buffer,
  sampleRate: number,
  opts: {
    thresholdDb?: number;   // amplitude below this = silent
    maxGapMs?: number;      // any silent run longer than this gets shortened
    keepGapMs?: number;     // shortened to this length
    edgeKeepMs?: number;    // leading/trailing silence trimmed to this
  } = {},
): Buffer {
  const thresholdDb = opts.thresholdDb ?? -45;
  const maxGapMs = opts.maxGapMs ?? 550;
  const keepGapMs = opts.keepGapMs ?? 260;
  const edgeKeepMs = opts.edgeKeepMs ?? 80;

  if (pcm.length < 4) return pcm;
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
  const N = samples.length;
  const threshold = Math.pow(10, thresholdDb / 20) * 32768;

  // Analyse in ~10ms windows using RMS so brief clicks don't count as speech.
  const winSize = Math.max(1, Math.round(sampleRate * 0.01));
  const winCount = Math.ceil(N / winSize);
  const silent = new Uint8Array(winCount);
  for (let w = 0; w < winCount; w++) {
    const start = w * winSize;
    const end = Math.min(start + winSize, N);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i];
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    silent[w] = rms < threshold ? 1 : 0;
  }

  const maxGapWin = Math.max(1, Math.round(maxGapMs / 10));
  const keepGapWin = Math.max(1, Math.round(keepGapMs / 10));
  const edgeKeepWin = Math.max(0, Math.round(edgeKeepMs / 10));

  // Find first/last non-silent windows for edge trim.
  let firstVoice = 0;
  while (firstVoice < winCount && silent[firstVoice]) firstVoice++;
  let lastVoice = winCount - 1;
  while (lastVoice >= 0 && silent[lastVoice]) lastVoice--;
  if (firstVoice > lastVoice) return pcm; // entirely silent — leave it

  // Determine kept window ranges [start,end).
  const kept: Array<[number, number]> = [];
  const leadStart = Math.max(0, firstVoice - edgeKeepWin);
  let cursor = leadStart;

  let w = firstVoice;
  while (w <= lastVoice) {
    if (!silent[w]) {
      w++;
      continue;
    }
    // Find silent run [runStart, runEnd)
    const runStart = w;
    while (w <= lastVoice && silent[w]) w++;
    const runEnd = w;
    const runLen = runEnd - runStart;
    if (runLen > maxGapWin) {
      // Emit voiced part up to runStart, then a shortened gap.
      kept.push([cursor, runStart]);
      // Keep half from the end of the tail of previous speech, half at the start of next.
      const half = Math.floor(keepGapWin / 2);
      kept.push([runStart, runStart + half]);
      cursor = runEnd - (keepGapWin - half);
      if (cursor < runStart + half) cursor = runStart + half;
    }
  }
  const tailEnd = Math.min(winCount, lastVoice + 1 + edgeKeepWin);
  kept.push([cursor, tailEnd]);

  // Materialise kept windows back into PCM bytes.
  let totalSamples = 0;
  for (const [s, e] of kept) totalSamples += Math.max(0, (e - s) * winSize);
  const out = new Int16Array(Math.min(totalSamples, N));
  let outIdx = 0;
  for (const [s, e] of kept) {
    const startSample = s * winSize;
    const endSample = Math.min(e * winSize, N);
    for (let i = startSample; i < endSample && outIdx < out.length; i++) {
      out[outIdx++] = samples[i];
    }
  }
  return Buffer.from(out.buffer, 0, outIdx * 2);
}

function parseGeminiSampleRate(mime: string): number {
  const m = mime.match(/rate=(\d+)/);
  return m ? parseInt(m[1], 10) : 24000;
}

async function geminiTtsRaw(params: {
  apiKey: string;
  text: string;
  voice: string;
  instructions: string;
  model: string;
  speed: number;
  scene?: string;
  sampleContext?: string;
}): Promise<PcmAudio> {
  // RAW MODE: Send the script text verbatim with no framing directive,
  // no scene, no sample context, no instructions. This matches the
  // user's request to hear Gemini's untouched voice output — only
  // playback speed is applied after generation (WSOLA time-stretch,
  // pitch-preserving). Voice identity is locked by prebuiltVoiceConfig.
  const directive = "";
  const body = {
    contents: [{ parts: [{ text: directive + params.text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: (params.voice || "Kore").trim() },
        },
      },

    },
  };


  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    params.model,
  )}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    const error = new Error(`Gemini TTS failed (${res.status}): ${err.slice(0, 500)}`) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    }>;
  };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  const b64 = part?.inlineData?.data;
  const mime = part?.inlineData?.mimeType ?? "audio/L16;codec=pcm;rate=24000";
  if (!b64) throw new Error("Gemini TTS returned no audio data.");
  return decodeGeminiAudio(Buffer.from(b64, "base64"), mime);
}

/** Try each Gemini API key in order until one succeeds. */
function parseRetryDelaySeconds(msg: string): number | null {
  const m = msg.match(/retry in ([\d.]+)s/i);
  if (m) return parseFloat(m[1]);
  const m2 = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (m2) return parseFloat(m2[1]);
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function geminiTtsWithFallback(params: {
  apiKeys: string[];
  text: string;
  voice: string;
  instructions: string;
  model: string;
  speed: number;
  scene?: string;
  sampleContext?: string;
  /** If true, on a 429 with a retry-in hint, wait once (capped) and retry the same key. */
  honorRetryHint?: boolean;
  /** Cap for the retry wait, seconds. */
  maxRetryWaitSec?: number;
}): Promise<PcmAudio & { keyIndex: number }> {
  const keys = params.apiKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured. Add one in Settings → Voiceover.");
  }
  const errors: string[] = [];
  const maxWait = params.maxRetryWaitSec ?? 60;
  for (let i = 0; i < keys.length; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await geminiTtsRaw({ ...params, apiKey: keys[i] });
        return { ...res, keyIndex: i };
      } catch (e) {
        const err = e as Error & { status?: number };
        const retryable =
          err.status === 401 ||
          err.status === 403 ||
          err.status === 429 ||
          /quota|rate|invalid|expired|permission/i.test(err.message);
        // On a 429 with retry hint, sleep once (bounded) and retry the SAME key
        if (
          params.honorRetryHint &&
          err.status === 429 &&
          attempt === 0
        ) {
          const wait = parseRetryDelaySeconds(err.message);
          if (wait && wait <= maxWait) {
            await sleep(Math.ceil(wait * 1000) + 250);
            continue;
          }
        }
        errors.push(`key #${i + 1}: ${err.message}`);
        if (!retryable || i === keys.length - 1) {
          throw new Error(
            keys.length > 1
              ? `All ${keys.length} Gemini keys failed:\n${errors.join("\n")}`
              : err.message,
          );
        }
        break; // try next key
      }
    }
  }
  throw new Error(errors.join("\n"));
}

// ============================================================
// Handler
// ============================================================
export const generateVoiceover = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => TtsInput.parse(i))
  .handler(async ({ data }) => {
    // Sentence mode → many small requests, merged. Full mode → one request.
    const parts =
      data.chunkMode === "full" ? [data.text.trim()] : splitSentences(data.text);
    if (parts.length === 0) throw new Error("No text to synthesise.");

    if (data.provider === "gemini") {
      const keys = data.geminiApiKeys.map((k) => k.trim()).filter(Boolean);
      if (keys.length === 0) {
        throw new Error(
          "Missing Gemini API key. Add one (or more, for fallback) in Settings → Voiceover (free at aistudio.google.com).",
        );
      }
      const pcmParts: Buffer[] = [];
      let sampleRate = 24000;
      let channels = 1;
      let bitDepth = 16;
      let lastKeyIndex = 0;
      let keyOffset = 0;
      for (const part of parts) {
        const rotated = [...keys.slice(keyOffset), ...keys.slice(0, keyOffset)];
        const { pcm, sampleRate: sr, channels: ch, bitDepth: bd, keyIndex } = await geminiTtsWithFallback({
          apiKeys: rotated,
          text: part,
          voice: data.geminiVoice,
          instructions: data.instructions,
          model: data.geminiModel,
          speed: data.geminiSpeed,
          scene: data.geminiScene,
          sampleContext: data.geminiSampleContext,
          // Full-mode single request: honor the server's retry-in hint to
          // wait it out once. Sentence-mode: don't sleep per-sentence — the
          // free-tier 3 RPM cap makes that hopeless; keep failing fast so
          // the user sees they need "full" mode or a paid tier.
          honorRetryHint: data.chunkMode === "full",
          maxRetryWaitSec: 60,
        });
        pcmParts.push(pcm);
        sampleRate = sr;
        channels = ch;
        bitDepth = bd;
        lastKeyIndex = (keyOffset + keyIndex) % keys.length;
        keyOffset = (keyOffset + 1) % keys.length;
      }
      // RAW MODE: keep Gemini's output untouched. No silence-collapse,
      // no framing — only pitch-preserving speed via WSOLA time-stretch.
      const mergedPcm = Buffer.concat(pcmParts);
      const speed = Math.max(0.5, Math.min(2, data.geminiSpeed || 1));
      if (channels !== 1 || bitDepth !== 16) {
        throw new Error(`Gemini speed processing needs 16-bit mono PCM, but got ${bitDepth}-bit / ${channels} channel audio.`);
      }
      const stretched =
        Math.abs(speed - 1) < 0.01
          ? mergedPcm
          : timeStretchPcm(mergedPcm, speed, sampleRate);
      const bytesPerSecond = (sampleRate * channels * bitDepth) / 8;
      const sourceDurationSec = mergedPcm.length / bytesPerSecond;
      const durationSec = stretched.length / bytesPerSecond;
      const wav = pcmToWav(stretched, sampleRate, channels, bitDepth);


      return {
        audioBase64: wav.toString("base64"),
        mimeType: "audio/wav",
        voice: data.geminiVoice,
        speed,
        speedApplied: speed,
        sourceDurationSec,
        durationSec,
        instructions: data.instructions,
        format: "wav",
        provider: "gemini" as const,
        model: data.geminiModel,
        chars: data.text.length,
        generatedAt: Date.now(),
        keyIndex: lastKeyIndex,
        sentenceCount: parts.length,
      };
    }

    if (data.provider === "murf") {
      // Prefer refresh_token flow: mint a fresh idtoken each generation so the
      // hourly Firebase expiry never bites. Fall back to a pasted idtoken.
      let murfIdToken = data.murfIdToken.trim();
      const refreshToken = data.murfRefreshToken.trim() || process.env.MURF_REFRESH_TOKEN?.trim() || "";
      if (refreshToken) {
        const apiKey = data.murfFirebaseApiKey.trim() || "AIzaSyDQyfss4q_uqGeqySU2i0fI3VQdrglSXmc";
        const tokRes = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
        });
        if (!tokRes.ok) {
          const err = await tokRes.text().catch(() => "");
          throw new Error(`Murf token refresh failed (${tokRes.status}): ${err.slice(0, 300)} — refresh_token likely revoked; grab a new one from murf.ai devtools.`);
        }
        const tokJson = (await tokRes.json()) as { id_token?: string; access_token?: string };
        murfIdToken = (tokJson.id_token || tokJson.access_token || "").trim();
        if (!murfIdToken) throw new Error("Murf token refresh returned no id_token.");
      }
      if (!murfIdToken) throw new Error("Missing Murf idtoken. Paste an idtoken OR save MURF_REFRESH_TOKEN.");
      if (!data.murfVoiceId.trim()) throw new Error("Missing Murf voice id.");

      const projectId = data.murfProjectId.trim() || "P017843231938171NQ";
      const workspaceId = data.murfWorkspaceId.trim();
      const duid = data.murfDuid.trim();

      // Murf's quick-audition-preview often returns 502 "Invalid text provided"
      // for long chunks, empty visual cues, Gemini [tags], or pasted markdown.
      // Render one cleaned sentence/clause at a time, then merge the WAV PCM.
      const murfParts = splitMurfText(data.text);
      if (!murfParts.length) throw new Error("Murf TTS: no text to speak.");



      const wavParts: PcmAudio[] = [];
      for (const part of murfParts) {
        const body = {
          text: part,
          voiceId: data.murfVoiceId.trim(),
          languageCode: data.murfLanguageCode.trim() || "en_US",
          useCase: null,
          style: data.murfStyle.trim() || "Narration",
          nonNativeLocale: data.murfLanguageCode.trim() || "en_US",
        };
        const url = `https://murf.ai/Prod/v2/project/${encodeURIComponent(projectId)}/quick-audition-preview`;
        const headers: Record<string, string> = {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "origin": "https://murf.ai",
          "referer": workspaceId
            ? `https://murf.ai/studio/project/2/${projectId}?workspaceId=${workspaceId}`
            : `https://murf.ai/studio/project/2/${projectId}`,
          "idToken": murfIdToken,
        };
        if (workspaceId) headers["workspaceid"] = workspaceId;
        if (duid) headers["custom-header"] = JSON.stringify({ duid });
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const err = await res.text().catch(() => "");
          throw new Error(`Murf TTS failed (${res.status}) on chunk ${wavParts.length + 1}/${murfParts.length}: ${err.slice(0, 400)} · text="${part.slice(0, 120)}"${res.status === 401 ? " — idtoken likely expired; refresh from murf.ai devtools." : ""}`);
        }
        // Response may be a JSON envelope with a URL, or the raw URL string.
        const contentType = res.headers.get("content-type") || "";
        let audioUrl = "";
        if (contentType.includes("application/json")) {
          const j = (await res.json()) as unknown;
          audioUrl = findFirstAudioUrl(j);
        } else {
          audioUrl = (await res.text()).trim().replace(/^"|"$/g, "");
        }
        if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
          throw new Error(`Murf TTS returned no audio URL. Response: ${audioUrl.slice(0, 200)}`);
        }
        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) throw new Error(`Failed to download Murf audio (${audioRes.status}).`);
        const wavBuf = Buffer.from(await audioRes.arrayBuffer());
        const pcm = extractWavPcm(wavBuf);
        if (!pcm) throw new Error("Murf audio was not a WAV file — cannot apply speed.");
        wavParts.push(pcm);
      }

      // Concatenate PCM (resample if needed — pick first file's rate as canonical).
      const sampleRate = wavParts[0].sampleRate;
      const channels = wavParts[0].channels;
      const bitDepth = wavParts[0].bitDepth;
      if (channels !== 1 || bitDepth !== 16) {
        // Murf returns 24kHz 16-bit mono for the audition endpoint; if that ever changes,
        // fall back to just returning the first chunk untouched.
        const wavOut = pcmToWav(wavParts[0].pcm, sampleRate, channels, bitDepth);
        return {
          audioBase64: wavOut.toString("base64"),
          mimeType: "audio/wav",
          voice: data.murfVoiceId,
          speed: data.murfSpeed,
          speedApplied: 1,
          instructions: "",
          format: "wav",
          provider: "murf" as const,
          model: "murf-quick-audition",
          chars: data.text.length,
          generatedAt: Date.now(),
          sentenceCount: murfParts.length,
        };
      }
      const mergedPcm = Buffer.concat(wavParts.map((w) => w.pcm));
      const speed = Math.max(0.5, Math.min(2, data.murfSpeed || 1));
      const stretched =
        Math.abs(speed - 1) < 0.01 ? mergedPcm : timeStretchPcm(mergedPcm, speed, sampleRate);
      const bytesPerSecond = (sampleRate * channels * bitDepth) / 8;
      const sourceDurationSec = mergedPcm.length / bytesPerSecond;
      const durationSec = stretched.length / bytesPerSecond;
      const wav = pcmToWav(stretched, sampleRate, channels, bitDepth);
      return {
        audioBase64: wav.toString("base64"),
        mimeType: "audio/wav",
        voice: data.murfVoiceId,
        speed,
        speedApplied: speed,
        sourceDurationSec,
        durationSec,
        instructions: "",
        format: "wav",
        provider: "murf" as const,
        model: "murf-quick-audition",
        chars: data.text.length,
        generatedAt: Date.now(),
        sentenceCount: murfParts.length,
      };
    }

    throw new Error(
      `Unsupported voiceover provider "${data.provider}". Use "gemini" (BYO key) or "murf".`,
    );
  });
