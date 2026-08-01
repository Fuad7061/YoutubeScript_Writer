/**
 * Browser-only frame extraction.
 *
 * Two-tier strategy for speed + reliability:
 *
 *   1. Fast path: HTMLVideoElement + canvas seek.
 *      Works instantly on standard H.264 MP4s (the common resolver output).
 *      Aborts as soon as any seek stalls or produces a duplicate frame.
 *
 *   2. Fallback: ffmpeg.wasm with per-frame input-side `-ss` seeks.
 *      Handles fragmented / VP9 / non-seekable containers where the video
 *      element gives up. Input-side seek is orders of magnitude faster than
 *      a single full-timeline decode pass.
 *
 * Callers use `extractFrames()` which runs the fast path first, then falls
 * back if it fails or returns poor coverage.
 */

import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

export type ExtractedFrame = {
  t: number;
  dataUrl: string;
};

export type FrameOptions = {
  maxFrames?: number;
  maxDim?: number;
  quality?: number;
  /** Optional trusted duration when media metadata lies. */
  expectedDuration?: number;
  /**
   * Fixed frames-per-second rate for extraction.
   * When set, overrides the auto heuristic and computes frame count as
   * Math.ceil(duration * fps), capped at HARD_FRAME_CAP.
   * Leave undefined (or 0) to use the smart auto heuristic.
   */
  fps?: number;
  onProgress?: (done: number, total: number) => void;
  /** Optional logger for path/timing visibility in the UI. */
  onLog?: (msg: string) => void;
};

const HARD_FRAME_CAP = 30;
const CORE_JS_URL = "/wasm/ffmpeg-core.js";
const CORE_WASM_URL = "/__l5e/assets-v1/8cd42c71-f051-4c95-a141-3fedacea05f4/ffmpeg-core.wasm";

// Per-strategy budgets. The outer caller can still wrap the whole thing.
const SEEK_PATH_TOTAL_MS = 35_000;
const SEEK_PER_FRAME_MS = 4_000;
const FFMPEG_TOTAL_MS = 60_000;
const FFMPEG_PER_FRAME_MS = 12_000;

let ffmpegPromise: Promise<FFmpeg> | null = null;

async function getFfmpeg(): Promise<FFmpeg> {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ff = new FFmpeg();
    const coreURL = await toBlobURL(CORE_JS_URL, "text/javascript");
    await ff.load({
      coreURL,
      wasmURL: CORE_WASM_URL,
    });
    return ff;
  })().catch((e) => {
    ffmpegPromise = null;
    throw e;
  });
  return ffmpegPromise;
}

function resetFfmpeg() {
  const p = ffmpegPromise;
  ffmpegPromise = null;
  p?.then((ff) => { try { ff.terminate(); } catch { /* ignore */ } }).catch(() => {});
}

function autoFrameCount(duration: number, maxFrames?: number, fps?: number) {
  const cap = Math.min(HARD_FRAME_CAP, Math.max(1, Math.floor(maxFrames ?? HARD_FRAME_CAP)));
  if (!isFinite(duration) || duration <= 0) return 8;
  // Fixed FPS mode: count = duration * fps, capped at HARD_FRAME_CAP.
  if (fps && fps > 0) {
    return Math.min(cap, Math.max(1, Math.ceil(duration * fps)));
  }
  // Auto heuristic: logarithmic curve tuned for cost-efficiency.
  let n: number;
  if (duration <= 20) n = Math.ceil(duration / 2);
  else if (duration <= 60) n = Math.ceil(6 + (duration - 20) / 8);
  else if (duration <= 180) n = Math.ceil(11 + (duration - 60) / 15);
  else n = Math.ceil(19 + (duration - 180) / 60);
  return Math.min(cap, Math.max(3, n));
}

function finite(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function uniqueId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function targetTimestamps(duration: number, count: number): number[] {
  const d = Math.max(0.1, duration);
  const n = Math.max(1, count);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * d;
    out.push(Math.min(d - 0.05, Math.max(0, t)));
  }
  return out;
}

/** Probe duration via a hidden <video> as a cheap fallback when we have no hint. */
async function probeDurationViaVideo(source: Blob | string): Promise<number> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const ok = () => { cleanup(); resolve(); };
      const err = () => { cleanup(); reject(new Error("metadata load failed")); };
      const cleanup = () => {
        clearTimeout(timeoutId);
        video.removeEventListener("loadedmetadata", ok);
        video.removeEventListener("error", err);
      };
      video.addEventListener("loadedmetadata", ok);
      video.addEventListener("error", err);
      timeoutId = setTimeout(() => err(), 5000);
    });
    return finite(video.duration);
  } catch {
    return 0;
  } finally {
    video.removeAttribute("src");
    video.load();
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }
}

