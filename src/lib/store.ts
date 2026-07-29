import { useSyncExternalStore } from "react";
import type { StageKey, StageOverride, VideoMeta, TranscriptSegment, Product, FrameAnalysis, VoiceoverConfig } from "./types";
import { DEFAULT_VOICEOVER_CONFIG } from "./types";
import type { AmazonMatch } from "./amazon.functions";
import type { CustomModelPreset } from "./ai-provider";
import { base64ToBlob, dataUrlToBlob, getBlob, newRef, putBlob, gc as gcBlobs } from "./blob-store";



export type Config = {
  defaultHost: string;
  defaultApiKey: string;
  defaultModel: string;
  stages: Record<StageKey, StageOverride>;
  voiceover: VoiceoverConfig;
  scriptPromptTemplate: string;
  commentaryPromptTemplate: string;
  /**
   * Per-prompt overrides, keyed by PromptId (see src/lib/prompt-registry.ts).
   * Empty string / missing = use the built-in default. Editing here is safe:
   * renderPrompt() falls back to the default if required placeholders are missing.
   */
  promptOverrides: Record<string, string>;
  /**
   * User-set "personal defaults" per PromptId. When present, the Reset button
   * in PromptEditor restores to this baseline instead of the factory default.
   * Empty / missing = fall back to the factory template shipped in code.
   */
  promptBaselines: Record<string, string>;
  /**
   * Which registered PromptId is currently "active" per stage. When a stage has
   * multiple registered prompts (e.g. commentary.v1 / commentary.v2), this is
   * the one the runtime actually sends. Missing → first prompt for that stage.
   * Keyed by stage id string (pipelines StageKey, which is broader than the
   * store's own StageKey — hence `string` rather than the narrow union).
   */
  activePrompts: Record<string, string>;
  /** User-defined OpenAI-compatible model presets shown in per-run pickers. */
  customModels: CustomModelPreset[];
  /** When true, fall back to server-side Whisper (yt-dlp + faster-whisper) if YouTube captions are missing. Default off — most Shorts have music, not speech. */
  transcribeAudio: boolean;
  /** Default mode for the Commentary stage's Mode toggle. */
  commentaryDefaultMode: "mirror" | "remix" | "custom";
  /**
   * Frame extraction rate for the Any Video → Commentary vision pipeline.
   * 'auto' = smart heuristic based on video duration (default, cost-efficient).
   * '0.5fps' | '1fps' | '2fps' = fixed rate — higher = more frames = more detail + cost.
   */
  analyzeVisionFps: "auto" | "0.5fps" | "1fps" | "2fps";
  /** Maximum frame count cap when FPS mode is 'auto'. Default: 12. */
  analyzeMaxFrames: number;
  /** Number of frames per AI request batch during vision analysis. Default: 6. */
  analyzeBatchSize: number;
  /** Frame Grid Stitching mode: 'off' | '2x2' | '3x3' (default '3x3'). Combines 4 or 9 frames into 1 grid image per request. */
  analyzeGridStitch: "off" | "2x2" | "3x3";
};

export type VoiceoverResult = {
  /** Live object URL for playback (not persisted). Rebuilt from IDB on load. */
  audioUrl?: string;
  /** IDB ref for the persisted audio blob. */
  audioRef?: string;
  /** @deprecated Legacy base64 payload. Kept optional for one-shot fresh generations before persist. */
  audioBase64?: string;
  mimeType: string;
  voice: string;
  speed: number;
  instructions: string;
  format: string;
  provider: "gemini" | "murf";
  model: string;
  chars: number;
  generatedAt: number;
  sentenceCount?: number;
  keyIndex?: number;
  /** Output audio duration after any speed processing. */
  durationSec?: number;
  /** Native generated duration before app-side speed processing. */
  sourceDurationSec?: number;
  /** Final speed multiplier actually applied after validation/clamping. */
  speedApplied?: number;
};


export type AnalysisSourceMeta = {
  title?: string;
  author?: string;
  platform?: string;
  duration?: number;
  sourceUrl?: string;
  thumbnail?: string;
  filename?: string;
  service?: string;
};

export type AnalysisReport = {
  summary: string;
  hookMoments: { t: number; description: string; role?: string }[];
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
  /** v3 — free-form so it adapts to any viral short (karma, cute pet, tutorial, moral, nature, etc.). */
  clipType?: string;
  emotionalAnchor?: {
    focalDetail: string;
    pivotAction: string;
    contrastMoment: string;
  };
  commentaryAngles: string[];
  transcriptExcerpt?: string;
};


export type FrameSample = {
  t: number;
  /** Object URL (rebuilt from IDB on load) or fresh data URL before persist. */
  dataUrl: string;
  /** IDB ref for the persisted image blob. Present after first write. */
  dataRef?: string;
  visual?: string;
  onScreenText?: string;
};

