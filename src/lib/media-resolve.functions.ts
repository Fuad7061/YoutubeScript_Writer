import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Resolves any public video URL (YouTube, TikTok, Instagram, Facebook, X/Twitter,
 * Reddit, Vimeo, etc.) into direct low-quality media URLs the browser can download
 * and analyse.
 *
 * Resolver ladder:
 *   1. noteai.io  → YouTube only (returns direct googlevideo URLs)
 *   2. dltkk.to   → non-YouTube (single POST → mp4 stream)
 *   3. yoink.tools → cross-platform fallback
 *
 * (cobalt.tools was removed after they shut down their public video API.)
 */


const Input = z.object({
  url: z.string().min(1),
  quality: z.enum(["144", "240", "360", "480", "720"]).default("240"),
  instance: z.string().optional(),
  exclude: z.array(z.string()).optional(),
});

export type ResolvedMedia = {
  status: "ok";
  /** Direct URL for the video stream (may be muxed video+audio or video-only). */
  videoUrl: string;
  /** Separate audio-only URL when the source is split into two streams. */
  audioUrl?: string;
  /** True when videoUrl has no audio and audioUrl must be fetched separately. */
  audioSeparate: boolean;
  service: string;
  filename?: string;
  meta?: { title?: string; artist?: string; duration?: number };
  instance: string;
};

/** Detect URLs that are already a direct media file — skip the resolver entirely. */
function isDirectMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|wav|ogg)(\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** Best-guess platform hint for dltkk. */
function detectPlatform(raw: string): string {
  try {
    const h = new URL(raw).hostname.replace(/^www\./, "");
    if (h.includes("tiktok")) return "tiktok";
    if (h.includes("instagram")) return "instagram";
    if (h.includes("facebook") || h === "fb.watch") return "facebook";
    if (h.includes("twitter") || h === "x.com" || h === "t.co") return "twitter";
    if (h.includes("reddit")) return "reddit";
    if (h.includes("vimeo")) return "vimeo";
    if (h.includes("youtube") || h === "youtu.be") return "youtube";
  } catch {}
  return "youtube";
}

/** True for youtube.com / youtu.be / shorts URLs. */
function isYouTubeUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.replace(/^www\./, "");
    return h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be";
  } catch {
    return false;
  }
}


/**
 * YouTube resolver via noteai.io. Returns direct googlevideo URLs which we
 * proxy same-origin (see /api/media-proxy).
 */
