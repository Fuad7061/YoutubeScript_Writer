/**
 * Server-side FFmpeg frame extraction.
 *
 * Replaces browser @ffmpeg/ffmpeg (WASM).
 * Uses the system `ffmpeg` binary installed in the Docker image via:
 *   apk add ffmpeg
 *
 * Strategy:
 *   1. Accept a video URL (proxied server-side) or uploaded temp file path.
 *   2. Use ffmpeg to extract N evenly-spaced JPEG frames at scaled resolution.
 *   3. Return frames as base64 data URLs — same shape as the old browser extractor.
 *
 * Performance vs browser WASM:
 *   - System ffmpeg decodes H.264 at native speed — 10–50× faster than WASM.
 *   - No 30MB WASM download for the user.
 *   - Full codec support (VP9, AV1, HEVC, etc.) without any extra config.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type ServerFrame = {
  t: number;       // timestamp in seconds
  dataUrl: string; // "data:image/jpeg;base64,..."
};

export type ServerFrameOptions = {
  maxFrames?: number;
  maxDim?: number;    // max width/height in pixels (default 720)
  quality?: number;   // jpeg quality 1–31 where 2 = ~high (ffmpeg qscale:v)
  onLog?: (msg: string) => void;
};

/** Probe video duration in seconds using ffprobe. */
export function probeDuration(input: string): number | null {
  const result = spawnSync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    input,
  ], { encoding: "utf8", timeout: 30_000 });

  if (result.status !== 0) return null;
  try {
    const json = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const d = parseFloat(json.format?.duration ?? "");
    return isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

function autoFrameCount(duration: number, maxFrames?: number): number {
  const cap = Math.min(30, Math.max(1, Math.floor(maxFrames ?? 30)));
  if (!isFinite(duration) || duration <= 0) return 8;
  let n: number;
  if (duration <= 20) n = Math.ceil(duration / 2);
  else if (duration <= 60) n = Math.ceil(6 + (duration - 20) / 8);
  else if (duration <= 180) n = Math.ceil(11 + (duration - 60) / 15);
  else if (duration <= 600) n = Math.ceil(22 + (duration - 180) / 30);
  else n = 30;
  return Math.min(cap, Math.max(1, n));
}

/**
 * Extract frames from a video URL using system ffmpeg.
 *
 * @param input  Video URL or local file path.
 * @param opts   Extraction options.
 * @returns      Array of { t, dataUrl } sorted by timestamp.
 */
export async function extractFramesServer(
  input: string,
  opts: ServerFrameOptions = {},
): Promise<ServerFrame[]> {
  const { maxDim = 720, quality = 3, onLog } = opts;

  onLog?.("probing video duration via ffprobe…");
  const duration = probeDuration(input);
  onLog?.(duration ? `duration: ${duration.toFixed(1)}s` : "duration unknown — using default frame count");

  const n = autoFrameCount(duration ?? 120, opts.maxFrames);
  onLog?.(`extracting ${n} frames at max ${maxDim}px…`);

  // Work in a temp directory that we'll clean up after.
  const tmpDir = join(tmpdir(), `foundry-frames-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Build the fps filter to extract exactly N frames evenly spaced.
    // We use `fps=N/duration` so ffmpeg selects frames at equal intervals.
    const fpsFilter = duration
      ? `fps=${n}/${duration.toFixed(3)}`
      : `select='not(mod(n\\,${Math.max(1, Math.floor(25 / Math.max(1, n)))}))':n=${n}`;

    const scaleFilter = `scale='min(${maxDim}\\,iw)':'-2'`;
    const filterChain = `${fpsFilter},${scaleFilter}`;

    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vf", filterChain,
      "-qscale:v", String(quality),
      "-frames:v", String(n),
      join(tmpDir, "frame_%04d.jpg"),
    ];

    onLog?.(`ffmpeg ${args.slice(4).join(" ")}`);
    const result = spawnSync("ffmpeg", args, {
      timeout: 120_000,
      encoding: "buffer",
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString("utf8") ?? "";
      throw new Error(`ffmpeg failed (exit ${result.status}): ${stderr.slice(-500)}`);
    }

    // Read all output frames and build data URLs.
    const files = readdirSync(tmpDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    onLog?.(`got ${files.length} frames — encoding to base64…`);

    const frames: ServerFrame[] = files.map((file, i) => {
      const data = readFileSync(join(tmpDir, file));
      const b64 = data.toString("base64");
      // Estimate timestamp: evenly spaced over the known duration.
      const t = duration ? (i / Math.max(1, files.length - 1)) * duration : i * 2;
      return { t: parseFloat(t.toFixed(2)), dataUrl: `data:image/jpeg;base64,${b64}` };
    });

    onLog?.(`frame extraction complete — ${frames.length} frames`);
    return frames;
  } finally {
    // Always clean up temp files.
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}