async function scaleJpegBytes(bytes: Uint8Array, maxDim: number, quality: number): Promise<string> {
  const buf = new Uint8Array(bytes);
  const blob = new Blob([buf.buffer as ArrayBuffer], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}

/** Small perceptual hash of the canvas so we can detect a stuck decoder. */
function tinyHash(ctx: CanvasRenderingContext2D, w: number, h: number): string {
  const sw = 8, sh = 8;
  const tmp = document.createElement("canvas");
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext("2d");
  if (!tctx) return "";
  tctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh);
  const data = tctx.getImageData(0, 0, sw, sh).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  const avg = sum / (sw * sh * 3);
  let bits = "";
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
    bits += l > avg ? "1" : "0";
  }
  return bits;
}

// ---------- Path 1: HTMLVideoElement + canvas seek ----------

async function extractViaVideoElement(
  source: Blob | string,
  duration: number,
  count: number,
  maxDim: number,
  quality: number,
  onProgress: (d: number, t: number) => void,
): Promise<ExtractedFrame[]> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = url;

  const cleanup = () => {
    video.removeAttribute("src");
    video.load();
    if (typeof source !== "string") URL.revokeObjectURL(url);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const cleanupListeners = () => {
        clearTimeout(timeoutId);
        video.removeEventListener("loadeddata", ok);
        video.removeEventListener("error", err);
      };
      const ok = () => { cleanupListeners(); resolve(); };
      const err = () => { cleanupListeners(); reject(new Error("video load failed")); };
      video.addEventListener("loadeddata", ok);
      video.addEventListener("error", err);
      // some browsers need a nudge or might hang indefinitely
      timeoutId = setTimeout(() => {
        if (video.readyState >= 2) ok();
        else err();
      }, 5000);
    });

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    if (!vw || !vh) throw new Error("video has no dimensions");

    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");

    const times = targetTimestamps(duration, count);
    const deadline = Date.now() + SEEK_PATH_TOTAL_MS;
    const frames: ExtractedFrame[] = [];
    let lastHash = "";
    let dupCount = 0;

    onProgress(0, times.length);
    for (let i = 0; i < times.length; i++) {
      if (Date.now() > deadline) throw new Error("seek path exceeded total budget");
      const t = times[i];
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; reject(new Error("seek timeout")); } }, SEEK_PER_FRAME_MS);
        const onSeeked = () => {
          if (done) return;
          done = true;
          clearTimeout(to);
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        try { video.currentTime = t; } catch (e) { clearTimeout(to); video.removeEventListener("seeked", onSeeked); reject(e as Error); }
      });

      ctx.drawImage(video, 0, 0, w, h);
      const hash = tinyHash(ctx, w, h);
      if (hash && hash === lastHash) {
        dupCount++;
        if (dupCount >= 2) throw new Error("seek producing duplicate frames");
      } else {
        dupCount = 0;
      }
      lastHash = hash;

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      frames.push({ t, dataUrl });
      onProgress(i + 1, times.length);
    }
    return frames;
  } finally {
    cleanup();
  }
}

// ---------- Path 2: ffmpeg.wasm with per-frame seeks ----------

async function extractViaFfmpeg(
  source: File | Blob | string,
  duration: number,
  count: number,
  maxDim: number,
  quality: number,
  onProgress: (d: number, t: number) => void,
): Promise<ExtractedFrame[]> {
  const ff = await getFfmpeg();
  const inputBytes = await fetchFile(source as Blob | string);
  const jobId = uniqueId();
  const inputName = `input_${jobId}.mp4`;
  await ff.writeFile(inputName, inputBytes);

  const times = targetTimestamps(duration, count);
  const frames: ExtractedFrame[] = [];
  const deadline = Date.now() + FFMPEG_TOTAL_MS;
  let crashed = false;

  onProgress(0, times.length);
  try {
    for (let i = 0; i < times.length; i++) {
      if (Date.now() > deadline) break;
      const outName = `f_${jobId}_${i}.jpg`;
      // Input-side seek is fast on H.264 MP4. `-noaccurate_seek` snaps to the
      // nearest keyframe which is what we want for a preview capture.
      const scaleAttempts = Array.from(new Set([maxDim, Math.min(maxDim, 384), 240]));
      let ok = false;
      let lastErr: unknown = null;
      for (const dim of scaleAttempts) {
        try {
          const code = await ff.exec([
            "-ss", times[i].toFixed(3),
            "-noaccurate_seek",
            "-i", inputName,
            "-frames:v", "1",
            "-an",
            "-vf", `scale='min(${dim},iw)':-2`,
            "-q:v", "5",
            outName,
          ], FFMPEG_PER_FRAME_MS);
          if (code === 0) { ok = true; break; }
          lastErr = new Error(`ffmpeg exit ${code}`);
        } catch (e) {
          lastErr = e;
          crashed = true;
          break;
        }
      }
      if (crashed) throw lastErr ?? new Error("ffmpeg crashed");
      if (!ok) continue;

      try {
        const data = (await ff.readFile(outName)) as Uint8Array;
        if (data && data.length > 0) {
          const dataUrl = await scaleJpegBytes(data, maxDim, quality);
          frames.push({ t: times[i], dataUrl });
        }
      } catch { /* ignore missing */ }
      try { await ff.deleteFile(outName); } catch { /* ignore */ }
      onProgress(i + 1, times.length);
    }
  } finally {
    if (crashed) {
      resetFfmpeg();
    } else {
      try { await ff.deleteFile(inputName); } catch { /* ignore */ }
    }
  }

  if (frames.length === 0) throw new Error("ffmpeg produced no frames");
  return frames;
}

