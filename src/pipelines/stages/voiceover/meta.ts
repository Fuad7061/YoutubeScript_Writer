import { AudioLines } from "lucide-react";
import type { StageDefinition } from "@/pipelines/_core/types";

const meta: StageDefinition = {
  id: "voiceover",
  label: "Voiceover",
  route: "/voiceover",
  icon: AudioLines,
  description: "TTS with per-sentence controls (Lovable · Gemini · Murf).",
  order: 70,
  supportedModes: ["youtube", "amazon", "analysis"],
  inputs: {
    script: { label: "Script text", token: "{{script.text}}", required: true },
  },
  outputs: {
    audio: { label: "Voiceover audio", type: "blob" },
  },
  defaults: {
    enabled: true,
    autoRun: false,
    inputs: { script: "{{script.text}}" },
  },
  hasOutput: (p) => Boolean(p.voiceover),
};

export default meta;
