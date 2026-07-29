/**
 * Built-in YouTube extractor using InnerTube (the API that yt-dlp / youtubei.js
 * speak). We use the raw `/player` call with the IOS client because that client
 * returns direct googlevideo URLs — no signature cipher, no player-JS decoding.
 *
 * Server-only: pulls in the youtubei.js library which is not shipped to the
 * browser bundle.
 */

import { Innertube } from "youtubei.js";

export type InnertubeFormat = {
  itag: number;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  qualityLabel?: string;
  bitrate?: number;
  contentLength?: string;
  audioQuality?: string;
};

export type InnertubePicked = {
  videoUrl: string;
  audioUrl?: string;
  audioSeparate: boolean;
  meta: { title?: string; duration?: number; thumbnail?: string };
};

let ytPromise: Promise<Innertube> | undefined;
function getYt(): Promise<Innertube> {
  if (!ytPromise) {
    // Cloudflare Workers: global fetch/Request/Response must be called with the
    // correct `this` (globalThis). youtubei.js passes these around and triggers
    // "Illegal invocation" unless we wrap them. Also disable the cache since
    // there's no persistent filesystem in workerd.
    const boundFetch: typeof fetch = (input, init) =>
      fetch(input as RequestInfo | URL, init);
    ytPromise = Innertube.create({
      fetch: boundFetch,
      cache: undefined,
      retrieve_player: false,
    }).catch((e) => {
      ytPromise = undefined;
      throw e;
    });
  }
  return ytPromise;
}

/** Extract the 11-char YouTube video id from any URL shape (watch, shorts, youtu.be, embed). */
export function extractVideoId(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[\w-]{6,}$/.test(id) ? id : null;
    }
    if (u.hostname.endsWith("youtube.com") || u.hostname.endsWith("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{6,}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function callPlayer(videoId: string): Promise<{
  videoDetails?: {
    title?: string;
    lengthSeconds?: string;
    thumbnail?: { thumbnails?: Array<{ url?: string; width?: number }> };
  };
  streamingData?: {
    formats?: InnertubeFormat[];
    adaptiveFormats?: InnertubeFormat[];
  };
}> {
  const yt = await getYt();
  const res = await yt.actions.execute("/player", { videoId, client: "IOS" });
  return res.data as never;
}

/** Fetch title + duration + thumbnail via InnerTube (fast metadata). */
export async function innertubeMetadata(rawUrl: string): Promise<{
  title?: string;
  duration?: number;
  thumbnail?: string;
} | null> {
  const id = extractVideoId(rawUrl);
  if (!id) return null;
  try {
    const data = await callPlayer(id);
    const d = data.videoDetails;
    if (!d) return null;
    const thumb = d.thumbnail?.thumbnails?.[d.thumbnail.thumbnails.length - 1]?.url;
    return {
      title: d.title,
      duration: d.lengthSeconds ? Number(d.lengthSeconds) : undefined,
      thumbnail: thumb,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a YouTube URL to a direct playable stream via InnerTube.
 * Prefers muxed (video+audio) mp4 at/near target quality; falls back to
 * separate video-only mp4 + best m4a audio when muxed isn't offered
 * (typical for Shorts and >=1080p).
 */
export async function innertubeResolve(
  rawUrl: string,
  targetQuality: number,
): Promise<InnertubePicked | null> {
  const id = extractVideoId(rawUrl);
  if (!id) return null;

  const data = await callPlayer(id);
  const sd = data.streamingData;
  if (!sd) return null;

  const all = [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])].filter((f) => f.url);
  if (all.length === 0) return null;

  const mp4Video = all
    .filter((f) => f.mimeType?.startsWith("video/mp4"))
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  const muxed = mp4Video.filter((f) => f.audioQuality);

  const d = data.videoDetails;
  const meta = {
    title: d?.title,
    duration: d?.lengthSeconds ? Number(d.lengthSeconds) : undefined,
    thumbnail: d?.thumbnail?.thumbnails?.[d.thumbnail.thumbnails.length - 1]?.url,
  };

  if (muxed.length > 0) {
    const atOrAbove = muxed.filter((f) => (f.height ?? 0) >= targetQuality);
    const pick = (atOrAbove.length ? atOrAbove : muxed)[0];
    return { videoUrl: pick.url, audioSeparate: false, meta };
  }

  // Adaptive: pick closest-to-target mp4 video + best m4a audio.
  const videoOnly = [...mp4Video].sort(
    (a, b) =>
      Math.abs((a.height ?? 0) - targetQuality) - Math.abs((b.height ?? 0) - targetQuality),
  )[0];
  const m4a = all
    .filter((f) => f.mimeType?.startsWith("audio/mp4"))
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  if (!videoOnly || !m4a) return null;
  return { videoUrl: videoOnly.url, audioUrl: m4a.url, audioSeparate: true, meta };
}
