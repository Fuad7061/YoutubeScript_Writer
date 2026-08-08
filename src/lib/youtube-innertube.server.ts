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

export type InnertubeCaption = {
  text: string;
  start: number;
  duration: number;
};

export type InnertubeCaptionsResult = {
  captions: InnertubeCaption[];
  language?: string;
  languageCode?: string;
  isGenerated?: boolean;
  title?: string;
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
      // Do NOT set retrieve_player: false — that prevents caption_tracks from
      // being populated in getInfo(), causing innertubeCaptions() to always
      // return null. generate_session_locally avoids an extra network round-trip
      // for session init which can fail on some VPS network configs.
      generate_session_locally: true,
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
  const res = await withTimeout(
    yt.actions.execute("/player", { videoId, client: "IOS" }),
    12_000,
    "player",
  );
  return res.data as never;
}

/** Reject a promise if it doesn't settle in time (youtubei.js has no per-call timeouts). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`InnerTube ${what} call timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
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

/**
 * Fetch real captions via the InnerTube timedtext API (youtubei.js).
 *
 * This uses the app/client endpoints rather than the web watch-page HTML,
 * so it typically still works from datacenter IPs where both
 * youtube-transcript-api and yt-dlp's web client get bot-checked.
 *
 * Returns null when the video has no captions at all.
 */
export async function innertubeCaptions(
  rawUrl: string,
): Promise<InnertubeCaptionsResult | null> {
  const id = extractVideoId(rawUrl);
  if (!id) return null;

  try {
    const yt = await getYt();
    let info: any = null;
    const clients: Array<"IOS" | "ANDROID" | "WEB"> = ["IOS", "ANDROID", "WEB"];
    for (const client of clients) {
      try {
        const res = await withTimeout(yt.getInfo(id, { client }), 12_000, `getInfo (${client})`);
        if (res?.captions?.caption_tracks?.length) {
          info = res;
          break;
        }
      } catch (err) {
        console.warn(`[innertubeCaptions] client ${client} getInfo failed:`, (err as Error).message);
      }
    }
    if (!info) return null;
    const tracklist = info.captions;
    const tracks = tracklist?.caption_tracks ?? [];
    if (tracks.length === 0) return null;

    // Prefer manual English, then any manual, then auto-generated.
    const rank = (t: CaptionTrackData) => {
      const lang = (t.language_code ?? "").toLowerCase();
      const manual = !t.kind || t.kind !== "asr";
      let score = manual ? 10 : 0;
      if (lang === "en" || lang.startsWith("en-")) score += 5;
      else if (manual) score += 2;
      return score;
    };
    const best = [...tracks].sort((a, b) => rank(b) - rank(a))[0];
    if (!best?.base_url) return null;

    const res = await fetch(best.base_url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const raw = await res.text();

    let captions: InnertubeCaption[] = [];
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // json3 format: {"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"..."}]}]}
      try {
        const data = JSON.parse(trimmed);
        const events: any[] = data.events ?? data;
        for (const ev of Array.isArray(events) ? events : []) {
          const start = (ev.tStartMs ?? 0) / 1000;
          const dur = (ev.dDurationMs ?? 0) / 1000;
          const text = (ev.segs ?? [])
            .map((s: any) => s.utf8 ?? "")
            .join("")
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (text) captions.push({ text, start, duration: dur || 0.1 });
        }
      } catch {
        captions = [];
      }
    } else {
      // timedtext XML: <text start="0.24" dur="3.6">Hello world</text>
      const re = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const start = Number(m[1]);
        const dur = Number(m[2] ?? 0);
        const text = (m[3] ?? "")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, " ")
          .trim();
        if (text) captions.push({ text, start, duration: dur || 0.1 });
      }
    }

    if (captions.length === 0) return null;
    return {
      captions,
      language: best.name?.toString?.() ?? undefined,
      languageCode: best.language_code ?? undefined,
      isGenerated: best.kind === "asr",
      title: info.basic_info?.title,
    };
  } catch {
    return null;
  }
}

type CaptionTrackData = {
  base_url: string;
  name?: { toString?: () => string };
  language_code?: string;
  kind?: string;
};
