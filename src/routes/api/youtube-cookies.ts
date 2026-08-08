/**
 * YouTube cookies management.
 *
 * POST   /api/youtube-cookies  { cookies: string }  → save Netscape cookies.txt
 * GET    /api/youtube-cookies                       → { present, path, bytes, updatedAt }
 * DELETE /api/youtube-cookies                       → remove saved cookies
 *
 * Saved to /data/youtube-cookies.txt (persistent volume). When present, every
 * yt-dlp invocation (media-proxy + transcript) adds --cookies <path> so YouTube
 * sees a logged-in, verified session instead of a bare datacenter IP.
 */
import { createFileRoute } from "@tanstack/react-router";
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { requireAuth } from "@/lib/auth.server";

const COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH || "/data/youtube-cookies.txt";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/youtube-cookies")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;
        if (!existsSync(COOKIES_PATH)) {
          return json({ present: false, path: COOKIES_PATH });
        }
        const st = statSync(COOKIES_PATH);
        return json({
          present: true,
          path: COOKIES_PATH,
          bytes: st.size,
          updatedAt: st.mtime.toISOString(),
        });
      },

      POST: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;
        let body: { cookies?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const raw = (body.cookies ?? "").trim();
        if (!raw) return json({ error: "cookies required" }, 400);

        // Accept either a full Netscape cookies.txt or a header-style cookie
      // string ("name=value; name2=value2"). Normalise to Netscape format.
        let content: string;
        if (raw.includes("\t") || raw.startsWith("# Netscape HTTP Cookie File")) {
          content = raw;
        } else {
          // Convert "k=v; k2=v2" → one "youtube.com\tTRUE\t/\tTRUE\t0\tk\tv" per pair
          const pairs = raw
            .split(";")
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => p.split("="))
            .filter((kv) => kv.length >= 2)
            .map(([k, ...v]) => [k.trim(), v.join("=").trim()]);
          const lines = ["# Netscape HTTP Cookie File", ...pairs.map(([k, v]) => `youtube.com\tTRUE\t/\tTRUE\t0\t${k}\t${v}`)];
          content = lines.join("\n") + "\n";
        }

        try {
          writeFileSync(COOKIES_PATH, content, { encoding: "utf8", mode: 0o600 });
        } catch (e: any) {
          return json({ error: `Failed to write cookies: ${e.message}` }, 500);
        }
        return json({ ok: true, path: COOKIES_PATH, bytes: Buffer.byteLength(content, "utf8") });
      },

      DELETE: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;
        if (existsSync(COOKIES_PATH)) {
          try { unlinkSync(COOKIES_PATH); } catch (e: any) {
            return json({ error: `Failed to remove: ${e.message}` }, 500);
          }
        }
        return json({ ok: true });
      },
    },
  },
});
