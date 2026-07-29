import { Search } from "lucide-react";
import type { StageDefinition } from "../_types";

const meta: StageDefinition = {
  id: "seo",
  label: "SEO",
  route: "/seo",
  icon: Search,
  description: "Title, description, tags, chapters.",
  order: 80,
  supportedModes: ["youtube", "amazon", "analysis"],
  inputs: {
    script: { label: "Script text", token: "{{script.text}}", required: true },
    products: { label: "Product list", token: "{{products.list}}", required: false },
  },
  outputs: {
    seo: { label: "SEO pack", type: "json" },
  },
  defaults: {
    enabled: true,
    autoRun: false,
    inputs: { script: "{{script.text}}", products: "{{products.list}}" },
  },
  hasOutput: (p) => Boolean(p.seo),
};

export default meta;