export type ProjectState = {
  url: string;
  mode?: "youtube" | "amazon" | "analysis";
  amazonInputs?: string[];
  affiliateTag?: string;
  videoId?: string;
  meta?: VideoMeta;
  transcript?: TranscriptSegment[];
  products?: Product[];
  amazon?: Record<string, AmazonMatch[]>;
  frames?: FrameAnalysis[];
  script?: string;
  seo?: { title: string; description: string; tags: string[]; chapters: string };
  fairuse?: string;
  voiceover?: VoiceoverResult;
  /** All voiceover generations for the current script — appended per generate so users can compare across providers/voices. Cleared when script changes. */
  voiceoverTakes?: VoiceoverResult[];
  voiceoverText?: string;
  voiceoverScriptHash?: string;
  // ── analysis mode ──
  analysisSource?: AnalysisSourceMeta;
  analysisFrames?: FrameSample[];
  analysisTranscript?: string;
  analysis?: AnalysisReport;
  /** Cached vision captions per frame — kept so we can regenerate the report without re-paying for vision. */
  analysisCaptions?: { t: number; visual: string; onScreenText?: string }[];
  /** Cached per-batch vision summaries — paired with analysisCaptions for cheap report re-merges. */
  analysisBatchSummaries?: string[];
  /** Optional Gemini-generated draft script from the source video (commentary mode). */
  videoDraft?: string;
  /** Cached mirror-mode knobs derived from the source. Persisted so we don't re-derive on every visit. */
  mirrorKnobs?: unknown;
  /** Chosen commentary angle (from analyze) — used by /commentary when not in mirror mode. */
  selectedAngle?: string;
  /** Chosen commentary tone (from analyze) — used by /commentary when not in mirror mode. */
  selectedTone?: string;
  /** Which angle source /commentary should generate from: "mirror" (use mirrorKnobs) or "selected" (use selectedAngle+selectedTone). */
  angleSource?: "mirror" | "selected";
  /** Optional user override — replaces the Mirror-derived angle in the final commentary prompt when non-empty. */
  customAngle?: string;
  /** Optional extra vibe/notes appended to the Mirror context brief. */
  customBriefAddendum?: string;
  /** Per-project model choice for commentary script generation. See resolveModelChoice. */
  scriptModelChoice?: string;
  /**
   * User-authored corrections / facts that override anything the models say.
   * Injected as the top-priority evidence block into every downstream prompt
   * (report merge, mirror derive, commentary script, video draft).
   * Example: "The man is stepping onto the large white ship, not the small black boat."
   */
  userCorrections?: string;
};

/** Fields derived from products/frames — must be cleared whenever the product set changes. */
export const CLEAR_DOWNSTREAM: Partial<ProjectState> = {
  script: undefined,
  seo: undefined,
  fairuse: undefined,
  voiceover: undefined,
  voiceoverTakes: undefined,
  voiceoverText: undefined,
  voiceoverScriptHash: undefined,
};

const CONFIG_KEY = "foundry.config.v1";
const CONFIG_BACKUP_KEY = "foundry.config.v1.backup";
const PROJECT_KEY = "foundry.project.v1";
const HISTORY_KEY = "foundry.history.v1";
const MAX_HISTORY = 3;

export type HistoryEntry = {
  id: string;
  savedAt: number;
  label: string;
  project: ProjectState;
};


const defaultConfig: Config = {
  defaultHost: "",
  defaultApiKey: "",
  defaultModel: "",
  stages: {
    transcript: { mode: "global", useLovable: false },
    products: { mode: "global", useLovable: false },
    frames: { mode: "global", useLovable: false },
    script: { mode: "global", useLovable: false },
    seo: { mode: "global", useLovable: false },
    fairuse: { mode: "global", useLovable: false },
    voiceover: { mode: "global", useLovable: false },
    "analyze-vision": { mode: "global", useLovable: false },
    "analyze-report": { mode: "global", useLovable: false },
  },

  voiceover: DEFAULT_VOICEOVER_CONFIG,
  scriptPromptTemplate: "",
  commentaryPromptTemplate: "",
  promptOverrides: {},
  promptBaselines: {},
  activePrompts: {},
  customModels: [],
  transcribeAudio: false,
  commentaryDefaultMode: "mirror",
  analyzeVisionFps: "auto",
  analyzeMaxFrames: 12,
  analyzeBatchSize: 6,
  analyzeGridStitch: "3x3",
};

// ── In-memory caches ──────────────────────────────────────────────────────
// Frame data URLs and voiceover audio can total many MB — well past the ~5MB
// localStorage quota. We persist heavy blobs in IndexedDB (see blob-store) and
// keep only lightweight refs in localStorage. These caches mirror IDB so that
// synchronous reads (useSyncExternalStore) return hydrated state immediately
// once the initial warm-up finishes.

let frameMemoryCache: FrameSample[] | undefined;
type VoiceoverCacheEntry = { ref: string; audioUrl: string; audioBase64?: string };
const voiceoverUrlCache = new Map<string, VoiceoverCacheEntry>();
const frameUrlCache = new Map<string, string>(); // ref → objectURL

function revokeVoiceoverExcept(keep: Array<string | undefined>) {
  const keepSet = new Set(keep.filter(Boolean) as string[]);
  for (const [ref, entry] of voiceoverUrlCache) {
    if (keepSet.has(ref)) continue;
    try {
      URL.revokeObjectURL(entry.audioUrl);
    } catch { /* ignore */ }
    voiceoverUrlCache.delete(ref);
  }
}

function persistFrameBlobs(frames: FrameSample[]): FrameSample[] {
  const keep = new Set<string>();
  const out = frames.map((f) => {
    // Already persisted → reuse cached object URL.
    if (f.dataRef) {
      keep.add(f.dataRef);
      const cachedUrl = frameUrlCache.get(f.dataRef);
      return cachedUrl ? { ...f, dataUrl: cachedUrl } : f;
    }
    // Fresh data URL → convert to blob, persist, replace with object URL.
    if (f.dataUrl && f.dataUrl.startsWith("data:")) {
      const blob = dataUrlToBlob(f.dataUrl);
      if (!blob) return f;
      const ref = newRef("fr");
      const url = URL.createObjectURL(blob);
      frameUrlCache.set(ref, url);
      keep.add(ref);
      putBlob(ref, blob, blob.type || "image/jpeg").catch((e) => console.warn("IDB frame put failed", e));
      return { ...f, dataUrl: url, dataRef: ref };
    }
    return f;
  });
  // Revoke stale frame URLs that are no longer referenced.
  for (const [ref, url] of frameUrlCache) {
    if (keep.has(ref)) continue;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    frameUrlCache.delete(ref);
  }
  return out;
}