async function tryNoteai(rawUrl: string, quality: string): Promise<{ media: ResolvedMedia | null; err?: string }> {
  if (!isYouTubeUrl(rawUrl)) return { media: null };

  // Normalize shorts → watch?v= for the noteai payload.
  let videoUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (m) videoUrl = `https://www.youtube.com/watch?v=${m[1]}`;
    else if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      if (id) videoUrl = `https://www.youtube.com/watch?v=${id}`;
    }
  } catch {}

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    // Mimic the real browser call: full referer/origin + browser UA. The
    // API rejects (403/blocked) plain server requests without these.
    const res = await fetch("https://www.noteai.io/api/tools/youtube/info", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        origin: "https://www.noteai.io",
        referer: "https://www.noteai.io/621/youtube-video-downloader",
        "user-agent": BROWSER_UA,
        "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ video: videoUrl }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { media: null, err: `noteai http ${res.status}` };
    const json = (await res.json()) as {
      success?: boolean;
      video_info?: { title?: string; duration?: number; thumbnail?: string };
      video_formats?: Array<{
        ext?: string;
        height?: number;
        url?: string;
        has_audio?: boolean;
        quality?: number;
        filesize?: number;
      }>;
      audio_formats?: Array<{ ext?: string; url?: string; filesize?: number | null }>;
    };
    if (!json.success || !Array.isArray(json.video_formats)) {
      return { media: null, err: "noteai: empty formats" };
    }

    const target = Number(quality) || 360;
    const videos = json.video_formats.filter((f) => f.url && f.ext === "mp4");
    if (videos.length === 0) return { media: null, err: "noteai: no mp4 formats" };

    const muxed = videos.filter((f) => f.has_audio);
    const meta = {
      title: json.video_info?.title,
      duration: json.video_info?.duration,
    };

    if (muxed.length > 0) {
      const atOrAbove = muxed.filter((f) => (f.height ?? 0) >= target);
      const pick = (atOrAbove.length ? atOrAbove : muxed)
        .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0];
      return {
        media: {
          status: "ok",
          videoUrl: `/api/media-proxy?u=${encodeURIComponent(pick.url!)}`,
          audioSeparate: false,
          service: "noteai",
          instance: "noteai.io",
          meta,
        },
      };
    }

    const videoOnly = [...videos].sort(
      (a, b) => Math.abs((a.height ?? 0) - target) - Math.abs((b.height ?? 0) - target),
    )[0];
    const audio = (json.audio_formats ?? []).find((a) => a.url);
    if (!videoOnly?.url || !audio?.url) return { media: null, err: "noteai: no audio track" };
    return {
      media: {
        status: "ok",
        videoUrl: `/api/media-proxy?u=${encodeURIComponent(videoOnly.url)}`,
        audioUrl: `/api/media-proxy?u=${encodeURIComponent(audio.url)}`,
        audioSeparate: true,
        service: "noteai",
        instance: "noteai.io",
        meta,
      },
    };
  } catch (e) {
    return { media: null, err: `noteai: ${(e as Error).message}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * dltkk.to — fastest option for non-YouTube. Returns a same-origin proxy URL
 * that POSTs to dltkk server-side and streams the mp4 back.
 */
async function tryDltkk(rawUrl: string, quality: string): Promise<ResolvedMedia | null> {
  const q =
    quality === "144" || quality === "240"
      ? "360"
      : quality === "480"
      ? "480"
      : quality === "720"
      ? "720"
      : quality === "360"
      ? "360"
      : "360";
  const platform = detectPlatform(rawUrl);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const probe = await fetch("https://dltkk.to/api/download", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dltkk.to",
        referer: "https://dltkk.to/",
        "user-agent": BROWSER_UA,
        accept: "*/*",
      },
      body: JSON.stringify({ url: rawUrl, format: "mp4", platform, quality: q }),
      signal: ctrl.signal,
    });
    if (!probe.ok) {
      try { await probe.body?.cancel(); } catch {}
      return null;
    }
    const ct = probe.headers.get("content-type") || "";
    try { await probe.body?.cancel(); } catch {}
    if (!ct.startsWith("video/") && !ct.startsWith("application/octet-stream")) {
      return null;
    }
    const proxied =
      `/api/media-proxy?service=dltkk&url=${encodeURIComponent(rawUrl)}` +
      `&format=mp4&platform=${platform}&quality=${q}`;
    return {
      status: "ok",
      videoUrl: proxied,
      audioSeparate: false,
      service: "dltkk",
      instance: "dltkk.to",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function tryYoink(url: string, quality: string): Promise<ResolvedMedia | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const metaRes = await fetch(
      `https://yoink.tools/api/metadata?url=${encodeURIComponent(url)}&playlist=false`,
      {
        headers: { accept: "*/*", referer: "https://yoink.tools/", "user-agent": BROWSER_UA },
        signal: ctrl.signal,
      },
    );
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as {
      title?: string; uploader?: string; duration?: string; id?: string; ext?: string;
    };

    const q =
      quality === "144" || quality === "240"
        ? "360p"
        : quality === "360"
        ? "360p"
        : quality === "480"
        ? "480p"
        : quality === "720"
        ? "720p"
        : "1080p";

    const filename = (meta.title ?? "video").replace(/[^\w\s-]/g, "").slice(0, 60) || "video";
    const progressId = `lov${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const dl =
      `https://yoink.tools/api/download?url=${encodeURIComponent(url)}` +
      `&format=video&filename=${encodeURIComponent(filename)}` +
      `&quality=${q}&container=mp4&audioFormat=mp3&audioBitrate=128` +
      `&progressId=${progressId}&twitterGifs=true`;

    const proxied = `/api/media-proxy?u=${encodeURIComponent(dl)}`;
    return {
      status: "ok",
      videoUrl: proxied,
      audioSeparate: false,
      service: "yoink",
      filename: `${filename}.mp4`,
      meta: {
        title: meta.title,
        artist: meta.uploader,
        duration: meta.duration ? Number(meta.duration) : undefined,
      },
      instance: "yoink.tools",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * snapscooper.com — YouTube-only fallback. Returns muxed mp4 when available,
 * otherwise pairs a video-only stream with the best audio track.
 */
async function trySnapscooper(
  rawUrl: string,
  quality: string,
): Promise<{ media: ResolvedMedia | null; err?: string }> {
  if (!isYouTubeUrl(rawUrl)) return { media: null };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("https://snapscooper.com/api/tool/post-info", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://snapscooper.com",
        referer: "https://snapscooper.com/tools/yt1",
        "user-agent": BROWSER_UA,
        "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ toolId: "youtube", url: rawUrl, highres: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { media: null, err: `snapscooper http ${res.status}` };
    const json = (await res.json()) as {
      contents?: Array<{
        audios?: Array<{ label?: string; url?: string; has_audio?: boolean; mime_type?: string; content_length?: number }>;
        videos?: Array<{ label?: string; url?: string; has_audio?: boolean; mime_type?: string; content_length?: number }>;
      }>;
      title?: string;
    };
    const bucket = json.contents?.[0];
    if (!bucket || !Array.isArray(bucket.videos)) {
      return { media: null, err: "snapscooper: empty contents" };
    }

    const target = Number(quality) || 360;
    const heightOf = (label?: string) => {
      const m = label?.match(/(\d{3,4})p/);
      return m ? Number(m[1]) : 0;
    };
    const mp4Videos = bucket.videos.filter((v) => v.url && /mp4/i.test(v.mime_type ?? ""));
    if (mp4Videos.length === 0) return { media: null, err: "snapscooper: no mp4 videos" };

    const muxed = mp4Videos.filter((v) => v.has_audio);
    const meta = { title: json.title };

    if (muxed.length > 0) {
      const atOrAbove = muxed.filter((v) => heightOf(v.label) >= target);
      const pick = (atOrAbove.length ? atOrAbove : muxed).sort(
        (a, b) => heightOf(a.label) - heightOf(b.label),
      )[0];
      return {
        media: {
          status: "ok",
          videoUrl: `/api/media-proxy?u=${encodeURIComponent(pick.url!)}`,
          audioSeparate: false,
          service: "snapscooper",
          instance: "snapscooper.com",
          meta,
        },
      };
    }

    const videoOnly = [...mp4Videos].sort(
      (a, b) => Math.abs(heightOf(a.label) - target) - Math.abs(heightOf(b.label) - target),
    )[0];
    const audios = (bucket.audios ?? []).filter((a) => a.url);
    // Prefer smallest (low) then bigger; snapscooper labels "low"/"medium".
    const audio = audios.sort((a, b) => (a.content_length ?? 0) - (b.content_length ?? 0))[0];
    if (!videoOnly?.url || !audio?.url) return { media: null, err: "snapscooper: no audio track" };
    return {
      media: {
        status: "ok",
        videoUrl: `/api/media-proxy?u=${encodeURIComponent(videoOnly.url)}`,
        audioUrl: `/api/media-proxy?u=${encodeURIComponent(audio.url)}`,
        audioSeparate: true,
        service: "snapscooper",
        instance: "snapscooper.com",
        meta,
      },
    };
  } catch (e) {
    return { media: null, err: `snapscooper: ${(e as Error).message}` };
  } finally {
    clearTimeout(t);
  }
}

export const resolveMediaUrl = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }): Promise<ResolvedMedia> => {
    if (isDirectMediaUrl(data.url)) {
      return {
        status: "ok",
        videoUrl: data.url,
        audioSeparate: false,
        service: "direct",
        instance: "direct",
      };
    }

    const exclude = new Set((data.exclude ?? []).map((s) => s.toLowerCase()));
    const errors: string[] = [];

    // 1. YouTube → resolve+stream in the same worker request via /api/media-proxy.
    //    googlevideo IP-locks signed URLs; two hops (resolve → proxy) fail with
    //    403 whenever Cloudflare rotates egress IPs. We only need pre-flight
    //    metadata + audio-separate detection here — the actual bytes are
    //    fetched by the proxy (which tries: InnerTube → noteai → snapscooper).
    if (isYouTubeUrl(data.url)) {
      const q = encodeURIComponent(data.quality);
      const u = encodeURIComponent(data.url);
      const target = Number(data.quality) || 240;

      // 1a. Built-in InnerTube extractor (yt-dlp-style, no third party).
      if (!exclude.has("innertube")) {
        try {
          const { innertubeResolve } = await import("@/lib/youtube-innertube.server");
          const picked = await innertubeResolve(data.url, target);
          if (picked) {
            const videoUrl = `/api/media-proxy?resolve=youtube&url=${u}&quality=${q}&track=video`;
            const audioUrl = picked.audioSeparate
              ? `/api/media-proxy?resolve=youtube&url=${u}&quality=${q}&track=audio`
              : undefined;
            return {
              status: "ok",
              videoUrl,
              audioUrl,
              audioSeparate: picked.audioSeparate,
              service: "innertube+proxy",
              instance: "youtube.innertube",
              meta: picked.meta,
            };
          }
          errors.push("innertube: empty formats");
        } catch (e) {
          errors.push(`innertube: ${(e as Error).message}`);
        }
      }

      // 1b. noteai fallback (still runs in same worker request as the download).
      if (!exclude.has("noteai")) {
        const { media, err } = await tryNoteai(data.url, data.quality);
        if (media) {
          const videoUrl = `/api/media-proxy?resolve=youtube&url=${u}&quality=${q}&track=video`;
          const audioUrl = media.audioSeparate
            ? `/api/media-proxy?resolve=youtube&url=${u}&quality=${q}&track=audio`
            : undefined;
          return {
            status: "ok",
            videoUrl,
            audioUrl,
            audioSeparate: media.audioSeparate,
            service: "noteai+proxy",
            instance: "noteai.io",
            meta: media.meta,
          };
        }
        if (err) errors.push(err);
      }
    }

    // 2. YouTube → snapscooper (its CDN is not IP-locked, safe two-hop).
    if (!exclude.has("snapscooper")) {
      const { media, err } = await trySnapscooper(data.url, data.quality);
      if (media) return media;
      if (err) errors.push(err);
    }

    // 3. dltkk
    if (!exclude.has("dltkk")) {
      const dltkk = await tryDltkk(data.url, data.quality);
      if (dltkk) return dltkk;
      errors.push("dltkk: no video response");
    }

    // 3. yoink
    if (!exclude.has("yoink")) {
      const yoink = await tryYoink(data.url, data.quality);
      if (yoink) return yoink;
      errors.push("yoink: no video response");
    }

    throw new Error(
      `Could not resolve media URL. Tried: ${errors.join(" | ") || "no resolvers available"}. ` +
        `The video may be private, DRM-protected, region-locked, or the resolvers are temporarily down. ` +
        `Try uploading the file directly instead.`,
    );
  });
