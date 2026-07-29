// Shared helper: capture a real freeze-frame per product timestamp using
// only built-in code — 1 video download reused across all products, seek-canvas
// per timestamp with an ffmpeg.wasm fallback. Falls back to the YouTube static
// thumbnail so every product always has an image.
//
// Cost = bandwidth for a single low-res download. No paid APIs.

import type { Product, ProductFrame, TranscriptSegment } from "@/lib/types";
import { extractFramesAtTimes } from "@/lib/video-frames";
import { getCachedVideo, setCachedVideo } from "@/lib/video-cache";
import { resolveMediaUrl } from "@/lib/media-resolve.functions";
import { findTimestampForContext, applyVisualOffset } from "@/lib/storyboard";

export type AlignLogger = (msg: string, level?: "info" | "ok" | "warn") => void;

function thumbnailFrame(videoId: string, t: number): ProductFrame {
  return {
    kind: "thumbnail",
    imageUrl: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    timeSeconds: t,
  };
}

async function getSourceVideo(
  sourceUrl: string,
  videoId: string,
  log: AlignLogger,
): Promise<Blob | null> {
  const cached = getCachedVideo(videoId);
  if (cached) {
    log(`reusing cached source · ${(cached.blob.size / 1024 / 1024).toFixed(1)} MB`, "ok");
    return cached.blob;
  }
  try {
    log(`resolving source video…`);
    let resolved = await resolveMediaUrl({ data: { url: sourceUrl, quality: "240" } });
    log(`resolved via ${resolved.service}`, "ok");
    let vr = await fetch(resolved.videoUrl);
    if (!vr.ok) {
      log(`download failed via ${resolved.service} (${vr.status}) — trying fallback`, "warn");
      resolved = await resolveMediaUrl({
        data: { url: sourceUrl, quality: "240", exclude: [resolved.service] },
      });
      vr = await fetch(resolved.videoUrl);
    }
    if (!vr.ok) throw new Error(`download ${vr.status}`);
    const blob = await vr.blob();
    setCachedVideo(videoId, blob);
    log(`downloaded ${(blob.size / 1024 / 1024).toFixed(1)} MB`, "ok");
    return blob;
  } catch (e) {
    log(`source unavailable (${(e as Error).message}) — using thumbnails`, "warn");
    return null;
  }
}

/**
 * Compute a timestamp for each product from the transcript and capture the
 * matching frame. Returns a new products array with `timestamp_seconds` and
 * `frame` populated. Never throws — worst case every frame is a thumbnail.
 */
export async function alignProductFrames(opts: {
  products: Product[];
  transcript: TranscriptSegment[];
  videoId: string;
  sourceUrl: string;
  log?: AlignLogger;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ products: Product[]; captured: number; usedThumbnails: number }> {
  const log = opts.log ?? (() => {});
  const onProgress = opts.onProgress ?? (() => {});

  // 1) Timestamp per product from transcript alignment (unchanged heuristic).
  const withTimes = opts.products.map((p) => {
    const match = findTimestampForContext(p.mentioned_context ?? p.name, opts.transcript);
    const t = match ? applyVisualOffset(match) : (p.timestamp_seconds ?? 0);
    return { ...p, timestamp_seconds: t } as Product;
  });

  // 2) Try Tier 1 (real frame). Fall back to Tier 2 (thumbnail) if any step fails.
  const blob = await getSourceVideo(opts.sourceUrl, opts.videoId, log);
  let captured = 0;
  let usedThumbnails = 0;

  if (blob) {
    const times = withTimes.map((p) => p.timestamp_seconds ?? 0);
    try {
      const frames = await extractFramesAtTimes(blob, times, {
        maxDim: 640,
        quality: 0.7,
        onProgress,
        onLog: (m) => log(m, "info"),
      });
      // Match captured frames back by nearest timestamp.
      const byTime = new Map<number, string>();
      for (const f of frames) byTime.set(Math.round(f.t * 100), f.dataUrl);
      const out = withTimes.map((p) => {
        const key = Math.round((p.timestamp_seconds ?? 0) * 100);
        const dataUrl = byTime.get(key);
        if (dataUrl) {
          captured++;
          const frame: ProductFrame = {
            kind: "image",
            imageUrl: dataUrl,
            timeSeconds: p.timestamp_seconds ?? 0,
          };
          return { ...p, frame };
        }
        usedThumbnails++;
        return { ...p, frame: thumbnailFrame(opts.videoId, p.timestamp_seconds ?? 0) };
      });
      return { products: out, captured, usedThumbnails };
    } catch (e) {
      log(`frame capture failed (${(e as Error).message}) — using thumbnails`, "warn");
    }
  }

  // Tier 2 only
  const out = withTimes.map((p) => {
    usedThumbnails++;
    return { ...p, frame: thumbnailFrame(opts.videoId, p.timestamp_seconds ?? 0) };
  });
  return { products: out, captured: 0, usedThumbnails };
}

/**
 * Re-capture a single product frame at a nudged timestamp using the cached
 * source video. Returns a thumbnail if no cached video is available.
 */
export async function recaptureAt(
  videoId: string,
  seconds: number,
): Promise<ProductFrame> {
  const cached = getCachedVideo(videoId);
  if (!cached) return thumbnailFrame(videoId, seconds);
  try {
    const frames = await extractFramesAtTimes(cached.blob, [Math.max(0, seconds)], {
      maxDim: 640,
      quality: 0.7,
    });
    const f = frames[0];
    if (!f) return thumbnailFrame(videoId, seconds);
    return { kind: "image", imageUrl: f.dataUrl, timeSeconds: seconds };
  } catch {
    return thumbnailFrame(videoId, seconds);
  }
}
