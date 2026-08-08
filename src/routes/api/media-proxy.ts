import { createFileRoute } from "@tanstack/react-router";
import { spawn } from "node:child_process";
import { requireAuth } from "@/lib/auth.server";

/**
 * Streams a remote media file back to the browser as a same-origin response.
 *
 * Modes:
 *   ?resolve=youtube&url=...&quality=…  → YouTube built-in ladder: InnerTube
 *                                        (youtubei.js, free, no process) then
 *                                        yt-dlp (TV/embedded clients + browser
 *                                        TLS impersonation) — both resolve and
 *                                        download from THIS server's own IP.
 *   ?resolve=any&url=...&quality=…      → yt-dlp only, any platform
 *                                        (TikTok, Instagram, Facebook, X,
 *                                        Reddit, Vimeo, …).
 *   ?u=<encoded https url>              → GET pass-through (googlevideo only).
 *
 * Everything runs inside the VPS venv (yt-dlp + curl_cffi) — no third-party
 * downloader APIs, nothing that can reject a datacenter egress IP.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// innertube signs its googlevideo URLs for the ANDROID_VR YouTube client.
const ANDROID_VR_UA =
  "com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12; SM-Q3 Build/SP1A.210812.016) gzip";

function isAllowedHost(host: string): boolean {
  return host.endsWith(".googlevideo.com") || host === "googlevideo.com";
}

function headersForTarget(target: URL, range: string | null): Record<string, string> {
  const isGoogle = target.hostname.endsWith("googlevideo.com");
  const signedClient = target.searchParams.get("c") ?? "";
  const ua = isGoogle && signedClient === "ANDROID_VR" ? ANDROID_VR_UA : BROWSER_UA;
  const effectiveRange = range ?? (isGoogle ? "bytes=0-" : null);
  return {
    referer: "https://www.youtube.com/",
    origin: "https://www.youtube.com",
    "user-agent": ua,
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    ...(effectiveRange ? { range: effectiveRange } : {}),
  };
}

async function fetchWithRetry(target: URL, range: string | null): Promise<Response> {
  const isGoogle = target.hostname.endsWith("googlevideo.com");
  const headers = headersForTarget(target, range);
  let upstream = await fetch(target.toString(), { headers });
  if (isGoogle && upstream.status === 403) {
    try { await upstream.body?.cancel(); } catch {}
    const { referer: _r, ...noRef } = headers;
    upstream = await fetch(target.toString(), { headers: noRef });
  }
  return upstream;
}

async function proxyPass(target: URL, range: string | null) {
  return relayResponse(await fetchWithRetry(target, range));
}

function relayResponse(upstream: Response) {
  const headers = new Headers();
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set("cache-control", "private, max-age=60");
  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ────────────────────────────────────────────────────────────────────────
   YouTube resolve+stream in a single request. googlevideo binds signed URLs
   to the caller's IP (`ip=…` param), so the same request MUST both resolve
   and fetch from the same egress IP. InnerTube and yt-dlp both do this
   natively — third-party resolver APIs were removed because they sign URLs
   for their own IPs and reject VPS egress IPs outright.
   ──────────────────────────────────────────────────────────────────────── */

type PickedStream = { url: string; audioUrl?: string };

async function resolveInnertube(rawUrl: string, quality: number): Promise<PickedStream | null> {
  const { innertubeResolve } = await import("@/lib/youtube-innertube.server");
  const picked = await innertubeResolve(rawUrl, quality);
  if (!picked) return null;
  return { url: picked.videoUrl, audioUrl: picked.audioUrl };
}

/**
 * Resolve+stream via yt-dlp running on this server.
 *
 * yt-dlp resolves AND downloads from this server's own IP, using TV/embedded
 * player clients (far less bot-checked than the web client) plus a browser
 * TLS fingerprint (curl_cffi impersonation) so the request looks like it
 * comes from a real browser instead of a datacenter server.
 */
