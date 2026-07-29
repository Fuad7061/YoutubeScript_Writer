import { Mic2 } from "lucide-react";
import type { StageDefinition } from "../_types";

const meta: StageDefinition = {
  id: "commentary",
  label: "Commentary",
  route: "/commentary",
  icon: Mic2,
  description: "Write viral commentary script from source analysis.",
  order: 50,
  supportedModes: ["analysis"],
  inputs: {
    analysis: { label: "Analysis report", token: "{{analyze.summary}}", required: true },
    draft: { label: "Video draft", token: "{{analyze.draft}}", required: false },
  },
  outputs: {
    script: { label: "Commentary script", type: "text" },
  },
  defaults: {
    enabled: true,
    autoRun: false,
    inputs: { analysis: "{{analyze.summary}}", draft: "{{analyze.draft}}" },
  },
  hasOutput: (p) => Boolean(p.mode === "analysis" && p.script),
};

export default meta;