function stripFramesForStorage(state: ProjectState): ProjectState {
  if (!state.analysisFrames) return state;
  return {
    ...state,
    analysisFrames: state.analysisFrames.map((f) => ({
      t: f.t,
      dataUrl: "", // persist only meta; blob lives in IDB
      dataRef: f.dataRef,
      visual: f.visual,
      onScreenText: f.onScreenText,
    })),
  };
}

function stripVoiceoverForStorage(state: ProjectState): ProjectState {
  const strip = (vo: VoiceoverResult): VoiceoverResult => {
    const { audioBase64: _b, audioUrl: _u, ...rest } = vo;
    return { ...rest } as VoiceoverResult;
  };
  let next = state;
  if (next.voiceover) next = { ...next, voiceover: strip(next.voiceover) };
  if (next.voiceoverTakes && next.voiceoverTakes.length) {
    next = { ...next, voiceoverTakes: next.voiceoverTakes.map(strip) };
  }
  return next;
}

function rehydrateFrames(state: ProjectState): ProjectState {
  if (!state.analysisFrames) return state;
  const cache = frameMemoryCache;
  return {
    ...state,
    analysisFrames: state.analysisFrames.map((f, i) => {
      if (f.dataUrl) return f;
      // Prefer IDB-backed object URL.
      if (f.dataRef) {
        const url = frameUrlCache.get(f.dataRef);
        if (url) return { ...f, dataUrl: url };
      }
      // Fallback: transient RAM cache (fresh generations before warm-up).
      if (!cache) return f;
      const hit = cache[i] && Math.abs(cache[i].t - f.t) < 0.01 ? cache[i] : cache.find((c) => Math.abs(c.t - f.t) < 0.05);
      return hit ? { ...f, dataUrl: hit.dataUrl } : f;
    }),
  };
}

function rehydrateVoiceover(state: ProjectState): ProjectState {
  const hyd = (vo: VoiceoverResult): VoiceoverResult => {
    if (vo.audioUrl || vo.audioBase64 || !vo.audioRef) return vo;
    const hit = voiceoverUrlCache.get(vo.audioRef);
    return hit ? { ...vo, audioUrl: hit.audioUrl } : vo;
  };
  let next = state;
  if (next.voiceover) {
    const v = hyd(next.voiceover);
    if (v !== next.voiceover) next = { ...next, voiceover: v };
  }
  if (next.voiceoverTakes && next.voiceoverTakes.length) {
    const arr = next.voiceoverTakes.map(hyd);
    if (arr.some((v, i) => v !== next.voiceoverTakes![i])) next = { ...next, voiceoverTakes: arr };
  }
  return next;
}

// ── IDB warm-up ─────────────────────────────────────────────────────────────
// On module load, read any refs referenced by the current project and history,
// materialise them into object URLs, then nudge subscribers so components can
// re-render with the hydrated audio/frames.

type CollectedRefs = { audio: string[]; frames: string[] };

function collectRefs(state: ProjectState | undefined): CollectedRefs {
  if (!state) return { audio: [], frames: [] };
  const audio: string[] = [];
  if (state.voiceover?.audioRef) audio.push(state.voiceover.audioRef);
  for (const t of state.voiceoverTakes ?? []) {
    if (t.audioRef) audio.push(t.audioRef);
  }
  const frames = (state.analysisFrames ?? []).map((f) => f.dataRef).filter(Boolean) as string[];
  return { audio, frames };
}

// ── Hydration flag ──────────────────────────────────────────────────────────
// Consumers can gate media UI on this to avoid a "blank → appears" flash while
// IDB warm-up is running.
let hydratedFlag = false;
const hydrationListeners = new Set<() => void>();
export function subscribeHydration(cb: () => void) {
  hydrationListeners.add(cb);
  return () => { hydrationListeners.delete(cb); };
}
export function getHydrated() { return hydratedFlag; }

async function warmCaches() {
  if (typeof window === "undefined") return;
  try {
    const projRaw = localStorage.getItem(PROJECT_KEY);
    const proj = projRaw ? (JSON.parse(projRaw) as ProjectState) : undefined;
    const history = readAllHistory();
    const audioRefs = new Set<string>();
    const frameRefs = new Set<string>();
    for (const source of [proj, ...history.map((h) => h.project)]) {
      const { audio, frames } = collectRefs(source);
      for (const r of audio) audioRefs.add(r);
      for (const r of frames) frameRefs.add(r);
    }
    const allRefs = new Set<string>([...audioRefs, ...frameRefs]);

    await Promise.all(
      Array.from(allRefs).map(async (ref) => {
        try {
          const stored = await getBlob(ref);
          if (!stored) return;
          const url = URL.createObjectURL(stored.blob);
          if (frameRefs.has(ref)) frameUrlCache.set(ref, url);
          else voiceoverUrlCache.set(ref, { ref, audioUrl: url });
        } catch { /* ignore */ }
      }),
    );

    // Garbage-collect orphan blobs from previous sessions.
    gcBlobs(allRefs).catch(() => {});

    if (allRefs.size) bump(PROJECT_KEY);
  } catch { /* ignore */ } finally {
    hydratedFlag = true;
    for (const l of hydrationListeners) l();
  }
}


