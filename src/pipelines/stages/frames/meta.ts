import { Film } from "lucide-react";
import type { StageDefinition } from "@/pipelines/_core/types";

const meta: StageDefinition = {
  id: "frames",
  label: "Frames",
  route: "/frames",
  icon: Film,
  description: "Sample and vision-analyse key frames.",
  order: 30,
  supportedModes: ["youtube"],
  inputs: {
    url: { label: "Video URL", token: "{{project.url}}", required: true },
    products: { label: "Product list", token: "{{products.list}}", required: false },
  },
  outputs: {
    frames: { label: "Analysed frames", type: "json" },
  },
  defaults: {
    enabled: true,
    autoRun: false,
    inputs: { url: "{{project.url}}", products: "{{products.list}}" },
  },
  hasOutput: (p) => Boolean(p.products?.some((x) => x.frame)),
};

export default meta;
