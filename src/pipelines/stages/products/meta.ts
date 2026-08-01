import { Package } from "lucide-react";
import type { StageDefinition } from "@/pipelines/_core/types";
import { lazy } from "react";

const Config = lazy(() => import("./Config"));

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
  Config,
  defaults: {
    enabled: true,
    autoRun: true,
    inputs: { transcript: "{{transcript.text}}", asins: "{{project.amazonInputs}}" },
    overrides: {
      amazonApiMode: "creator",
      amazonRegion: "NA",
      amazonMarketplace: "www.amazon.com"
    }
  },
  hasOutput: (p) => Boolean(p.products?.length),
};

export default meta;

