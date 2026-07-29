import { ScrollText } from "lucide-react";
import type { StageDefinition } from "@/pipelines/_core/types";

const meta: StageDefinition = {
  id: "script",
  label: "Script",
  route: "/script",
  icon: ScrollText,
  description: "Full review script — Deep Dive or Rapid Listicle.",
  order: 60,
  supportedModes: ["youtube", "amazon"],
  inputs: {
    products: { label: "Product list", token: "{{products.list}}", required: true },
    transcript: { label: "Transcript", token: "{{transcript.text}}", required: false },
    frames: { label: "Frames", token: "{{frames.frames}}", required: false },
  },
  outputs: {
    text: { label: "Script text", type: "text" },
  },
  defaults: {
    enabled: true,
    autoRun: false,
    inputs: {
      products: "{{products.list}}",
      transcript: "{{transcript.text}}",
      frames: "{{frames.frames}}",
    },
  },
  hasOutput: (p) => Boolean(p.mode !== "analysis" && p.script),
};

export default meta;