// ── Self-heal + escape hatch ───────────────────────────────────────────────
// If a previous session persisted an unparseable / structurally-invalid
// ProjectState (e.g. a huge partial write, or frames with malformed shapes),
// the app can render blank because downstream components throw synchronously
// before the ErrorComponent can mount. We validate on boot and wipe the bad
// key so the app comes up empty rather than dead.
//
// Users can also force a full reset by visiting any page with ?reset=1 —
// useful when the tab is hung and no UI is reachable.
if (typeof window !== "undefined") {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("reset")) {
      // Reset ONLY current project + history. Settings (Global model, per-stage
      // routing, custom presets, prompt templates, TTS keys) are user
      // preferences and must survive resets.
      localStorage.removeItem(PROJECT_KEY);
      localStorage.removeItem(HISTORY_KEY);
      params.delete("reset");
      const next = window.location.pathname + (params.toString() ? `?${params}` : "");
      window.history.replaceState({}, "", next);
    }
  } catch { /* ignore */ }

  // Boot-time validation for PROJECT_KEY: drop only the corrupt project,
  // never the config.
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      const p = parsed as Partial<ProjectState>;
      if (p.analysisFrames && !Array.isArray(p.analysisFrames)) throw new Error("frames not array");
      if (p.transcript && !Array.isArray(p.transcript)) throw new Error("transcript not array");
      if (p.products && !Array.isArray(p.products)) throw new Error("products not array");
    }
  } catch (e) {
    console.warn("[foundry] discarding corrupt project state:", e);
    try { localStorage.removeItem(PROJECT_KEY); } catch { /* ignore */ }
  }

  // Boot-time repair for CONFIG_KEY: NEVER remove. If missing or malformed,
  // restore from the backup slot; only fall through to defaults if both are
  // gone. This preserves prompts, TTS keys, model presets, and stage routing.
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    let needsRepair = false;
    if (!raw) {
      needsRepair = true;
    } else {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") needsRepair = true;
      } catch { needsRepair = true; }
    }
    if (needsRepair) {
      const backup = localStorage.getItem(CONFIG_BACKUP_KEY);
      if (backup) {
        try {
          JSON.parse(backup);
          localStorage.setItem(CONFIG_KEY, backup);
          console.warn("[foundry] repaired foundry.config.v1 from backup");
        } catch { /* backup also bad — leave defaults */ }
      }
    } else {
      // Ensure a backup exists for the next boot even if it never was written.
      const backup = localStorage.getItem(CONFIG_BACKUP_KEY);
      if (!backup && raw) {
        try { localStorage.setItem(CONFIG_BACKUP_KEY, raw); } catch { /* ignore */ }
      }
    }
  } catch (e) {
    console.warn("[foundry] config repair skipped:", e);
  }

  // Fire-and-forget; consumers subscribe via useSyncExternalStore.
  void warmCaches();

  // Sync config from server to survive container redeploys
  import("./config.functions").then(({ getServerConfig }) => {
    getServerConfig({ data: { key: CONFIG_KEY } }).then((res) => {
      if (res.value) {
        try {
          const parsed = JSON.parse(res.value);
          if (parsed && typeof parsed === "object") {
            const current = read(CONFIG_KEY, defaultConfig);
            const merged = { ...current, ...parsed };
            localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
            bump(CONFIG_KEY, merged);
          }
        } catch { /* ignore */ }
      }
    }).catch(console.warn);
  }).catch(console.warn);
}

