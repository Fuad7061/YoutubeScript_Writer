/**
 * POST /api/extract-frames
 *
 * Server-side video frame extraction using system ffmpeg.
 * Replaces the browser @ffmpeg/ffmpeg WASM implementation.
 *
 * Request body (JSON):
 *   { url: string; maxFrames?: number; maxDim?: number; quality?: number }
 *
 * Response (JSON):
 *   { frames: Array<{ t: number; dataUrl: string }> }
 *
 * The extracted frames are base64 JPEG data URLs — same shape as the
 * old browser extractor, so all downstream pipeline code is unchanged.
 */
import { createFileRoute } from "@tanstack/react-router";
import { extractFramesServer } from "@/lib/ffmpeg.server";
import { requireAuth } from "@/lib/auth.server";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/extract-frames")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        let body: { url?: string; maxFrames?: number; maxDim?: number; quality?: number };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }

        const { url, maxFrames, maxDim, quality } = body;
        if (!url || typeof url !== "string") {
          return json({ error: "url required" }, 400);
        }

        const logs: string[] = [];

        try {
          const frames = await extractFramesServer(url, {
            maxFrames,
            maxDim,
            quality,
            onLog: (msg) => logs.push(msg),
          });

          return json({ frames, logs });
        } catch (e) {
          return json(
            { error: (e as Error).message, logs },
            500,
          );
        }
      },
    },
  },
});
