/**
 * YouTube diagnostic endpoint.
 *
 * GET /api/youtube-debug?url=<encoded-url>
 *
 * Runs `yt-dlp --list-formats` (and --dump-single-json on failure) using the
 * same cookies/options as the real pipelines, so you can see exactly what
 * YouTube returns for this server's IP + current cookies. Useful when you get
 * "Requested format is not available" or "Sign in to confirm" — it shows
 * whether the issue is auth (no formats at all) or just format selection.
 *
 * Auth required. Output is plain text (the raw yt-dlp output).
 */
import { createFileRoute } from "@tanstack/react-router";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { requireAuth } from "@/lib/auth.server";

const COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH || "/data/youtube-cookies.txt";

export const Route = createFileRoute("/api/youtube-debug")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        const url = new URL(request.url).searchParams.get("url");
        if (!url) return new Response("missing ?url=", { status: 400 });

        const args = ["--list-formats", "--no-warnings"];
        if (existsSync(COOKIES_PATH)) args.push("--cookies", COOKIES_PATH);

        const result = spawnSync("yt-dlp", [...args, url], {
          encoding: "utf8",
          timeout: 60_000,
        });

        const stdout = result.stdout || "";
        const stderr = result.stderr || "";
        const exited = result.status;

        // If --list-formats produced nothing useful, include the error context.
        const body =
          `exit code: ${exited}\n\n` +
          `--- stdout ---\n${stdout || "(empty)"}\n\n` +
          `--- stderr ---\n${stderr || "(empty)"}\n`;

        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});