function persistVoiceoverBlob(vo: VoiceoverResult): string | undefined {
  if (!vo.audioBase64) return vo.audioRef;
  const blob = base64ToBlob(vo.audioBase64, vo.mimeType);
  const ref = vo.audioRef ?? newRef("vo");
  const url = URL.createObjectURL(blob);
  // Revoke previous URL for the same ref before replacing.
  const prev = voiceoverUrlCache.get(ref);
  if (prev) { try { URL.revokeObjectURL(prev.audioUrl); } catch { /* ignore */ } }
  voiceoverUrlCache.set(ref, { ref, audioUrl: url });
  putBlob(ref, blob, vo.mimeType).catch((e) => console.warn("IDB put failed", e));
  return ref;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    if (key === PROJECT_KEY) {
      let s = parsed as ProjectState;
      s = rehydrateFrames(s);
      s = rehydrateVoiceover(s);
      return s as unknown as T;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

// ── Reactive snapshot cache ────────────────────────────────────────────────
// useSyncExternalStore calls getSnapshot on every render. Parsing + stringifying
// the whole ProjectState on every render caused visible navigation lag once
// projects held a full transcript/analysis. We now keep a version counter and
// a cached parsed object per key — getSnapshot is O(1) between writes and
// returns a stable reference (so React.memo works downstream).

const versions: Record<string, number> = {};
const snapshotCache = new Map<string, { v: number; value: unknown }>();
const listeners = new Set<() => void>();

function bump(key: string, hydratedValue?: unknown) {
  versions[key] = (versions[key] ?? 0) + 1;
  if (hydratedValue !== undefined) {
    // Fast path: seed cache with the exact post-write value — no re-parse.
    snapshotCache.set(key, { v: versions[key], value: hydratedValue });
  } else {
    snapshotCache.delete(key);
  }
  for (const l of listeners) l();
}

function getCachedSnapshot<T>(key: string, fallback: T): T {
  const v = versions[key] ?? 0;
  const hit = snapshotCache.get(key);
  if (hit && hit.v === v) return hit.value as T;
  const value = read(key, fallback);
  snapshotCache.set(key, { v, value });
  return value;
}

function write(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  let toStore = value;
  let hydratedForCache: unknown = value;
  if (key === PROJECT_KEY && value && typeof value === "object") {
    let state = value as ProjectState;

    const keepRefs: string[] = [];
    if (state.voiceover) {
      const ref = persistVoiceoverBlob(state.voiceover);
      if (ref) keepRefs.push(ref);
      const cached = ref ? voiceoverUrlCache.get(ref) : undefined;
      state = {
        ...state,
        voiceover: {
          ...state.voiceover,
          audioRef: ref,
          audioUrl: cached?.audioUrl ?? state.voiceover.audioUrl,
          audioBase64: undefined,
        },
      };
    }
    if (state.voiceoverTakes && state.voiceoverTakes.length) {
      const takes = state.voiceoverTakes.map((t) => {
        const ref = persistVoiceoverBlob(t);
        if (ref) keepRefs.push(ref);
        const cached = ref ? voiceoverUrlCache.get(ref) : undefined;
        return {
          ...t,
          audioRef: ref,
          audioUrl: cached?.audioUrl ?? t.audioUrl,
          audioBase64: undefined,
        } as VoiceoverResult;
      });
      state = { ...state, voiceoverTakes: takes };
    }
    if (state.voiceover || (state.voiceoverTakes && state.voiceoverTakes.length)) {
      revokeVoiceoverExcept(keepRefs);
    } else if (
      Object.prototype.hasOwnProperty.call(state, "voiceover") ||
      Object.prototype.hasOwnProperty.call(state, "voiceoverTakes")
    ) {
      revokeVoiceoverExcept([]);
    }

    if (state.analysisFrames) {
      const persisted = persistFrameBlobs(state.analysisFrames);
      state = { ...state, analysisFrames: persisted };
      frameMemoryCache = persisted;
    } else if (Object.prototype.hasOwnProperty.call(state, "analysisFrames")) {
      frameMemoryCache = undefined;
      // Clear frame URL cache — no frames means no refs to keep.
      for (const [ref, url] of frameUrlCache) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        frameUrlCache.delete(ref);
      }
    }

    hydratedForCache = state;
    toStore = stripVoiceoverForStorage(stripFramesForStorage(state));
  }
  try {
    localStorage.setItem(key, JSON.stringify(toStore));
    // Mirror successful config writes to a backup slot so a future corrupt
    // write / quota-recovery / manual clear can be repaired without losing
    // the user's Settings (prompts, TTS keys, model presets, stage routing).
    if (key === CONFIG_KEY) {
      try { localStorage.setItem(CONFIG_BACKUP_KEY, JSON.stringify(toStore)); } catch { /* ignore */ }
      import("./config.functions").then(({ saveServerConfig }) => {
        saveServerConfig({ data: { key: CONFIG_KEY, value: JSON.stringify(toStore) } }).catch(console.warn);
      }).catch(console.warn);
    }
  } catch (err) {
    console.warn("localStorage write failed — dropping heaviest fields and retrying", err);
    if (key === PROJECT_KEY) {
      // Quota recovery MUST NOT touch CONFIG_KEY. Only strip transient
      // project data.
      try {
        const stripped = stripVoiceoverForStorage(stripFramesForStorage(value as ProjectState));
        const minimal = { ...stripped, analysisTranscript: undefined };
        localStorage.setItem(key, JSON.stringify(minimal));
      } catch (err2) {
        console.warn("localStorage retry failed", err2);
      }
    } else if (key === CONFIG_KEY) {
      // Config is small — a quota failure here means the whole store is
      // full of project/history junk. Evict project + history and retry
      // so Settings always land.
      try {
        localStorage.removeItem(PROJECT_KEY);
        localStorage.removeItem(HISTORY_KEY);
        localStorage.setItem(key, JSON.stringify(toStore));
        try { localStorage.setItem(CONFIG_BACKUP_KEY, JSON.stringify(toStore)); } catch { /* ignore */ }
      } catch (err2) {
        console.warn("config write retry failed — Settings may not persist", err2);
      }
    }
  }
  bump(key, hydratedForCache);
}

// Cross-tab sync: when another tab writes to our keys, invalidate the cache
// so the next getSnapshot re-parses. Only reacts to keys we own.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key) return;
    if (e.key === PROJECT_KEY || e.key === CONFIG_KEY || e.key === HISTORY_KEY) {
      bump(e.key);
    }
  });
}


function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// Silence unused-import warnings if URL helpers change; retained for future callers.
export { dataUrlToBlob };

// Global Stop / Process State
let globalAbortController = new AbortController();
const processListeners = new Set<() => void>();

let globalIsProcessing = false;
export function setGlobalProcessing(processing: boolean) {
  if (globalIsProcessing !== processing) {
    globalIsProcessing = processing;
    if (processing) {
      // Refresh the abort controller when a new process starts
      globalAbortController = new AbortController();
    }
    processListeners.forEach((l) => l());
  }
}

export function getGlobalSignal() {
  return globalAbortController.signal;
}

export function abortAllProcesses() {
  globalAbortController.abort();
  setGlobalProcessing(false);
}

export function useGlobalProcess() {
  const isProcessing = useSyncExternalStore(
    (cb) => {
      processListeners.add(cb);
      return () => processListeners.delete(cb);
    },
    () => globalIsProcessing,
    () => globalIsProcessing
  );
  return { isProcessing, abortAllProcesses };
}

