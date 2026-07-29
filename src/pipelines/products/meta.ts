import { Package } from "lucide-react";
import type { StageDefinition } from "../_types";

const meta: StageDefinition = {
  id: "products",
  label: "Products",
  route: "/products",
  icon: Package,
  description: "Detect products from transcript / fetch by ASIN.",
  order: 40,
  supportedModes: ["youtube", "amazon"],
  inputs: {
    transcript: { label: "Transcript", token: "{{transcript.text}}", required: false },
    asins: { label: "Amazon links", token: "{{project.amazonInputs}}", required: false },
  },
  outputs: {
    list: { label: "Product list", type: "json" },
  },
  defaults: {
    enabled: true,
    autoRun: true,
    inputs: { transcript: "{{transcript.text}}", asins: "{{project.amazonInputs}}" },
  },
  hasOutput: (p) => Boolean(p.products?.length),
};

export default meta;
