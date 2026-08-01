import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Product } from "./types";
import type { AmazonMatch } from "./amazon.functions";

const AMAZON_LAMBDA = "https://4pobkr5oa4olwuvhx625uiozay0rrcuu.lambda-url.us-east-1.on.aws";
const DEFAULT_TAG = "consecho-20";

const Input = z.object({
  urls: z.array(z.string().min(1)).min(1).max(20),
  tag: z.string().optional(),
  config: z.object({
    mode: z.enum(["creator", "lambda"]),
    useLambdaFallback: z.boolean().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    partnerTag: z.string().optional(),
    region: z.enum(["NA", "EU", "FE"]).optional(),
    marketplace: z.string().optional(),
  }).optional(),
});

const ASIN_RE = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|^)([A-Z0-9]{10})(?:[/?]|$)/i;

export function parseAsin(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  const m = s.match(ASIN_RE);
  return m ? m[1].toUpperCase() : null;
}

type LambdaProduct = {
  id?: string;
  url?: string;
  title?: string;
  brand?: string;
  price?: string;
  category?: string;
  category_v2?: string;
  features?: string[];
  image_url?: string;
  score?: string | number;
};

function shortQuery(brand?: string, title?: string): string {
  const parts: string[] = [];
  if (brand) parts.push(brand);
  if (title) {
    const words = title
      .replace(/[,|:;–—-].*$/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !/^\d+$/.test(w))
      .slice(0, 4);
    parts.push(...words);
  }
  return parts.join(" ").trim();
}

import { getCreatorsItems, type CreatorSearchItem, type CreatorConfig } from "./amazon-creators";

export const fetchAmazonByAsins = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }): Promise<{
    products: Product[];
    amazon: Record<string, AmazonMatch[]>;
    asins: string[];
    failed: string[];
  }> => {
    const tag = data.tag || DEFAULT_TAG;
    const asins: string[] = [];
    const failedParse: string[] = [];
    const seen = new Set<string>();
    for (const line of data.urls) {
      const asin = parseAsin(line);
      if (!asin) {
        failedParse.push(line);
        continue;
      }
      if (seen.has(asin)) continue;
      seen.add(asin);
      asins.push(asin);
    }

    if (asins.length === 0) {
      throw new Error("No valid ASINs/URLs found. Paste amazon.com product URLs or bare 10-char ASINs.");
    }

    const products: Product[] = [];
    const amazon: Record<string, AmazonMatch[]> = {};
    const failed: string[] = [...failedParse];

    if (data.config?.mode === "creator") {
      const cfg: CreatorConfig = {
        clientId: data.config.clientId || "",
        clientSecret: data.config.clientSecret || "",
        partnerTag: data.config.partnerTag || tag,
        region: (data.config.region || "NA") as any,
        marketplace: data.config.marketplace || "www.amazon.com",
      };

      try {
        const items = await getCreatorsItems(asins, cfg);
        const itemMap = new Map<string, CreatorSearchItem>();
        for (const item of items) {
          if (item.asin) itemMap.set(item.asin.toUpperCase(), item);
        }

        for (const asin of asins) {
          const item = itemMap.get(asin);
          if (!item) {
            failed.push(asin);
            products.push({
              name: `Amazon product ${asin}`,
              affiliate_url: `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(cfg.partnerTag)}`,
              amazon_search_query: asin,
              confidence: 0.5,
              mentioned_context: `Direct Amazon input — lookup failed for ASIN ${asin}`,
            });
            continue;
          }

          const name = item.itemInfo?.title?.displayValue || `Amazon product ${asin}`;
          const features = item.itemInfo?.features?.displayValues || [];
          const price = item.offersV2?.listings?.[0]?.price?.money?.displayAmount;
          const url = item.detailPageURL || `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(cfg.partnerTag)}`;

          products.push({
            name,
            description: features.slice(0, 2).join(" • ") || features[0] || "",
            key_feature: features[0] || "",
            estimated_price: price,
            affiliate_url: url,
            amazon_search_query: shortQuery(undefined, name) || asin,
            mentioned_context: `Direct Amazon input (ASIN ${asin})`,
            confidence: 1,
          });

          amazon[name] = [{
            title: name,
            price: price,
            image: item.images?.primary?.small?.url,
            affiliateUrl: url,
            features,
            rating: item.score,
          }];
        }
        return { products, amazon, asins, failed };
      } catch (err: any) {
        if (!data.config.useLambdaFallback) {
          throw err;
        }
        console.warn(`Creators API failed (${err.message}), falling back to Lambda for ASINs: ${asins.join(",")}`);
      }
    }



    const results = await Promise.allSettled(
      asins.map(async (asin) => {
        const url = `${AMAZON_LAMBDA}/?q=${asin}&tag=${encodeURIComponent(tag)}&page=1`;
        const res = await fetch(url, {
          headers: { Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
        });
        if (!res.ok) throw new Error(`lambda ${res.status}`);
        const payload = (await res.json()) as { products?: LambdaProduct[] };
        // Prefer an exact-ASIN match; else first product.
        const list = payload.products ?? [];
        const exact = list.find((p) => (p.id || "").toUpperCase() === asin);
        const p = exact ?? list[0];
        if (!p) throw new Error("no product returned");
        return { asin, p };
      }),
    );

    results.forEach((r, i) => {
      const asin = asins[i];
      if (r.status === "rejected") {
        failed.push(asin);
        // Emit a stub so the user can edit manually rather than losing the batch.
        products.push({
          name: `Amazon product ${asin}`,
          affiliate_url: `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(tag)}`,
          amazon_search_query: asin,
          confidence: 0.5,
          mentioned_context: `Direct Amazon input — lookup failed for ASIN ${asin}`,
        });
        return;
      }
      const { p } = r.value;
      const name = (p.title || `Amazon product ${asin}`).trim();
      const brand = p.brand?.trim();
      const category = p.category_v2 || p.category;
      const features = (p.features || []).filter((f) => f && f.trim().length > 0);
      const key = features[0] || "";
      const desc = features.slice(0, 2).join(" • ") || key;

      products.push({
        name,
        brand,
        category,
        description: desc,
        key_feature: key,
        estimated_price: p.price,
        affiliate_url: p.url || `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(tag)}`,
        amazon_search_query: shortQuery(brand, name) || asin,
        mentioned_context: `Direct Amazon input (ASIN ${asin})`,
        confidence: 1,
      });

      amazon[name] = [
        {
          title: name,
          price: p.price,
          image: p.image_url,
          affiliateUrl: p.url,
          brand,
          features,
          rating: p.score,
        },
      ];
    });

    return { products, amazon, asins, failed };
  });