// Normalize once at read-time so the cached snapshot is fully hydrated.
function readConfig(): Config {
  const parsedRaw = read(CONFIG_KEY, defaultConfig) as Config & {
    voiceover?: { geminiApiKey?: string };
  };
  const rawVo = (parsedRaw.voiceover ?? {}) as Partial<Config["voiceover"]> & {
    geminiApiKey?: string;
  };
  const mergedVo = { ...DEFAULT_VOICEOVER_CONFIG, ...rawVo };
  if ((!mergedVo.geminiApiKeys || mergedVo.geminiApiKeys.length === 0) && rawVo.geminiApiKey) {
    mergedVo.geminiApiKeys = [rawVo.geminiApiKey];
  }
  // Migrate deprecated OpenAI TTS provider (removed) → Gemini.
  if ((mergedVo.provider as string) === "lovable-openai") {
    mergedVo.provider = "gemini";
  }
  // Migrate legacy configs that defaulted stages to Lovable AI — flip to Global/custom.
  const mergedStages = { ...defaultConfig.stages, ...(parsedRaw.stages ?? {}) };
  for (const k of Object.keys(mergedStages) as StageKey[]) {
    const s = { ...(mergedStages[k] ?? {}) };
    if (s.useLovable === true) s.useLovable = false;
    if (!s.mode) {
      s.mode = s.presetId ? "preset" : s.host || s.apiKey || s.model ? "inline" : "global";
    }
    mergedStages[k] = s;
  }
  // Seed the new split Analyze slots from the legacy stages the first time
  // they are read: vision inherits from `frames`, report inherits from `script`.
  // If the slot already exists, even as Global/empty, respect the user's latest choice.
  const rawStages = parsedRaw.stages ?? {};
  const hasStoredStage = (stage: StageKey) => Object.prototype.hasOwnProperty.call(rawStages, stage);
  const isEmpty = (s?: StageOverride) =>
    !s || (!s.host && !s.apiKey && !s.model && !s.presetId);
  if (!hasStoredStage("analyze-vision") && !isEmpty(mergedStages.frames)) {
    mergedStages["analyze-vision"] = { ...mergedStages.frames };
  }
  if (!hasStoredStage("analyze-report") && !isEmpty(mergedStages.script)) {
    mergedStages["analyze-report"] = { ...mergedStages.script };
  }

  return {
    ...parsedRaw,
    // One-time migration: clear the legacy baked-in default model so nothing
    // silently ships as "google/gemini-3-flash-preview" when the user never
    // picked it. Users who deliberately chose that model keep it via their stage/preset.
    defaultModel:
      parsedRaw.defaultModel === "google/gemini-3-flash-preview" ? "" : parsedRaw.defaultModel ?? "",
    voiceover: mergedVo,
    stages: mergedStages,
    customModels: Array.isArray(parsedRaw.customModels) ? parsedRaw.customModels : [],
    transcribeAudio: typeof parsedRaw.transcribeAudio === "boolean" ? parsedRaw.transcribeAudio : false,
    commentaryDefaultMode:
      parsedRaw.commentaryDefaultMode === "mirror" ||
      parsedRaw.commentaryDefaultMode === "remix" ||
      parsedRaw.commentaryDefaultMode === "custom"
        ? parsedRaw.commentaryDefaultMode
        : "mirror",
    promptOverrides:
      parsedRaw.promptOverrides && typeof parsedRaw.promptOverrides === "object"
        ? parsedRaw.promptOverrides
        : {},
    promptBaselines:
      parsedRaw.promptBaselines && typeof parsedRaw.promptBaselines === "object"
        ? parsedRaw.promptBaselines
        : {},
    activePrompts:
      parsedRaw.activePrompts && typeof parsedRaw.activePrompts === "object"
        ? parsedRaw.activePrompts
        : {},
  };
}


const configSnap = () => {
  const v = versions[CONFIG_KEY] ?? 0;
  const hit = snapshotCache.get(CONFIG_KEY);
  if (hit && hit.v === v) return hit.value as Config;
  const value = readConfig();
  snapshotCache.set(CONFIG_KEY, { v, value });
  return value;
};

function mergeRecordPatch(
  latest: Record<string, string>,
  base: Record<string, string>,
  patch: Record<string, string>,
): Record<string, string> {
  const next = { ...latest };
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(patch ?? {})]);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) delete next[key];
      continue;
    }
    if (patch[key] !== base[key]) next[key] = patch[key];
  }
  return next;
}

function mergeVoiceoverPatch(
  latest: Config["voiceover"],
  base: Config["voiceover"],
  patch: Config["voiceover"],
): Config["voiceover"] {
  const next = { ...latest };
  for (const key of Object.keys(patch) as Array<keyof Config["voiceover"]>) {
    if (patch[key] !== base[key]) {
      (next as Record<keyof Config["voiceover"], unknown>)[key] = patch[key];
    }
  }
  return next;
}

function mergeCustomModelsPatch(
  latest: Config["customModels"],
  base: Config["customModels"],
  patch: Config["customModels"],
): Config["customModels"] {
  const baseIds = base.map((p) => p.id).join("|");
  const patchIds = patch.map((p) => p.id).join("|");
  if (base.length !== patch.length || baseIds !== patchIds) return patch;

  const latestById = new Map(latest.map((p) => [p.id, p]));
  const baseById = new Map(base.map((p) => [p.id, p]));
  return patch.map((patched) => {
    const current = latestById.get(patched.id) ?? patched;
    const original = baseById.get(patched.id) ?? patched;
    return {
      ...current,
      ...Object.fromEntries(
        (Object.keys(patched) as Array<keyof typeof patched>)
          .filter((key) => patched[key] !== original[key])
          .map((key) => [key, patched[key]]),
      ),
    };
  });
}

