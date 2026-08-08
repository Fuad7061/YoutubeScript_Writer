import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Resolves any public video URL (YouTube, TikTok, Instagram, Facebook, X/Twitter,
 * Reddit, Vimeo, etc.) into direct low-quality media URLs the browser can download
 * and analyse.
 *
 * Resolver ladder:
 *   1. YouTube → /api/media-proxy (same-request resolve+stream). The proxy
 *      ladders InnerTube → noteai → snapscooper → yt-dlp (TV client + browser
 *      TLS impersonation) internally. No third-party API is called here at
 *      resolve time — datacenter/VPS egress IPs get rejected by them anyway
 *      (noteai 400 / snapscooper 401), and the proxy tries them in the same
 *      request regardless.
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

    const exclude = new Set(
      (data.exclude ?? []).map((s) => s.toLowerCase().replace(/\+proxy$/, "")),
    );
    const errors: string[] = [];

    // 1. YouTube → resolve+stream in the same server request via /api/media-proxy.
    //    The proxy ladders InnerTube → noteai → snapscooper → yt-dlp (TV client +
    //    browser TLS impersonation) internally. Third-party resolver APIs reject
    //    datacenter egress IPs (noteai 400 / snapscooper 401 on VPSes), so we
    //    never call them here — only pre-flight InnerTube for metadata (best
    //    effort). The proxy URL is returned regardless, which keeps the built-in
    //    yt-dlp path reachable even when every third-party resolver is blocked.
    if (isYouTubeUrl(data.url)) {
      const q = encodeURIComponent(data.quality);
      const u = encodeURIComponent(data.url);
      const target = Number(data.quality) || 240;

      let meta: { title?: string; duration?: number; thumbnail?: string } | undefined;
      let innertubeOk = false;
      if (!exclude.has("innertube")) {
        try {
          const { innertubeResolve } = await import("@/lib/youtube-innertube.server");
          const picked = await innertubeResolve(data.url, target);
          if (picked) {
            innertubeOk = true;
            meta = picked.meta;
          }
        } catch {
          // metadata pre-flight only — the proxy still has its own ladder
        }
      }
      return {
        status: "ok",
        videoUrl: `/api/media-proxy?resolve=youtube&url=${u}&quality=${q}&track=video`,
        audioSeparate: false,
        service: innertubeOk ? "innertube+proxy" : "ytdlp+proxy",
        instance: innertubeOk ? "youtube.innertube" : "yt-dlp",
        meta,
      };
    }

    // 2. Non-YouTube → dltkk (fast, single POST) then yoink (cross-platform).
    if (!exclude.has("dltkk")) {
      const dltkk = await tryDltkk(data.url, data.quality);
      if (dltkk) return dltkk;
      errors.push("dltkk: no video response");
    }
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
