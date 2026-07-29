import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams a remote media file back to the browser as a same-origin response.
 *
 * Modes:
 *   ?u=<encoded https url>              → GET pass-through (allowlisted hosts)
 *   ?resolve=youtube&url=...&quality=…  → Resolve via noteai/snapscooper AND
 *                                        stream in the SAME request. Required
 *                                        for googlevideo because it IP-locks
 *                                        signed URLs to the requester's egress
 *                                        IP — two-hop flows fail with 403
 *                                        whenever the Worker's outbound IP
 *                                        changes between resolve and download.
 *   ?service=dltkk&url=...              → POST to dltkk with JSON body
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// noteai signs its googlevideo URLs for the ANDROID_VR YouTube client.
const ANDROID_VR_UA =
  "com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12; SM-Q3 Build/SP1A.210812.016) gzip";

const ALLOWED_HOSTS = new Set([
  "yoink.tools",
  "www.yoink.tools",
  "api-v3.smvd.xyz",
  "render-api-v3.smvd.xyz",
]);

function isAllowedHost(host: string): boolean {
  if (ALLOWED_HOSTS.has(host)) return true;
  if (host.endsWith(".googlevideo.com") || host === "googlevideo.com") return true;
  if (host.endsWith(".smvd.xyz")) return true;
  return false;
}

