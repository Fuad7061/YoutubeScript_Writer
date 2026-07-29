import { ShieldCheck } from "lucide-react";
import type { StageDefinition } from "@/pipelines/_core/types";

const meta: StageDefinition = {
  id: "fairuse",
  label: "Fair Use",
  route: "/fair-use",
  icon: ShieldCheck,
  description: "Compliance dossier for reused clips.",
  order: 90,
  supportedModes: ["youtube", "analysis"],
  inputs: {
    script: { label: "Script text", token: "{{script.text}}", required: true },
    source: { label: "Source URL", token: "{{project.url}}", required: false },
  },
  outputs: {
    dossier: { label: "Fair-use dossier", type: "text" },
  },
  defaults: {
    enabled: true,
    autoRun: false,
    inputs: { script: "{{script.text}}", source: "{{project.url}}" },
  },
  hasOutput: (p) => Boolean(p.fairuse),
};

export default meta;
