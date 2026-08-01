import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AMAZON_LAMBDA = "https://4pobkr5oa4olwuvhx625uiozay0rrcuu.lambda-url.us-east-1.on.aws";
const DEFAULT_TAG = "consecho-20";

const Input = z.object({
  query: z.string().min(1),
  tag: z.string().optional(),
  limit: z.number().int().positive().max(5).optional(),
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

export type AmazonMatch = {
  title: string;
  price?: string;
  image?: string;
  affiliateUrl?: string;
  brand?: string;
  features?: string[];
  rating?: number | string;
};

import { searchCreatorsItems, type CreatorSearchItem, type CreatorConfig } from "./amazon-creators";

export const searchAmazon = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }): Promise<{ results: AmazonMatch[] }> => {
    const limit = data.limit ?? 3;
    const q = encodeURIComponent(data.query);

    if (data.config?.mode === "creator") {
      try {
        const cfg: CreatorConfig = {
          clientId: data.config.clientId || "",
          clientSecret: data.config.clientSecret || "",
          partnerTag: data.config.partnerTag || data.tag || DEFAULT_TAG,
          region: (data.config.region || "NA") as any,
          marketplace: data.config.marketplace || "www.amazon.com",
        };
        const items = await searchCreatorsItems(data.query, limit, cfg);
        const results: AmazonMatch[] = items.map((p) => {
          const title = p.itemInfo?.title?.displayValue || "";
          const price = p.offersV2?.listings?.[0]?.price?.money?.displayAmount;
          const features = p.itemInfo?.features?.displayValues || [];
          return {
            title,
            price,
            image: p.images?.primary?.small?.url,
            affiliateUrl: p.detailPageURL,
            features,
            rating: p.score,
          };
        });
        return { results };
      } catch (e: any) {
        if (!data.config.useLambdaFallback) {
          throw e;
        }
        console.warn(`Creators API failed (${e.message}), falling back to Lambda for query: ${data.query}`);
      }
    }

    const tag = data.tag || DEFAULT_TAG;
    const res = await fetch(`${AMAZON_LAMBDA}/?q=${q}&tag=${tag}&page=1`, {
      headers: { Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!res.ok) throw new Error(`Amazon lookup failed: ${res.status}`);
    const payload = (await res.json()) as {
      products?: Array<{
        title?: string;
        price?: string;
        url?: string;
        image_url?: string;
        brand?: string;
        features?: string[];
        rating?: number | string;
      }>;
    };
    const results = (payload.products ?? []).slice(0, limit).map((p) => ({
      title: p.title ?? "",
      price: p.price,
      image: p.image_url,
      affiliateUrl: p.url,
      brand: p.brand,
      features: p.features,
      rating: p.rating,
    }));
    return { results };
  });
