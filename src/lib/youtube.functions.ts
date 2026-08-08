/**
 * YouTube caption fetching — Tier 1 only (fast).
 *
 * Calls `src/lib/python/transcript.py` with allow_whisper=false.
 * The Python script uses `youtube-transcript-api` to fetch real captions.
 *
 * If no captions are found, the function returns an empty `captions` array
 * and a `reason: "NoCaptionsAvailable"` field. The caller (runYouTube in
 * index.tsx) then decides whether to trigger the Whisper fallback via
 * POST /api/transcribe.
 */

import { createServerFn } from "@tanstack/react-start";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { innertubeCaptions, extractVideoId } from "./youtube-innertube.server";

const Input = z.object({
  url: z.string().min(1),
  proxy: z.string().optional(),
  transcribeAudio: z.boolean().optional(), // passed through for context, not used here
});

/** Resolve the venv python or fall back to system python3. */
function getPythonPath(): string {
  const venv = join(process.cwd(), "fast-whisper-env", "bin", "python3");
  return existsSync(venv) ? venv : "python3";
}

/** Absolute path to the universal transcript python script. */
function getScriptPath(): string {
  return join(process.cwd(), "src", "lib", "python", "transcript.py");
}

/** Convert the Python script's `captions` array to the internal format. */
function normalizeCaptions(captions: Array<{ start: number; dur: number; text: string }>) {
  return captions.map((c) => ({
    text: c.text,
    start: c.start,
    duration: c.dur,
  }));
}

export const fetchTranscript = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const python = getPythonPath();
    const script = getScriptPath();

    let raw: any;
    const proxy = data.proxy?.trim() || process.env.YOUTUBE_PROXY || process.env.HTTPS_PROXY || "";
    try {
      // Run Tier 1 only — allow_whisper = false.
      // Whisper fallback is a separate POST /api/transcribe call from the frontend.
      const args = [script, data.url, "false", "small"];
      if (proxy) {
        args.push(proxy);
      }
      const env = {
        ...process.env,
        ...(proxy ? { YOUTUBE_PROXY: proxy, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
      };
      const stdout = execFileSync(python, args, {
        timeout: 30_000,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env,
      });
      raw = JSON.parse(stdout.trim());
    } catch (e: any) {
      // If python crashes entirely, propagate a clear error.
      const stderr = e?.stderr ?? e?.message ?? String(e);
      throw new Error(`Caption fetch failed: ${stderr.slice(0, 300)}`);
    }

    // The Python script always returns a JSON object.
    // Check for errors or missing captions.
    if (raw.error === "NoCaptionsAvailable" || raw.error === "VideoUnavailable") {
      // Tier 1c: InnerTube (IOS client) timedtext captions — works from
      // datacenter IPs where the web-based transcript/yt-dlp endpoints get
      // bot-checked.
      const inner = await innertubeCaptions(data.url);
      if (inner && inner.captions.length > 0) {
        return {
          videoId: extractVideoId(data.url) ?? null,
          transcript: inner.captions.map((c) => ({
            text: c.text,
            start: c.start,
            duration: c.duration,
          })),
          meta: {
            videoId: extractVideoId(data.url) ?? null,
            title: inner.title ?? undefined,
            url: data.url,
            language: inner.language ?? undefined,
            languageCode: inner.languageCode ?? undefined,
            isGenerated: inner.isGenerated ?? undefined,
            availableLanguages: [],
            durationSeconds: null,
            duration: undefined,
            captionCount: inner.captions.length,
            source: "innertube",
          },
          reason: "captions" as const,
        };
      }

      return {
        videoId: raw.video_id ?? null,
        transcript: [] as Array<{ text: string; start: number; duration: number }>,
        meta: {
          videoId: raw.video_id ?? null,
          title: raw.title ?? null,
          url: raw.url ?? data.url,
          language: raw.language ?? null,
          languageCode: raw.language_code ?? null,
          isGenerated: raw.is_generated ?? null,
          availableLanguages: raw.available_languages ?? [],
          durationSeconds: raw.duration_seconds ?? null,
          duration: raw.duration ?? null,
          source: raw.source ?? null,
        },
        reason: "no-captions" as const,
      };
    }

    if (raw.error) {
      throw new Error(`Caption script error: ${raw.error}`);
    }

    const captions = Array.isArray(raw.captions) ? normalizeCaptions(raw.captions) : [];

    return {
      videoId: raw.video_id ?? null,
      transcript: captions,
      meta: {
        videoId: raw.video_id ?? null,
        title: raw.title ?? null,
        url: raw.url ?? data.url,
        language: raw.language ?? null,
        languageCode: raw.language_code ?? null,
        isGenerated: raw.is_generated ?? null,
        translatedTo: raw.translated_to ?? null,
        availableLanguages: raw.available_languages ?? [],
        durationSeconds: raw.duration_seconds ?? null,
        duration: raw.duration ?? null,
        captionCount: raw.caption_count ?? captions.length,
        source: raw.source ?? "captions",
      },
    };
  });
