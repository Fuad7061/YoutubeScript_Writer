import { FileText } from "lucide-react";
import type { StageDefinition } from "../_types";

const meta: StageDefinition = {
  id: "transcript",
  label: "Transcript",
  route: "/transcript",
  icon: FileText,
  description: "Pull YouTube captions or auto-transcribe.",
  order: 20,
  supportedModes: ["youtube"],
  inputs: {
    url: { label: "YouTube URL", token: "{{project.url}}", required: true },
  },
  outputs: {
    text: { label: "Full transcript text", type: "text" },
    segments: { label: "Timed segments", type: "json" },
  },
  defaults: {
    enabled: true,
    autoRun: true,
    inputs: { url: "{{project.url}}" },
  },
  hasOutput: (p) => Boolean(p.transcript?.length),
};

export default meta;
