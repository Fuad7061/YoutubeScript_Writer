import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Resolves any public video URL (YouTube, TikTok, Instagram, Facebook, X/Twitter,
 * Reddit, Vimeo, etc.) into direct low-quality media URLs the browser can download
 * and analyse.
 *
 * Resolver ladder (all built-in, running inside the VPS venv — zero hosted
 * third-party APIs, nothing that can block a datacenter egress IP):
 *   1. YouTube → /api/media-proxy?resolve=youtube (same-request resolve+stream).
 *      The proxy ladders InnerTube (youtubei.js) → yt-dlp (TV/embedded clients +
 *      browser TLS impersonation) internally. InnerTube is only pre-flighted
 *      here for metadata; the bytes always come from the proxy.
 *   2. Everything else → /api/media-proxy?resolve=any, which runs yt-dlp
 *      directly (TikTok, Instagram, Facebook, X, Reddit, Vimeo, …).
 *
 * (cobalt.tools was removed after they shut down their public video API;
 * noteai/snapscooper/dltkk/yoink were removed because they reject VPS IPs.)
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

/** True for youtube.com / youtu.be / shorts URLs. */
function isYouTubeUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.replace(/^www\./, "");
    return h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be";
  } catch {
    return false;
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

    // 1. YouTube → resolve+stream in the same server request via /api/media-proxy.
    //    The proxy ladders InnerTube → yt-dlp internally. InnerTube is only
    //    pre-flighted here for metadata (best effort — link-meta covers the
    //    rest); the proxy URL is returned regardless so the built-in yt-dlp
    //    path is always reachable.
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

    // 2. Non-YouTube → yt-dlp via the same proxy (built-in, any platform).
    const q = encodeURIComponent(data.quality);
    const u = encodeURIComponent(data.url);
    return {
      status: "ok",
      videoUrl: `/api/media-proxy?resolve=any&url=${u}&quality=${q}&track=video`,
      audioSeparate: false,
      service: "ytdlp+proxy",
      instance: "yt-dlp",
    };
  });
