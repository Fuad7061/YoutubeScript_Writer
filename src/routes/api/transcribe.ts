/**
 * POST /api/transcribe
 *
 * Server-side transcription using the universal Python transcript script.
 *
 * The Python script runs Tier 2 (yt-dlp + faster-whisper) when captions
 * are unavailable. This endpoint is only called by the frontend when:
 *   1. Tier 1 caption fetch returned no captions.
 *   2. The user has "Transcribe Audio (Whisper)" enabled in settings.
 *
 * Request body (JSON):
 *   { url: string }
 *
 * Response (JSON):
 *   {
 *     segments: Array<{ text: string; start: number; duration: number }>;
 *     meta: {
 *       title, videoId, url, language, languageCode, isGenerated,
 *       durationSeconds, duration, captionCount, source
 *     };
 *     logs: string[];
 *   }
 */
import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "@/lib/auth.server";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getPythonPath(): string {
  const venv = join(process.cwd(), "fast-whisper-env", "bin", "python3");
  return existsSync(venv) ? venv : "python3";
}

function getScriptPath(): string {
  return join(process.cwd(), "src", "lib", "python", "transcript.py");
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        let body: { url?: string; whisperModel?: string; proxy?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const { url, whisperModel = "small", proxy: bodyProxy } = body;
        if (!url || typeof url !== "string") {
          return json({ error: "url required" }, 400);
        }

        const python = getPythonPath();
        const script = getScriptPath();
        const logs: string[] = [];

        const proxy = bodyProxy?.trim() || process.env.YOUTUBE_PROXY || process.env.HTTPS_PROXY || "";

        logs.push("starting Whisper fallback via python transcript script…");
        logs.push(`model: ${whisperModel}`);
        if (proxy) logs.push(`proxy: configured (${proxy.replace(/:[^:@]+@/, ":***@")})`);

        try {
          logs.push("downloading audio via yt-dlp…");
          const args = [script, url, "true", whisperModel];
          if (proxy) args.push(proxy);
          const env = {
            ...process.env,
            ...(proxy ? { YOUTUBE_PROXY: proxy, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
          };

          const stdout = execFileSync(
            python,
            args,
            {
              timeout: 900_000, // 15 min max for large videos
              encoding: "utf8",
              maxBuffer: 10 * 1024 * 1024,
              env,
            }
          );

          let raw: any;
          try {
            raw = JSON.parse(stdout.trim());
          } catch {
            return json({ error: "Python script returned invalid JSON", logs }, 500);
          }

          if (raw.error) {
            logs.push(`script error: ${raw.error}`);
            return json({ error: raw.error, logs }, 500);
          }

          const segments = Array.isArray(raw.captions)
            ? raw.captions.map((c: any) => ({
                text: c.text,
                start: c.start,
                duration: c.dur,
              }))
            : [];

          logs.push(`transcription complete · ${segments.length} segments via ${raw.source ?? "whisper"}`);

          return json({
            segments,
            meta: {
              title: raw.title ?? null,
              videoId: raw.video_id ?? null,
              url: raw.url ?? url,
              language: raw.language ?? null,
              languageCode: raw.language_code ?? null,
              isGenerated: raw.is_generated ?? true,
              durationSeconds: raw.duration_seconds ?? null,
              duration: raw.duration ?? null,
              captionCount: raw.caption_count ?? segments.length,
              source: raw.source ?? "whisper",
            },
            logs,
          });
        } catch (e: any) {
          const errMsg = e?.stderr ?? e?.message ?? String(e);
          logs.push(`fatal: ${errMsg.slice(0, 400)}`);
          return json({ error: `Whisper transcription failed: ${errMsg.slice(0, 300)}`, logs }, 500);
        }
      },
    },
  },
});
