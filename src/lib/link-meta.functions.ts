import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({ url: z.string().min(1) });

export type LinkMeta = {
  title?: string;
  author?: string;
  description?: string;
  thumbnail?: string;
  duration?: number;
  platform?: string;
  canonicalUrl: string;
};

function pickYouTubeDuration(html: string): number | undefined {
  const match = html.match(/"lengthSeconds"\s*:\s*"?(\d+)"?/);
  const seconds = match ? Number(match[1]) : 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function detectPlatform(url: string): string {
  const h = url.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(h)) return "youtube";
  if (/tiktok\.com/.test(h)) return "tiktok";
  if (/instagram\.com/.test(h)) return "instagram";
  if (/facebook\.com|fb\.watch/.test(h)) return "facebook";
  if (/twitter\.com|x\.com/.test(h)) return "x";
  if (/reddit\.com/.test(h)) return "reddit";
  if (/vimeo\.com/.test(h)) return "vimeo";
  if (/twitch\.tv/.test(h)) return "twitch";
  return "other";
}

function pickMeta(html: string, prop: string): string | undefined {
  const re = new RegExp(
    `<meta\\s+(?:property|name)=["']${prop}["']\\s+content=["']([^"']+)["']`,
    "i",
  );
  const m = html.match(re);
  return m?.[1];
}

export const fetchLinkMeta = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }): Promise<LinkMeta> => {
    const platform = detectPlatform(data.url);

    // Prefer platform oEmbed where it's free + open
    try {
      if (platform === "youtube") {
        const r = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(data.url)}&format=json`,
        );
        if (r.ok) {
          const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
          let duration: number | undefined;
          try {
            const page = await fetch(data.url, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (compatible; FoundryBot/1.0; +https://github.com/your-org/your-repo)",
                "Accept": "text/html",
              },
              redirect: "follow",
            });
            if (page.ok) duration = pickYouTubeDuration((await page.text()).slice(0, 600_000));
          } catch {
            // oEmbed metadata is still useful without duration.
          }
          return {
            title: j.title,
            author: j.author_name,
            thumbnail: j.thumbnail_url,
            duration,
            platform,
            canonicalUrl: data.url,
          };
        }
      }
      if (platform === "vimeo") {
        const r = await fetch(
          `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(data.url)}`,
        );
        if (r.ok) {
          const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string; description?: string };
          return {
            title: j.title,
            author: j.author_name,
            description: j.description,
            thumbnail: j.thumbnail_url,
            platform,
            canonicalUrl: data.url,
          };
        }
      }
    } catch {
      // fall through to HTML scrape
    }

    // Generic OG scrape (works for TikTok, Reddit, X, most sites)
    try {
      const r = await fetch(data.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; FoundryBot/1.0; +https://github.com/your-org/your-repo)",
          "Accept": "text/html",
        },
        redirect: "follow",
      });
      if (r.ok) {
        const html = (await r.text()).slice(0, 200_000);
        return {
          title: pickMeta(html, "og:title") ?? pickMeta(html, "twitter:title"),
          description:
            pickMeta(html, "og:description") ?? pickMeta(html, "twitter:description"),
          thumbnail:
            pickMeta(html, "og:image") ?? pickMeta(html, "twitter:image"),
          author: pickMeta(html, "og:site_name"),
          platform,
          canonicalUrl: data.url,
        };
      }
    } catch {
      // ignore
    }

    return { platform, canonicalUrl: data.url };
  });
