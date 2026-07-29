import { Telescope } from "lucide-react";
import type { StageDefinition } from "../_types";

const meta: StageDefinition = {
  id: "analyze",
  label: "Analyze",
  route: "/analyze",
  icon: Telescope,
  description: "Frame + audio analysis of any video URL or upload.",
  order: 10,
  supportedModes: ["analysis"],
  inputs: {
    url: { label: "Video URL", token: "{{project.url}}", required: false },
  },
  outputs: {
    summary: { label: "Summary", type: "text" },
    scenes: { label: "Scenes", type: "json" },
    draft: { label: "Draft script", type: "text" },
  },
  defaults: {
    enabled: true,
    autoRun: true,
    inputs: { url: "{{project.url}}" },
  },
  hasOutput: (p) => Boolean(p.analysis),
};

export default meta;
