import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({ videoId: z.string().min(1) });

// InnerTube "player" endpoint returns the same playerResponse as the watch page
// but as clean JSON and is far less aggressively rate-limited than the HTML page.
// The ANDROID client key is public and stable; used widely by community tools.
const INNERTUBE_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";

async function fromInnertube(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
          "X-YouTube-Client-Name": "3",
          "X-YouTube-Client-Version": "19.09.37",
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "19.09.37",
              androidSdkVersion: 34,
              hl: "en",
              gl: "US",
            },
          },
        }),
      },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const spec =
      json?.storyboards?.playerStoryboardSpecRenderer?.spec ??
      json?.storyboards?.playerLiveStoryboardSpecRenderer?.spec ??
      null;
    return typeof spec === "string" ? spec : null;
  } catch {
    return null;
  }
}

async function fromWatchPage(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
    );
    if (!res.ok) return null;
    const html = await res.text();
    const patterns = [
      /"playerStoryboardSpecRenderer":\s*\{\s*"spec":\s*"([^"]+)"/,
      /"playerLiveStoryboardSpecRenderer":\s*\{\s*"spec":\s*"([^"]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    }
    return null;
  } catch {
    return null;
  }
}

export const getStoryboard = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    // NEVER throw across the RPC boundary — a thrown error here is surfaced
    // by TanStack Start's global error reporter and blanks the screen even
    // when the caller catches it. Return `spec: null` so callers can branch.
    try {
      const spec =
        (await fromInnertube(data.videoId)) ??
        (await fromWatchPage(data.videoId));
      return { spec: spec ?? null };
    } catch {
      return { spec: null };
    }
  });
