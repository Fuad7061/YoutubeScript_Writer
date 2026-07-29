import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AMAZON_LAMBDA = "https://4pobkr5oa4olwuvhx625uiozay0rrcuu.lambda-url.us-east-1.on.aws";
const DEFAULT_TAG = "consecho-20";

const Input = z.object({
  query: z.string().min(1),
  tag: z.string().optional(),
  limit: z.number().int().positive().max(5).optional(),
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

export const searchAmazon = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }): Promise<{ results: AmazonMatch[] }> => {
    const tag = data.tag || DEFAULT_TAG;
    const limit = data.limit ?? 3;
    const q = encodeURIComponent(data.query);
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
