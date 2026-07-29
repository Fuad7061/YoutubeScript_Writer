/**
 * Any Video → Commentary workflow.
 *
 * Input: Any video URL (YouTube, TikTok, Instagram, X, Vimeo, Reddit)
 *        or uploaded video file.
 * Stages: analyze (vision + audio) → commentary script → voiceover → SEO → fair-use.
 */
import type { WorkflowDefinition } from "@/pipelines/_core/types";

const workflow: WorkflowDefinition = {
  id: "any-video-commentary",
  name: "Any Video — Commentary",
  mode: "analysis",
  isBuiltIn: true,
  description: "Analyse a clip → viral commentary script",
  stageOrder: ["analyze", "commentary", "voiceover", "seo", "fairuse"],
};

export default workflow;
