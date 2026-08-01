export type StageKey =
  | "transcript"
  | "products"
  | "frames"
  | "script"
  | "seo"
  | "fairuse"
  | "voiceover"
  | "analyze-vision"
  | "analyze-report";


export type TtsProvider = "gemini" | "murf";
export type ChunkMode = "sentence" | "full";

export type VoiceoverConfig = {
  provider: TtsProvider;
  voice: string;
  instructions: string;
  speed: number;
  format: "mp3" | "wav" | "opus" | "aac" | "flac";
  model: string;
  geminiVoice: string;
  geminiModel: string;
  /** Multiple keys — tried in order as fallback when one is rate-limited/invalid. */
  geminiApiKeys: string[];
  /** Playback speed for Gemini — applied after generation with pitch-preserving time-stretch. */
  geminiSpeed: number;
  /** Gemini AI-Studio-style "Scene" — physical setting/environment framing. */
  geminiScene: string;
  /** Gemini AI-Studio-style "Sample Context" — tone/pacing framing. */
  geminiSampleContext: string;
  /** "sentence" splits & merges (uniform quality on long scripts); "full" sends the whole script in one request (fewer requests, better for free-tier quotas). */
  chunkMode: ChunkMode;
  // ------ Murf.ai (BYO signed-in session) ------
  /** Firebase idtoken lifted from murf.ai session (~1h TTL — refresh from the site when it 401s). */
  murfIdToken: string;
  /** Murf project id, e.g. "P017843231938171NQ". */
  murfProjectId: string;
  /** Murf workspace id, e.g. "WORKSPACEID017843231918205SJ". */
  murfWorkspaceId: string;
  /** Murf duid, e.g. "DUID017832326677690VG". */
  murfDuid: string;
  /** Murf voice id, e.g. "VM01721940536261616". */
  murfVoiceId: string;
  /** Named presets the user can pick from / add to. */
  murfVoicePresets: { name: string; id: string }[];
  murfLanguageCode: string;
  murfStyle: string;
  /** Playback speed for Murf — applied after generation with pitch-preserving time-stretch. */
  murfSpeed: number;
  /** Optional Firebase refresh_token — when set, a fresh idtoken is minted per request via securetoken.googleapis.com (no more manual refresh). */
  murfRefreshToken: string;
  /** Firebase Web API key for the Murf project. Defaults to Murf's public key. */
  murfFirebaseApiKey: string;
};

export const DEFAULT_VOICEOVER_CONFIG: VoiceoverConfig = {
  provider: "gemini",
  voice: "verse",
  instructions:
    "Voice: Energetic, fast-paced, fully projected short-form product-review host — modern TikTok/Reels creator hyping gear to a friend, never an ad read.\n\nVolume: Full retail-host volume throughout. Never whispered, hushed, ASMR, or intimate.\n\nContinuity: Deliver as ONE continuous take. No audible breaths, no silence between sentences, no mid-sentence pauses. Line breaks are tag-scoping only — run straight through them. Trailing commas mean 'keep going'; only the final period closes the take.\n\nPacing: Fast baseline (~1.3× conversational). Accelerate on feature lists and specs; land the CTA crisp and confident. No ellipses, no em-dash breath drops.\n\nEmphasis: Punch product names, numbers, and benefit verbs. Micro-lift into each new product intro like a fresh hook — reset the energy without a breath.\n\nTone: Warm, confident, playful — genuine excitement on reveals, smirk on the funny beats. NEVER monotone.",
  speed: 1.3,
  format: "mp3",
  model: "openai/gpt-4o-mini-tts",
  geminiVoice: "Puck",
  geminiModel: "gemini-2.5-flash-preview-tts",
  geminiApiKeys: [],
  geminiSpeed: 1.3,
  geminiScene:
    "Bright modern product-review broadcast booth, dynamic mic pushed hot, product hero-lit on a turntable behind the host.",
  geminiSampleContext:
    "LOUD fast-paced short-form product-review voiceover over B-roll with a music bed. One continuous take — no pauses, no audible breaths, no silence between sentences. Punch product names, numbers, and benefit words; land the CTA crisp.",
  chunkMode: "full",
  murfIdToken: "",
  murfProjectId: "P017843231938171NQ",
  murfWorkspaceId: "",
  murfDuid: "",
  murfVoiceId: "VM01721940536261616",
  murfVoicePresets: [
    { name: "Dirk (default)", id: "VM01721940536261616" },
  ],
  murfLanguageCode: "en_US",
  murfStyle: "Narration",
  murfSpeed: 1.5,
  murfRefreshToken: "",
  murfFirebaseApiKey: "AIzaSyDQyfss4q_uqGeqySU2i0fI3VQdrglSXmc",
};


export type StageOverride = {
  useLovable?: boolean;
  /** Persisted picker state so Global/Inline/Preset selections don't collapse back after rerender. */
  mode?: "global" | "inline" | "preset";
  host?: string;
  apiKey?: string;
  model?: string;
  /** Optional reference to a custom-model preset id (from Config.customModels). Resolved at read time. */
  presetId?: string;
  /** When true, fail over to fallbackHost/fallbackApiKey/fallbackModel if primary model fails. */
  enableFallback?: boolean;
  fallbackHost?: string;
  fallbackApiKey?: string;
  fallbackModel?: string;
};

export type TranscriptSegment = { text: string; start: number; duration: number };

export type VideoMeta = {
  videoId: string;
  title?: string;
  author?: string;
  thumbnail?: string;
  url?: string;
  uploadDate?: string;
  viewCount?: number;
  likeCount?: number;
  duration?: string;
};

/**
 * A product freeze-frame. Three variants:
 *   • image      — real captured JPEG (data URL) from the source video. Best quality.
 *   • thumbnail  — YouTube static thumbnail (i.ytimg.com). Unconditional floor.
 *   • storyboard — legacy sprite-sheet crop kept for backwards-compatible history entries.
 */
export type ProductFrame =
  | { kind: "image"; imageUrl: string; timeSeconds: number; width?: number; height?: number }
  | { kind: "thumbnail"; imageUrl: string; timeSeconds: number }
  | {
      kind?: "storyboard";
      imageUrl: string;
      tileX: number;
      tileY: number;
      tileW: number;
      tileH: number;
      spriteW: number;
      spriteH: number;
      timeSeconds: number;
    };

export type Product = {
  name: string;
  category?: string;
  brand?: string;
  description?: string;
  key_feature?: string;
  estimated_price?: string;
  mentioned_context?: string;
  amazon_search_query?: string;
  confidence?: number;
  affiliate_url?: string;
  timestamp_seconds?: number;
  frame?: ProductFrame;
};

export type FrameAnalysis = {
  url: string;
  timestamp: string;
  description: string;
  products_visible?: string[];
  scene?: string;
};