function mergeConfigPatch(latest: Config, base: Config, patch: Partial<Config>): Config {
  const next: Config = { ...latest, ...patch };
  if (patch.voiceover) next.voiceover = mergeVoiceoverPatch(latest.voiceover, base.voiceover, patch.voiceover);
  if (patch.customModels) next.customModels = mergeCustomModelsPatch(latest.customModels, base.customModels, patch.customModels);
  if (patch.promptOverrides) {
    next.promptOverrides = mergeRecordPatch(latest.promptOverrides, base.promptOverrides, patch.promptOverrides);
  }
  if (patch.promptBaselines) {
    next.promptBaselines = mergeRecordPatch(latest.promptBaselines, base.promptBaselines, patch.promptBaselines);
  }
  if (patch.activePrompts) {
    next.activePrompts = mergeRecordPatch(latest.activePrompts, base.activePrompts, patch.activePrompts);
  }
  return next;
}

export function useConfig(): [Config, (patch: Partial<Config>) => void, (stage: StageKey, patch: Partial<StageOverride>) => void] {
  const parsed = useSyncExternalStore(subscribe, configSnap, () => defaultConfig);
  // Merge against the freshest snapshot (not the render-time `parsed`) so
  // rapid successive writes from different inputs / tabs never clobber
  // each other's fields.
  const set = (patch: Partial<Config>) => {
    const latest = configSnap();
    write(CONFIG_KEY, mergeConfigPatch(latest, parsed, patch));
  };
  const setStage = (stage: StageKey, patch: Partial<StageOverride>) => {
    const latest = configSnap();
    write(CONFIG_KEY, {
      ...latest,
      stages: { ...latest.stages, [stage]: { ...latest.stages[stage], ...patch } },
    });
  };
  return [parsed, set, setStage];
}

const EMPTY_PROJECT: ProjectState = { url: "" };
const projectSnap = () => getCachedSnapshot<ProjectState>(PROJECT_KEY, EMPTY_PROJECT);

export function useProject(): [ProjectState, (patch: Partial<ProjectState>) => void, () => void] {
  const parsed = useSyncExternalStore(subscribe, projectSnap, () => EMPTY_PROJECT);
  const set = (patch: Partial<ProjectState>) => {
    // Merge against the cached snapshot instead of re-reading + reparsing
    // localStorage on every update. write() handles persistence + hydration.
    const latest = projectSnap();
    write(PROJECT_KEY, { ...latest, ...patch });
  };
  const reset = () => {
    archiveCurrentProject();
    write(PROJECT_KEY, { url: "" });
  };
  return [parsed, set, reset];
}

