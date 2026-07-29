/**
 * YouTube Product Review workflow.
 *
 * Input: YouTube URL → full product review pipeline.
 * Stages: transcript → frames → products → script → voiceover → SEO → fair-use.
 */
import type { WorkflowDefinition } from "@/pipelines/_core/types";

const workflow: WorkflowDefinition = {
  id: "youtube-product-review",
  name: "YouTube — Product Review",
  mode: "youtube",
  isBuiltIn: true,
  description: "Video → transcript → product detection → full review script",
  stageOrder: ["transcript", "frames", "products", "script", "voiceover", "seo", "fairuse"],
};

export default workflow;
