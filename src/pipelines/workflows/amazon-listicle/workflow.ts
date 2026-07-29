/**
 * Amazon Listicle workflow.
 *
 * Input: Amazon product URLs or ASINs → rapid listicle or deep-dive review.
 * Stages: products → script → voiceover → SEO → fair-use.
 */
import type { WorkflowDefinition } from "@/pipelines/_core/types";

const workflow: WorkflowDefinition = {
  id: "amazon-listicle",
  name: "Amazon — Rapid Listicle",
  mode: "amazon",
  isBuiltIn: true,
  description: "Product links → deep dive or rapid listicle script",
  stageOrder: ["products", "script", "voiceover", "seo", "fairuse"],
};

export default workflow;