// ---------- Public entrypoint ----------

export async function extractFrames(
  source: File | Blob | string,
  opts: FrameOptions = {},
): Promise<{ frames: ExtractedFrame[]; duration: number }> {
  const maxDim = opts.maxDim ?? 512;
  const quality = opts.quality ?? 0.6;
  const onProgress = opts.onProgress ?? (() => {});
  const onLog = opts.onLog ?? (() => {});

  // Determine duration once.
  let duration = finite(opts.expectedDuration);
  if (!duration) duration = await probeDurationViaVideo(source as Blob | string);
  if (!duration) duration = 30;

  const count = autoFrameCount(duration, opts.maxFrames, opts.fps);

  // --- Fast path ---
  const seekStart = Date.now();
  try {
    const frames = await extractViaVideoElement(source as Blob | string, duration, count, maxDim, quality, onProgress);
    if (frames.length >= Math.max(3, Math.ceil(count * 0.6))) {
      onLog(`frames via seek-canvas · ${frames.length} in ${((Date.now() - seekStart) / 1000).toFixed(1)}s`);
      frames.sort((a, b) => a.t - b.t);
      return { frames: frames.slice(0, HARD_FRAME_CAP), duration };
    }
    onLog(`seek-canvas returned ${frames.length}/${count}, falling back to ffmpeg`);
  } catch (e) {
    onLog(`seek-canvas failed (${(e as Error).message}), falling back to ffmpeg`);
  }

  // --- Fallback ---
  const ffStart = Date.now();
  const frames = await extractViaFfmpeg(source, duration, count, maxDim, quality, onProgress);
  onLog(`frames via ffmpeg · ${frames.length} in ${((Date.now() - ffStart) / 1000).toFixed(1)}s`);
  frames.sort((a, b) => a.t - b.t);
  return { frames: frames.slice(0, HARD_FRAME_CAP), duration };
}

// ---------- Public entrypoint: capture at caller-specified timestamps ----------

/**
 * Capture one JPEG per requested timestamp. Reuses the seek-canvas fast path
 * first (opens the video once, seeks N times), then falls back to per-time
 * ffmpeg.wasm seeks when the browser can't decode/seek the container.
 *
 * Built entirely in-browser. No API calls, no cost per frame.
 */
export async function extractFramesAtTimes(
  source: File | Blob | string,
  times: number[],
  opts: Omit<FrameOptions, "maxFrames" | "expectedDuration"> = {},
): Promise<ExtractedFrame[]> {
  const maxDim = opts.maxDim ?? 512;
  const quality = opts.quality ?? 0.65;
  const onProgress = opts.onProgress ?? (() => {});
  const onLog = opts.onLog ?? (() => {});

  const cleaned = Array.from(new Set(times.map((t) => Math.max(0, Number(t) || 0)))).sort(
    (a, b) => a - b,
  );
  if (cleaned.length === 0) return [];

  const collected = new Map<number, ExtractedFrame>();
  const keyOf = (t: number) => Math.round(t * 100);

  // --- Fast path: single <video>, N seeks ---
  const seekStart = Date.now();
  try {
    const frames = await extractAtTimesViaVideoElement(
      source as Blob | string,
      cleaned,
      maxDim,
      quality,
      onProgress,
    );
    for (const f of frames) collected.set(keyOf(f.t), f);
    onLog(`seek-canvas · ${frames.length}/${cleaned.length} in ${((Date.now() - seekStart) / 1000).toFixed(1)}s`);
  } catch (e) {
    onLog(`seek-canvas failed (${(e as Error).message}) — trying ffmpeg`);
  }

  // --- Fallback: ffmpeg for whatever the seek path missed ---
  const missing = cleaned.filter((t) => !collected.has(keyOf(t)));
  if (missing.length > 0) {
    const ffStart = Date.now();
    try {
      const frames = await extractAtTimesViaFfmpeg(source, missing, maxDim, quality, (d, total) => {
        onProgress(collected.size + d, cleaned.length);
        void total;
      });
      for (const f of frames) collected.set(keyOf(f.t), f);
      onLog(`ffmpeg fill · ${frames.length}/${missing.length} in ${((Date.now() - ffStart) / 1000).toFixed(1)}s`);
    } catch (e) {
      onLog(`ffmpeg fill failed (${(e as Error).message})`);
    }
  }

  const out = cleaned
    .map((t) => collected.get(keyOf(t)))
    .filter((f): f is ExtractedFrame => Boolean(f));
  onProgress(out.length, cleaned.length);
  return out;
}