function readHistory(mode: string): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${HISTORY_KEY}.${mode}`);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function readAllHistory(): HistoryEntry[] {
  return ["youtube", "amazon", "analysis"].flatMap((m) => readHistory(m));
}

const EMPTY_HISTORY: HistoryEntry[] = [];

function hasMeaningfulData(p: ProjectState): boolean {
  return Boolean(
    p.videoId ||
      p.meta?.title ||
      (p.products && p.products.length) ||
      p.script ||
      p.transcript ||
      p.analysis ||
      p.analysisSource?.title,
  );
}

function projectFingerprint(p: ProjectState): string {
  return [
    p.mode ?? "",
    p.videoId ?? "",
    p.analysisSource?.sourceUrl ?? "",
    p.analysisSource?.filename ?? "",
    (p.amazonInputs ?? []).join("|"),
    p.url ?? "",
  ].join("::");
}

function archiveCurrentProject() {
  if (typeof window === "undefined") return;
  try {
    const currentRaw = localStorage.getItem(PROJECT_KEY);
    if (!currentRaw) return;
    const current = JSON.parse(currentRaw) as ProjectState;
    if (!hasMeaningfulData(current)) return;
    const currentFp = projectFingerprint(current);
    const mode = current.mode || "youtube";
    const modeList = readHistory(mode);
    const label =
      current.meta?.title?.slice(0, 60) ||
      (current.mode === "amazon"
        ? `Amazon · ${current.amazonInputs?.length ?? 0} links`
        : current.videoId
          ? `YouTube · ${current.videoId}`
          : current.analysisSource?.title?.slice(0, 60) ||
            current.analysisSource?.filename ||
            "Untitled session");
    // Dedup by fingerprint (mode + videoId/sourceUrl/filename/amazon/url) —
    // covers analysis-mode sessions where videoId is empty. Reuse the existing
    // entry's id so history rows stay stable across refresh/click.
    const existing = modeList.find((e) => projectFingerprint(e.project) === currentFp);
    const entry: HistoryEntry = {
      id: existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      savedAt: Date.now(),
      label,
      project: current,
    };
    
    // Store in mode-specific namespace
    const filtered = modeList.filter((e) => e.id !== entry.id);
    write(`${HISTORY_KEY}.${mode}`, [entry, ...filtered].slice(0, MAX_HISTORY));
  } catch {
    // ignore
  }
}

export function useHistory(mode: string): {
  history: HistoryEntry[];
  startNewSession: () => void;
  loadSession: (id: string) => void;
  deleteSession: (id: string) => void;
  clearCurrentSession: () => void;
} {
  const modeKey = `${HISTORY_KEY}.${mode}`;

  const historySnap = () => {
    const v = versions[modeKey] ?? 0;
    const hit = snapshotCache.get(modeKey);
    if (hit && hit.v === v) return hit.value as HistoryEntry[];
    const value = readHistory(mode);
    snapshotCache.set(modeKey, { v, value });
    return value;
  };
  const history = useSyncExternalStore(subscribe, historySnap, () => EMPTY_HISTORY);
  return {
    history,
    startNewSession: () => {
      archiveCurrentProject();
      write(PROJECT_KEY, { url: "" });
    },
    loadSession: (id: string) => {
      const list = readHistory(mode);
      const entry = list.find((e) => e.id === id);
      if (!entry) return;
      
      // If we are already on this exact history entry, no-op.
      // But we can't tell easily without adding ID to project state.
      // We'll just archive and write. archiveCurrentProject correctly deduplicates
      // by fingerprint so we won't get infinite clones.
      archiveCurrentProject();
      write(PROJECT_KEY, entry.project);
    },
    deleteSession: (id: string) => {
      const prevList = readHistory(mode);
      const deleted = prevList.find((e) => e.id === id);
      const list = prevList.filter((e) => e.id !== id);
      write(modeKey, list);
      // If the deleted session matches the currently-loaded project, clear it
      // too — otherwise the next loadSession() archives it right back into
      // history under a new id.
      try {
        const currentRaw = localStorage.getItem(PROJECT_KEY);
        if (currentRaw && deleted) {
          const current = JSON.parse(currentRaw) as ProjectState;
          if (projectFingerprint(current) === projectFingerprint(deleted.project)) {
            write(PROJECT_KEY, { url: "" });
          }
        }
      } catch {
        /* ignore */
      }
      // Purge any cached blobs (voiceover audio, frame images) that are no
      // longer referenced by the current project or any remaining session.
      try {
        const projRaw = localStorage.getItem(PROJECT_KEY);
        const proj = projRaw ? (JSON.parse(projRaw) as ProjectState) : undefined;
        const keep = new Set<string>();
        for (const source of [proj, ...list.map((h) => h.project)]) {
          const { audio, frames } = collectRefs(source);
          for (const r of audio) keep.add(r);
          for (const r of frames) keep.add(r);
        }
        // Drop stale object URLs from in-memory caches for refs we're evicting.
        for (const ref of Array.from(voiceoverUrlCache.keys())) {
          if (!keep.has(ref)) {
            const cached = voiceoverUrlCache.get(ref);
            if (cached?.audioUrl) URL.revokeObjectURL(cached.audioUrl);
            voiceoverUrlCache.delete(ref);
          }
        }
        for (const ref of Array.from(frameUrlCache.keys())) {
          if (!keep.has(ref)) {
            const url = frameUrlCache.get(ref);
            if (url) URL.revokeObjectURL(url);
            frameUrlCache.delete(ref);
          }
        }
        gcBlobs(keep).catch(() => {});
      } catch {
        /* ignore */
      }
    },
    clearCurrentSession: () => {
      // Wipe the active project even when it isn't in history. GCs blobs
      // that only the active project referenced.
      try {
        const currentRaw = localStorage.getItem(PROJECT_KEY);
        write(PROJECT_KEY, { url: "" });
        if (!currentRaw) return;
        const list = readAllHistory();
        const keep = new Set<string>();
        for (const source of list.map((h) => h.project)) {
          const { audio, frames } = collectRefs(source);
          for (const r of audio) keep.add(r);
          for (const r of frames) keep.add(r);
        }
        for (const ref of Array.from(voiceoverUrlCache.keys())) {
          if (!keep.has(ref)) {
            const cached = voiceoverUrlCache.get(ref);
            if (cached?.audioUrl) URL.revokeObjectURL(cached.audioUrl);
            voiceoverUrlCache.delete(ref);
          }
        }
        for (const ref of Array.from(frameUrlCache.keys())) {
          if (!keep.has(ref)) {
            const url = frameUrlCache.get(ref);
            if (url) URL.revokeObjectURL(url);
            frameUrlCache.delete(ref);
          }
        }
        gcBlobs(keep).catch(() => {});
      } catch {
        /* ignore */
      }
    },
  };
}



export function getStageOverride(cfg: Config, stage: StageKey): StageOverride {
  const s = cfg.stages[stage];
  // Resolve preset reference if present — takes precedence over inline fields.
  if (s.presetId) {
    const p = cfg.customModels.find((m) => m.id === s.presetId);
    if (p) return { useLovable: false, host: p.host, apiKey: p.apiKey, model: p.model };
  }
  if (s.useLovable === true) return { useLovable: true };
  return {
    useLovable: false,
    host: s.host || cfg.defaultHost,
    apiKey: s.apiKey || cfg.defaultApiKey,
    model: s.model || cfg.defaultModel,
  };
}

/** Route every stage through the Global default (or a specific preset). */
export function applyOverrideToAllStages(
  cfg: Config,
  setCfg: (patch: Partial<Config>) => void,
  patch: Partial<StageOverride>,
) {
  const next: Config["stages"] = { ...cfg.stages };
  const mode: StageOverride["mode"] = patch.presetId
    ? "preset"
    : patch.host || patch.apiKey || patch.model
      ? "inline"
      : "global";
  for (const k of Object.keys(cfg.stages) as StageKey[]) {
    next[k] = { mode, useLovable: false, presetId: undefined, host: "", apiKey: "", model: "", ...patch };
  }
  setCfg({ stages: next });
}

/** Reactive hook — true once IDB warm-up (voiceover + frame blobs) has completed.
 *  Gate media UI on this to avoid a "blank → appears" flash on mount. */
export function useHydration(): boolean {
  return useSyncExternalStore(subscribeHydration, getHydrated, () => false);
}