// `web` is listed FIRST on purpose: it is the only player client whose
// extraction fetches the YouTube watch page, and that page carries the
// attestation challenge (ytAtN) that the bgutil PO-token provider needs to
// generate a token. The other clients (tv_embedded, tv, ...) call the
// Innertube player API directly and never see the watch page, so the
// provider would have to fetch the challenge itself from this (blocked) IP.
// Order matters: web → web_embedded → tv_embedded → tv → android_vr.
// YTDLP_PLAYER_CLIENTS can be overridden via env for experimentation.
const YTDLP_PLAYER_CLIENTS =
  process.env.YTDLP_PLAYER_CLIENTS || "web,web_embedded,tv_embedded,tv,android_vr";

type YtDlpStreamResult =
  | { ok: true; stream: ReadableStream<Uint8Array>; mime: string }
  | { ok: false; reason: string };

function ytDlpStream(
  rawUrl: string,
  quality: number,
  track: "video" | "audio",
  signal?: AbortSignal,
): Promise<YtDlpStreamResult> {
  const mime = track === "audio" ? "audio/mp4" : "video/mp4";
  const format =
    track === "audio"
      ? "bestaudio[ext=m4a]/bestaudio/best"
      : `best[height<=${quality}][ext=mp4]/best[height<=${quality}]/best[ext=mp4]/best`;
  // YTDLP_VERBOSE=1 drops --quiet/--no-warnings so the POT framework logs
  // (and any bot-check errors) are captured in the media-proxy log.
  const verbose = process.env.YTDLP_VERBOSE === "1";
  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-part",
    "--ignore-errors",
    "--no-cache-dir",
    "--impersonate",
    "chrome",
    "--extractor-args",
    `youtube:player_client=${YTDLP_PLAYER_CLIENTS}`,
  ];
  // Self-hosted PO token provider (bgutil-ytdlp-pot-provider container) —
  // defeats the "Sign in to confirm you're not a bot" check on flagged
  // datacenter IPs. Without BGUTIL_POT_URL set, yt-dlp runs as before.
  const potUrl = process.env.BGUTIL_POT_URL;
  if (potUrl) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${potUrl}`);
  }
  if (verbose) {
    args.push("--verbose");
  } else {
    args.push("--no-warnings", "--quiet");
  }
  args.push("-f", format, "-o", "-", "--", rawUrl);
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    let settled = false;
    let aborted = false;
    let stderrTail = "";
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        aborted = true;
        try { child.kill("SIGKILL"); } catch {}
        const detail = stderrTail.slice(-1500);
        const msg = [reason ?? "yt-dlp failed", detail && `stderr: ${detail}`]
          .filter(Boolean)
          .join(" — ")
          .slice(0, 2000);
        console.error(`[media-proxy] yt-dlp failed for ${rawUrl}: ${msg}`);
        void writer.abort(new Error(msg));
        resolve({ ok: false, reason: msg });
      } else {
        resolve({ ok: true, stream: readable, mime });
      }
    };
    // yt-dlp needs to produce its first byte within 90s or it's stuck
    // (proxy DNS, bot-checked player, etc.).
    const timer = setTimeout(() => finish(false, "timeout: no first byte within 90s"), 90_000);
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-1500);
    });
    child.stdout.on("end", () => {
      // Only close on the success path. Never close after abort — closing an
      // aborted WritableStream throws ERR_INVALID_STATE and crashes Node.
      if (settled && !aborted) void writer.close().catch(() => {});
      else if (!settled) finish(false, "yt-dlp exited without producing a stream");
    });
    child.stdout.on("data", (d: Buffer) => {
      if (!settled) finish(true);
      void writer.write(new Uint8Array(d)).catch(() => {});
    });
    child.stdout.on("error", () => finish(false));
    child.on("error", (e) => finish(false, `spawn error: ${e.message}`));
    signal?.addEventListener("abort", () => finish(false, "client aborted"), { once: true });
  });
}

/** YouTube ladder: InnerTube (fast, free) → yt-dlp (impersonated TV client). */
async function proxyResolveYouTube(
  rawUrl: string,
  quality: number,
  track: "video" | "audio",
  range: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const errs: string[] = [];

  // 1. InnerTube (youtubei.js IOS client). Signs URLs for this server's own
  //    IP, so the fetch below is self-consistent. Fast-fails when YouTube
  //    bot-checks the datacenter IP (empty formats) — yt-dlp is next.
  try {
    const picked = await resolveInnertube(rawUrl, quality);
    if (picked) {
      const target = track === "audio" && picked.audioUrl ? picked.audioUrl : picked.url;
      const parsed = new URL(target);
      if (isAllowedHost(parsed.hostname)) {
        const upstream = await fetchWithRetry(parsed, range);
        if (upstream.status !== 403 && upstream.status !== 410) {
          return relayResponse(upstream);
        }
        try { await upstream.body?.cancel(); } catch {}
        errs.push(`edge ${upstream.status}`);
      } else {
        errs.push(`host ${parsed.hostname}`);
      }
    } else {
      errs.push("innertube: empty formats");
    }
  } catch (e) {
    errs.push(`innertube: ${(e as Error).message}`);
  }

  // 2. yt-dlp directly from this server's own egress IP.
  try {
    const direct = await ytDlpStream(rawUrl, quality, track, signal);
    if (!direct.ok) {
      errs.push(`yt-dlp: ${direct.reason}`);
    } else {
      return relayResponse(
        new Response(direct.stream, {
          status: 200,
          headers: { "content-type": direct.mime, "cache-control": "private, max-age=60" },
        }),
      );
    }
  } catch (e) {
    errs.push(`yt-dlp: ${(e as Error).message}`);
  }
  // Server-side visibility: the browser only ever sees the status code, so
  // log the per-resolver failures (visible in docker logs) before replying.
  console.error(`[media-proxy] resolve+stream failed for ${rawUrl}: ${errs.join(" | ")}`);
  return new Response(`media resolve+stream failed: ${errs.join(" | ")}`, { status: 502 });
}

/** yt-dlp for any non-YouTube platform (TikTok, Instagram, X, Reddit, …). */
async function proxyYtDlp(
  rawUrl: string,
  quality: number,
  track: "video" | "audio",
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const direct = await ytDlpStream(rawUrl, quality, track, signal);
    if (direct.ok) {
      return relayResponse(
        new Response(direct.stream, {
          status: 200,
          headers: { "content-type": direct.mime, "cache-control": "private, max-age=60" },
        }),
      );
    }
    console.error(`[media-proxy] yt-dlp failed for ${rawUrl}: ${direct.reason}`);
    return new Response(`media stream failed: yt-dlp: ${direct.reason}`, { status: 502 });
  } catch (e) {
    return new Response(`media stream failed: yt-dlp: ${(e as Error).message}`, { status: 502 });
  }
}

export const Route = createFileRoute("/api/media-proxy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        const url = new URL(request.url);
        const resolve = url.searchParams.get("resolve");

        if (resolve === "youtube" || resolve === "any") {
          const src = url.searchParams.get("url");
          if (!src) return new Response("missing url", { status: 400 });
          const quality = Number(url.searchParams.get("quality") || "360") || 360;
          const track = (url.searchParams.get("track") === "audio" ? "audio" : "video") as
            | "video"
            | "audio";
          const range = request.headers.get("range");
          return resolve === "youtube"
            ? proxyResolveYouTube(src, quality, track, range, request.signal)
            : proxyYtDlp(src, quality, track, request.signal);
        }

        const target = url.searchParams.get("u");
        if (!target) return new Response("missing u", { status: 400 });
        let parsed: URL;
        try { parsed = new URL(target); }
        catch { return new Response("invalid u", { status: 400 }); }
        if (parsed.protocol !== "https:" || !isAllowedHost(parsed.hostname)) {
          return new Response("host not allowed", { status: 403 });
        }
        return proxyPass(parsed, request.headers.get("range"));
      },
    },
  },
});