async function extractAtTimesViaVideoElement(
  source: Blob | string,
  times: number[],
  maxDim: number,
  quality: number,
  onProgress: (d: number, t: number) => void,
): Promise<ExtractedFrame[]> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = url;

  const cleanup = () => {
    video.removeAttribute("src");
    video.load();
    if (typeof source !== "string") URL.revokeObjectURL(url);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const cleanupListeners = () => {
        clearTimeout(timeoutId);
        video.removeEventListener("loadeddata", ok);
        video.removeEventListener("error", err);
      };
      const ok = () => { cleanupListeners(); resolve(); };
      const err = () => { cleanupListeners(); reject(new Error("video load failed")); };
      video.addEventListener("loadeddata", ok);
      video.addEventListener("error", err);
      timeoutId = setTimeout(() => {
        if (video.readyState >= 2) ok();
        else err();
      }, 5000);
    });

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    if (!vw || !vh) throw new Error("video has no dimensions");
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");

    const duration = finite(video.duration);
    const frames: ExtractedFrame[] = [];
    const deadline = Date.now() + SEEK_PATH_TOTAL_MS;

    onProgress(0, times.length);
    for (let i = 0; i < times.length; i++) {
      if (Date.now() > deadline) break;
      const t = duration ? Math.min(duration - 0.05, times[i]) : times[i];
      try {
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const to = setTimeout(() => { if (!done) { done = true; reject(new Error("seek timeout")); } }, SEEK_PER_FRAME_MS);
          const onSeeked = () => {
            if (done) return;
            done = true;
            clearTimeout(to);
            video.removeEventListener("seeked", onSeeked);
            resolve();
          };
          video.addEventListener("seeked", onSeeked);
          try { video.currentTime = Math.max(0, t); } catch (e) { clearTimeout(to); video.removeEventListener("seeked", onSeeked); reject(e as Error); }
        });
        ctx.drawImage(video, 0, 0, w, h);
        frames.push({ t: times[i], dataUrl: canvas.toDataURL("image/jpeg", quality) });
      } catch {
        // Skip this timestamp; caller can decide whether to fall back to ffmpeg.
      }
      onProgress(i + 1, times.length);
    }
    return frames;
  } finally {
    cleanup();
  }
}

async function extractAtTimesViaFfmpeg(
  source: File | Blob | string,
  times: number[],
  maxDim: number,
  quality: number,
  onProgress: (d: number, t: number) => void,
): Promise<ExtractedFrame[]> {
  const ff = await getFfmpeg();
  const inputBytes = await fetchFile(source as Blob | string);
  const jobId = uniqueId();
  const inputName = `input_${jobId}.mp4`;
  await ff.writeFile(inputName, inputBytes);

  const frames: ExtractedFrame[] = [];
  const deadline = Date.now() + FFMPEG_TOTAL_MS;
  let crashed = false;

  onProgress(0, times.length);
  try {
    for (let i = 0; i < times.length; i++) {
      if (Date.now() > deadline) break;
      const outName = `f_${jobId}_${i}.jpg`;
      try {
        const code = await ff.exec([
          "-ss", times[i].toFixed(3),
          "-noaccurate_seek",
          "-i", inputName,
          "-frames:v", "1",
          "-an",
          "-vf", `scale='min(${maxDim},iw)':-2`,
          "-q:v", "5",
          outName,
        ], FFMPEG_PER_FRAME_MS);
        if (code === 0) {
          const data = (await ff.readFile(outName)) as Uint8Array;
          if (data && data.length > 0) {
            const dataUrl = await scaleJpegBytes(data, maxDim, quality);
            frames.push({ t: times[i], dataUrl });
          }
        }
      } catch (e) {
        crashed = true;
        console.warn("ffmpeg per-frame failed", e);
        break;
      }
      try { await ff.deleteFile(outName); } catch { /* ignore */ }
      onProgress(i + 1, times.length);
    }
  } finally {
    if (crashed) {
      resetFfmpeg();
    } else {
      try { await ff.deleteFile(inputName); } catch { /* ignore */ }
    }
  }

  return frames;
}
