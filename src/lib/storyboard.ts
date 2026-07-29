// Pure helpers for YouTube storyboard sprite sheets.
// Storyboards are 5x5 or 10x10 grids of frames sampled every N ms across the video.
// We use SVG viewBox on the client to crop a single tile without server-side image processing.

export type StoryboardLevel = {
  level: number;
  width: number;      // tile width  (px, native)
  height: number;     // tile height (px, native)
  count: number;      // total frames on this level
  cols: number;
  rows: number;
  interval: number;   // ms per frame
  name: string;       // per-level filename fragment (may contain $M)
  sigh: string;       // signature for the URL
  baseUrl: string;    // template with $L / $M / $N
};

export type FrameTile = {
  imageUrl: string;
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  spriteW: number;
  spriteH: number;
  timeSeconds: number;
};

export function parseStoryboardSpec(spec: string): StoryboardLevel[] {
  // Format: {baseUrl}|{L0 params}|{L1 params}|{L2 params}
  // params: width#height#count#cols#rows#interval#name#sigh
  const parts = spec.split("|");
  if (parts.length < 2) return [];
  const baseUrl = parts[0];
  const levels: StoryboardLevel[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].split("#");
    if (p.length < 8) continue;
    const level: StoryboardLevel = {
      level: i - 1,
      width: parseInt(p[0], 10),
      height: parseInt(p[1], 10),
      count: parseInt(p[2], 10),
      cols: parseInt(p[3], 10),
      rows: parseInt(p[4], 10),
      interval: parseInt(p[5], 10),
      name: p[6],
      sigh: p[7],
      baseUrl,
    };
    if ([level.width, level.height, level.count, level.cols, level.rows, level.interval].some((n) => !Number.isFinite(n) || n <= 0)) {
      continue;
    }
    levels.push(level);
  }
  return levels;
}

export function pickBestLevel(levels: StoryboardLevel[]): StoryboardLevel | null {
  if (!levels.length) return null;
  return [...levels].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

export function frameForTime(level: StoryboardLevel, seconds: number): FrameTile {
  const per = level.cols * level.rows;
  const idx = Math.max(
    0,
    Math.min(Math.floor((seconds * 1000) / Math.max(level.interval, 1)), Math.max(level.count - 1, 0)),
  );
  const spriteIdx = Math.floor(idx / per);
  const localIdx = idx % per;
  const col = localIdx % level.cols;
  const row = Math.floor(localIdx / level.cols);

  const resolvedName = level.name.replaceAll("$M", String(spriteIdx));
  let url = level.baseUrl
    .replaceAll("$L", String(level.level))
    .replaceAll("$N", resolvedName)
    .replaceAll("$M", String(spriteIdx));
  url += (url.includes("?") ? "&" : "?") + "sigh=" + level.sigh;

  return {
    imageUrl: url,
    tileX: col * level.width,
    tileY: row * level.height,
    tileW: level.width,
    tileH: level.height,
    spriteW: level.cols * level.width,
    spriteH: level.rows * level.height,
    timeSeconds: seconds,
  };
}

// Alignment heuristic. In listicle-style Shorts the presenter usually finishes
// naming the product, then the editor cuts to the B-roll shot. So aligning to
// the END of the matched transcript segment lands on the product frame far
// more reliably than a fixed +Ns nudge from the start.
//
// Modes:
//   "end-of-segment" — match.start + match.duration + trailingOffset (default)
//   "start-plus"     — legacy: match.start + min(offsetSeconds, duration * maxRatio)
export type VisualOffsetMode = "end-of-segment" | "start-plus";

export const VISUAL_OFFSET_MODE: VisualOffsetMode = "end-of-segment";
export const VISUAL_OFFSET_TRAILING_SECONDS = 0.15; // small nudge past sentence end
export const VISUAL_OFFSET_SECONDS = 1.2;           // used only in "start-plus" mode
export const VISUAL_OFFSET_MAX_RATIO = 0.6;         // used only in "start-plus" mode

export type TranscriptMatch = { start: number; duration: number };

// Fallback "frame" built from YouTube's static thumbnail CDN (i.ytimg.com),
// used when the storyboard spec is unavailable (429, restricted, or very short
// video). i.ytimg.com is a public CDN and doesn't rate-limit like the watch
// page does, so this always renders SOMETHING instead of "no frame aligned".
export function fallbackFrameForThumbnail(videoId: string, seconds: number): FrameTile {
  const w = 480, h = 360;
  return {
    imageUrl: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    tileX: 0,
    tileY: 0,
    tileW: w,
    tileH: h,
    spriteW: w,
    spriteH: h,
    timeSeconds: seconds,
  };
}

// Locate a spoken quote inside the transcript. Returns the matched segment's
// start time AND duration so callers can apply a bounded visual-offset.
export function findTimestampForContext(
  context: string,
  segments: { text: string; start: number; duration?: number }[],
): TranscriptMatch | null {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const target = norm(context);
  if (!target) return null;
  const words = target.split(" ").filter((w) => w.length > 2);
  if (!words.length) return null;

  // Build concatenated corpus with segment offset marks.
  const marks: { offset: number; segIndex: number }[] = [];
  let running = "";
  for (let i = 0; i < segments.length; i++) {
    marks.push({ offset: running.length, segIndex: i });
    running += norm(segments[i].text) + " ";
  }

  const toMatch = (segIndex: number): TranscriptMatch => ({
    start: segments[segIndex].start,
    duration: segments[segIndex].duration ?? 2,
  });

  // 1. Try direct phrase match (first N words), shrinking down.
  for (const size of [6, 5, 4, 3]) {
    if (words.length < size) continue;
    const phrase = words.slice(0, size).join(" ");
    const idx = running.indexOf(phrase);
    if (idx !== -1) {
      let segIndex = 0;
      for (const m of marks) {
        if (m.offset <= idx) segIndex = m.segIndex;
        else break;
      }
      return toMatch(segIndex);
    }
  }

  // 2. Sliding window keyword-overlap scoring.
  let bestScore = 0;
  let bestIndex: number | null = null;
  for (let i = 0; i < segments.length; i++) {
    const window = segments
      .slice(i, i + 3)
      .map((s) => norm(s.text))
      .join(" ");
    let score = 0;
    for (const w of words) if (window.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex != null && bestScore >= Math.min(3, words.length)) return toMatch(bestIndex);
  return null;
}

// Apply the visual-offset heuristic to a raw transcript match.
// Central helper so the rule stays consistent across all call sites.
export function applyVisualOffset(
  match: TranscriptMatch,
  mode: VisualOffsetMode = VISUAL_OFFSET_MODE,
): number {
  if (mode === "end-of-segment") {
    return match.start + Math.max(match.duration, 0) + VISUAL_OFFSET_TRAILING_SECONDS;
  }
  const capped = Math.min(VISUAL_OFFSET_SECONDS, Math.max(match.duration, 0) * VISUAL_OFFSET_MAX_RATIO);
  return match.start + capped;
}


