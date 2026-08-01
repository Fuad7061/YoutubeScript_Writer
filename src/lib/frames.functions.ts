import { createServerFn } from "@tanstack/react-start";
import { generateObject } from "ai";
import { z } from "zod";
import { renderPrompt } from "./prompt-registry";
import { resolveModel, type StageOverride } from "./ai-provider";

const Input = z.object({
  videoId: z.string().min(1),
  promptTemplate: z.string().optional(),
  override: z.any().optional(),
});

const FrameSchema = z.object({
  description: z.string(),
  scene: z.string().optional(),
  products_visible: z.array(z.string()).optional(),
});

const THUMBS = [
  { key: "maxresdefault", label: "hero" },
  { key: "hq1", label: "start" },
  { key: "hq2", label: "middle" },
  { key: "hq3", label: "end" },
];



export const DEFAULT_FRAME_DESCRIBE_TEMPLATE = `Describe this YouTube video frame. Return ONLY valid JSON:
{"description":"one paragraph","scene":"short label","products_visible":["item1","item2"]}`;

export const analyzeFrames = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const model = resolveModel(data.override as StageOverride | undefined);
    const rawTpl =
      data.promptTemplate && data.promptTemplate.trim().length > 0
        ? data.promptTemplate
        : DEFAULT_FRAME_DESCRIBE_TEMPLATE;
    const { text: promptText } = renderPrompt(rawTpl, {});
    const frames = await Promise.all(
      THUMBS.map(async (t) => {
        const url = `https://i.ytimg.com/vi/${data.videoId}/${t.key}.jpg`;
        try {
          const { object: parsed } = await generateObject({
            model,
            temperature: 0.3,
            maxOutputTokens: 16384,
            schema: FrameSchema,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: promptText },
                  { type: "image", image: new URL(url) },
                ],
              },
            ],
          });
          return { url, timestamp: t.label, ...parsed };
        } catch (e) {
          return { url, timestamp: t.label, description: `(analysis failed: ${(e as Error).message})`, products_visible: [] };
        }
      }),
    );
    return { frames };
  });