function headersForTarget(target: URL, range: string | null): Record<string, string> {
  const isGoogle = target.hostname.endsWith("googlevideo.com");
  const isSmvd = target.hostname.endsWith("smvd.xyz");
  const signedClient = target.searchParams.get("c") ?? "";
  const ua = isGoogle && signedClient === "ANDROID_VR" ? ANDROID_VR_UA : BROWSER_UA;
  const effectiveRange = range ?? (isGoogle ? "bytes=0-" : null);
  const refererFor = () => {
    if (isGoogle) return "https://www.youtube.com/";
    if (isSmvd) return "https://snapscooper.com/";
    return "https://yoink.tools/";
  };
  return {
    referer: refererFor(),
    "user-agent": ua,
    accept: "*/*",
    ...(isGoogle
      ? { "accept-language": "en-US,en;q=0.9", origin: "https://www.youtube.com" }
      : {}),
    ...(isSmvd ? { origin: "https://snapscooper.com" } : {}),
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

async function proxyDltkk(url: string, format: string, platform: string, quality: string) {
  const upstream = await fetch("https://dltkk.to/api/download", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://dltkk.to",
      referer: "https://dltkk.to/",
      "user-agent": BROWSER_UA,
      accept: "*/*",
    },
    body: JSON.stringify({ url, format, platform, quality }),
  });
  return relayResponse(upstream);
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
   YouTube resolve+stream in a single request. Because googlevideo binds the
   signed URL to the caller's IP (`ip=…` param), the same Worker invocation
   MUST both resolve and fetch — two hops usually differ in egress IP → 403.
   ──────────────────────────────────────────────────────────────────────── */

function normalizeYouTube(raw: string): string {
  try {
    const u = new URL(raw);
    const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

type PickedStream = { url: string; audioUrl?: string };

async function resolveNoteai(rawUrl: string, quality: number): Promise<PickedStream | null> {
  const videoUrl = normalizeYouTube(rawUrl);
  const res = await fetch("https://www.noteai.io/api/tools/youtube/info", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: "https://www.noteai.io",
      referer: "https://www.noteai.io/621/youtube-video-downloader",
      "user-agent": BROWSER_UA,
    },
    body: JSON.stringify({ video: videoUrl }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    success?: boolean;
    video_formats?: Array<{ ext?: string; height?: number; url?: string; has_audio?: boolean }>;
    audio_formats?: Array<{ ext?: string; url?: string }>;
  };
  if (!json.success || !Array.isArray(json.video_formats)) return null;
  const videos = json.video_formats.filter((f) => f.url && f.ext === "mp4");
  if (!videos.length) return null;
  const muxed = videos.filter((f) => f.has_audio);
  if (muxed.length) {
    const atOrAbove = muxed.filter((f) => (f.height ?? 0) >= quality);
    const pick = (atOrAbove.length ? atOrAbove : muxed).sort(
      (a, b) => (a.height ?? 0) - (b.height ?? 0),
    )[0];
    return { url: pick.url! };
  }
  const videoOnly = [...videos].sort(
    (a, b) => Math.abs((a.height ?? 0) - quality) - Math.abs((b.height ?? 0) - quality),
  )[0];
  const audio = (json.audio_formats ?? []).find((a) => a.url);
  if (!videoOnly?.url || !audio?.url) return null;
  return { url: videoOnly.url, audioUrl: audio.url };
}

async function resolveSnapscooper(rawUrl: string, quality: number): Promise<PickedStream | null> {
  const res = await fetch("https://snapscooper.com/api/tool/post-info", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: "https://snapscooper.com",
      referer: "https://snapscooper.com/tools/yt1",
      "user-agent": BROWSER_UA,
    },
    body: JSON.stringify({ toolId: "youtube", url: rawUrl, highres: false }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    contents?: Array<{
      audios?: Array<{ label?: string; url?: string; has_audio?: boolean; mime_type?: string; content_length?: number }>;
      videos?: Array<{ label?: string; url?: string; has_audio?: boolean; mime_type?: string; content_length?: number }>;
    }>;
  };
  const bucket = json.contents?.[0];
  if (!bucket?.videos) return null;
  const heightOf = (l?: string) => (l?.match(/(\d{3,4})p/) ? Number(RegExp.$1) : 0);
  const mp4s = bucket.videos.filter((v) => v.url && /mp4/i.test(v.mime_type ?? ""));
  if (!mp4s.length) return null;
  const muxed = mp4s.filter((v) => v.has_audio);
  if (muxed.length) {
    const atOrAbove = muxed.filter((v) => heightOf(v.label) >= quality);
    const pick = (atOrAbove.length ? atOrAbove : muxed).sort(
      (a, b) => heightOf(a.label) - heightOf(b.label),
    )[0];
    return { url: pick.url! };
  }
  const videoOnly = [...mp4s].sort(
    (a, b) => Math.abs(heightOf(a.label) - quality) - Math.abs(heightOf(b.label) - quality),
  )[0];
  const audios = (bucket.audios ?? []).filter((a) => a.url);
  const audio = audios.sort((a, b) => (a.content_length ?? 0) - (b.content_length ?? 0))[0];
  if (!videoOnly?.url || !audio?.url) return null;
  return { url: videoOnly.url, audioUrl: audio.url };
}

async function resolveInnertube(rawUrl: string, quality: number): Promise<PickedStream | null> {
  const { innertubeResolve } = await import("@/lib/youtube-innertube.server");
  const picked = await innertubeResolve(rawUrl, quality);
  if (!picked) return null;
  return { url: picked.videoUrl, audioUrl: picked.audioUrl };
}

async function proxyResolveYouTube(
  rawUrl: string,
  quality: number,
  track: "video" | "audio",
  range: string | null,
): Promise<Response> {
  const attempts: Array<() => Promise<PickedStream | null>> = [
    () => resolveInnertube(rawUrl, quality),
    () => resolveNoteai(rawUrl, quality),
    () => resolveSnapscooper(rawUrl, quality),
  ];
  const errs: string[] = [];
  for (const fn of attempts) {
    try {
      const picked = await fn();
      if (!picked) { errs.push("empty"); continue; }
      const target = track === "audio" && picked.audioUrl ? picked.audioUrl : picked.url;
      const parsed = new URL(target);
      if (!isAllowedHost(parsed.hostname)) { errs.push(`host ${parsed.hostname}`); continue; }
      const upstream = await fetchWithRetry(parsed, range);
      if (upstream.status === 403 || upstream.status === 410) {
        try { await upstream.body?.cancel(); } catch {}
        errs.push(`edge ${upstream.status}`);
        continue; // try next resolver
      }
      return relayResponse(upstream);
    } catch (e) {
      errs.push((e as Error).message);
    }
  }
  return new Response(`youtube resolve+stream failed: ${errs.join(" | ")}`, { status: 502 });
}

export const Route = createFileRoute("/api/media-proxy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const service = url.searchParams.get("service");
        const resolve = url.searchParams.get("resolve");

        if (resolve === "youtube") {
          const src = url.searchParams.get("url");
          if (!src) return new Response("missing url", { status: 400 });
          const quality = Number(url.searchParams.get("quality") || "360") || 360;
          const track = (url.searchParams.get("track") === "audio" ? "audio" : "video") as
            | "video"
            | "audio";
          return proxyResolveYouTube(src, quality, track, request.headers.get("range"));
        }

        if (service === "dltkk") {
          const src = url.searchParams.get("url");
          if (!src) return new Response("missing url", { status: 400 });
          const format = url.searchParams.get("format") || "mp4";
          const platform = url.searchParams.get("platform") || "youtube";
          const quality = url.searchParams.get("quality") || "360";
          return proxyDltkk(src, format, platform, quality);
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
