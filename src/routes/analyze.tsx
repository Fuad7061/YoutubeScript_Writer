import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { useConfig, useProject, getStageOverride, CLEAR_DOWNSTREAM, setGlobalProcessing, getGlobalSignal, type AnalysisSourceMeta } from "@/lib/store";
import { resolveMediaUrl } from "@/lib/media-resolve.functions";
import { fetchLinkMeta } from "@/lib/link-meta.functions";
import { analyzeFrameBatch, mergeAnalysis } from "@/lib/analyze.functions";
import { generateVideoDraftScript, deriveMirrorKnobs, type MirrorKnobs } from "@/lib/commentary-script.functions";
import { Textarea } from "@/components/ui/textarea";
import { StageHeader } from "@/components/stage/StageHeader";
import { StageFooter } from "@/components/stage/StageFooter";

import { extractFrames, type ExtractedFrame } from "@/lib/video-frames";
import { takePendingVideoFile } from "@/lib/pending-upload";

const searchSchema = z.object({ url: z.string().optional(), upload: z.string().optional() });

export const Route = createFileRoute("/analyze")({
  validateSearch: (s: Record<string, unknown>) => searchSchema.parse(s),
  component: AnalyzePage,
  head: () => ({
    meta: [
      { title: "Foundry — Video Analysis" },
      {
        name: "description",
        content:
          "Analyze any public video (YouTube, TikTok, Instagram, Facebook, X, Vimeo, Reddit) or upload a file. Generate an original commentary script without copyright issues.",
      },
    ],
  }),
});

type Phase =
  | "idle"
  | "resolving"
  | "downloading"
  | "extracting"
  | "transcribing"
  | "captioning"
  | "drafting"
  | "merging"
  | "done"
  | "error";

const BATCH_SIZE = 6;
const CONCURRENT_BATCHES = 6;
const FRAME_EXTRACT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_FRAMES = 12;

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function expectedFrameCount(duration: number, cap = 30) {
  if (!Number.isFinite(duration) || duration <= 0) return 8;
  let n: number;
  if (duration <= 20) n = Math.ceil(duration / 2);
  else if (duration <= 60) n = Math.ceil(8 + (duration - 20) / 6);
  else if (duration <= 180) n = Math.ceil(15 + (duration - 60) / 12);
  else n = Math.ceil(25 + (duration - 180) / 60);
  return Math.min(cap, Math.max(3, n));
}

function hasPoorFrameCoverage(frames: ExtractedFrame[], expectedDuration?: number) {
  const duration = typeof expectedDuration === "number" && Number.isFinite(expectedDuration) ? expectedDuration : 0;
  if (duration < 18 || frames.length === 0) return false;
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1]?.t ?? 0;
  const targetCount = expectedFrameCount(duration);
  return (last < duration * 0.72 && duration - last > 6) || frames.length < Math.max(5, Math.ceil(targetCount * 0.55));
}

function safeExtractFrames(
  source: File | Blob | string,
  options: Parameters<typeof extractFrames>[1],
) {
  return withTimeout(
    extractFrames(source, options).catch((e) => {
      console.warn("frame extraction failed", e);
      return null;
    }),
    FRAME_EXTRACT_TIMEOUT_MS,
    null,
  );
}






async function runInBatches<T, R>(items: T[], size: number, parallel: number, fn: (batch: T[], idx: number) => Promise<R>): Promise<R[]> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const out: R[] = new Array(batches.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const my = cursor++;
      if (my >= batches.length) return;
      out[my] = await fn(batches[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  return out;
}

function AnalyzePage() {
  const [project, setProject] = useProject();
  const [regenReport, setRegenReport] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);

  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [customAngleInput, setCustomAngleInput] = useState(project.customAngle ?? "");
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [correctionsDraft, setCorrectionsDraft] = useState(project.userCorrections ?? "");
  const [cfg] = useConfig();
  const navigate = useNavigate();
  const { url: urlFromSearch, upload: uploadFlag } = Route.useSearch();

  const [urlInput, setUrlInput] = useState(urlFromSearch ?? project.url ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ t: number; msg: string; kind: "info" | "warn" | "ok" }[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const startedRef = useRef(false);

  const source = project.analysisSource;
  const frames = project.analysisFrames;
  const analysis = project.analysis;

  const log = useCallback((msg: string, kind: "info" | "warn" | "ok" = "info") => {
    setLogs((prev) => [...prev.slice(-49), { t: Date.now(), msg, kind }]);
    if (kind === "warn") console.warn("[analyze]", msg);
    else console.log("[analyze]", msg);
  }, []);

  // Tick elapsed timer while busy
  useEffect(() => {
    if (phase === "idle" || phase === "done" || phase === "error") return;
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsed(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [phase]);

  const run = useCallback(
    async (mode: "url" | "file", input: string | File) => {
      setError(null);
      setPhase("resolving");
      setProgress(null);
      setLogs([]);
      startedAtRef.current = Date.now();
      setElapsed(0);
      log(`▸ starting ${mode === "url" ? "URL analysis" : "file analysis"}`, "info");
      setGlobalProcessing(true);

      try {
        let videoBlob: Blob | null = null;
        let meta: AnalysisSourceMeta = {};
        let sourceUrl: string | undefined;
        let resolverService: string | undefined;

        if (mode === "url") {
          const url = input as string;
          sourceUrl = url;
          meta.sourceUrl = url;
          log(`resolving media for ${new URL(url).hostname}…`);

          // Fire link-meta + resolver in parallel
          const [linkMeta, resolved] = await Promise.all([
            fetchLinkMeta({ data: { url } }).catch(() => null),
            resolveMediaUrl({ data: { url, quality: "240" } }),
          ]);

          meta = {
            ...meta,
            title: linkMeta?.title ?? resolved.meta?.title,
            author: linkMeta?.author ?? resolved.meta?.artist,
            platform: linkMeta?.platform ?? resolved.service,
            thumbnail: linkMeta?.thumbnail,
            duration: linkMeta?.duration ?? resolved.meta?.duration,
            filename: resolved.filename,
            service: resolved.service,
          };
          log(`resolved via ${resolved.service}${meta.duration ? ` · ${meta.duration.toFixed(1)}s` : ""}`, "ok");

          setPhase("downloading");
          setProgress({ label: "downloading video", done: 0, total: 1 });
          log("downloading video stream…");

          if (getGlobalSignal().aborted) throw new Error("Aborted by user");

          // Download video stream. If the first resolver fails at fetch time
          // (rate limit, upstream 5xx, CORS block, etc.) re-resolve with that
          // service excluded and try the next provider.
          let active = resolved;
          let vr = await fetch(active.videoUrl);
          if (!vr.ok) {
            const failedService = active.service;
            console.warn(`video download failed via ${failedService}: ${vr.status} — falling back`);
            toast.warning(`${failedService} unavailable (${vr.status}) — trying fallback`);
            try {
              const retry = await resolveMediaUrl({
                data: { url, quality: "240", exclude: [failedService] },
              });
              active = retry;
              meta.service = retry.service;
              meta.filename = retry.filename ?? meta.filename;
              vr = await fetch(active.videoUrl);
            } catch (e) {
              throw new Error(`video download failed: ${vr.status} (fallback also failed: ${(e as Error).message})`);
            }
            if (!vr.ok) throw new Error(`video download failed: ${vr.status} (fallback ${active.service} also failed)`);
          }
          videoBlob = await vr.blob();
          resolverService = active.service;
          log(`downloaded ${(videoBlob.size / 1024 / 1024).toFixed(1)} MB from ${active.service}`, "ok");

          setProgress({ label: "downloaded", done: 1, total: 1 });

        } else {
          const file = input as File;
          meta = { title: file.name, filename: file.name, platform: "upload" };
          videoBlob = file;
          log(`using uploaded file · ${(file.size / 1024 / 1024).toFixed(1)} MB`, "ok");
        }

        // Extract frames + audio in parallel
        setPhase("extracting");
        setProgress({ label: "extracting frames", done: 0, total: 1 });
        log("extracting frames from full timeline…");


        // Resolve the FPS setting & max frames limit (auto = user config or 12; explicit = 120)
        const fpsSetting = cfg.analyzeVisionFps ?? "auto";
        const extractFps: number | undefined =
          fpsSetting === "0.5fps" ? 0.5 :
          fpsSetting === "1fps"   ? 1   :
          fpsSetting === "2fps"   ? 2   :
          undefined; // "auto"
        const maxFramesLimit = fpsSetting === "auto" ? (cfg.analyzeMaxFrames ?? 12) : 120;

        const framesPromise = safeExtractFrames(videoBlob!, {
          maxFrames: maxFramesLimit,
          fps: extractFps,
          maxDim: 512,
          quality: 0.6,
          expectedDuration: meta.duration,
          onProgress: (d, t) => setProgress({ label: "extracting frames", done: d, total: t }),
          onLog: (msg) => log(msg, "ok"),
        });
        log(`frame rate: ${fpsSetting === "auto" ? `auto (max ${maxFramesLimit} frames)` : `${fpsSetting} (cap ${maxFramesLimit} frames)`}`);

        const extracted = await framesPromise;
        let framesOut = extracted?.frames ?? [];
        let duration = extracted?.duration ?? meta.duration ?? 0;
        let retriedResolver = false;

        if (!extracted && sourceUrl && resolverService) {
          retriedResolver = true;
          toast.warning(`${resolverService} frame extraction timed out — trying fallback resolver`);
          setProgress({ label: "retrying full-video extraction", done: 0, total: 1 });
          const fallback = await resolveMediaUrl({ data: { url: sourceUrl, quality: "240", exclude: [resolverService] } });
          const retryVideo = await fetch(fallback.videoUrl);
          if (!retryVideo.ok) throw new Error(`fallback video download failed: ${retryVideo.status}`);
          videoBlob = await retryVideo.blob();
          resolverService = fallback.service;
          meta.service = fallback.service;
          meta.filename = fallback.filename ?? meta.filename;
          meta.duration = meta.duration ?? fallback.meta?.duration;
          const retry = await safeExtractFrames(videoBlob, {
            maxFrames: maxFramesLimit,
            fps: extractFps,
            maxDim: 512,
            quality: 0.6,
            expectedDuration: meta.duration,
            onProgress: (d, t) => setProgress({ label: "extracting frames", done: d, total: t }),
            onLog: (msg) => log(msg, "ok"),
          });
          framesOut = retry?.frames ?? [];
          duration = retry?.duration ?? meta.duration ?? duration;
        }

        if (framesOut.length === 0) throw new Error("frame extraction timed out — upload the file directly if this URL keeps failing");
        log(`extracted ${framesOut.length} frames over ${duration.toFixed(1)}s`, "ok");

        // Some public resolvers return a playable MP4 whose metadata says the
        // full duration, but whose decoded/seekable stream ends early. If the
        // captured frames do not cover the timeline, switch resolver and retry
        // instead of analyzing a repeated/truncated first segment.
        if (!retriedResolver && sourceUrl && resolverService && hasPoorFrameCoverage(framesOut, meta.duration ?? duration)) {
          retriedResolver = true;
          toast.warning(`${resolverService} returned incomplete frames — trying fallback resolver`);
          setProgress({ label: "retrying full-video extraction", done: 0, total: 1 });
          const fallback = await resolveMediaUrl({ data: { url: sourceUrl, quality: "240", exclude: [resolverService] } });
          const retryVideo = await fetch(fallback.videoUrl);
          if (!retryVideo.ok) throw new Error(`fallback video download failed: ${retryVideo.status}`);
          videoBlob = await retryVideo.blob();
          resolverService = fallback.service;
          meta.service = fallback.service;
          meta.filename = fallback.filename ?? meta.filename;
          meta.duration = meta.duration ?? fallback.meta?.duration;
          const retry = await safeExtractFrames(videoBlob, {
            maxFrames: maxFramesLimit,
            fps: extractFps,
            maxDim: 512,
            quality: 0.6,
            expectedDuration: meta.duration,
            onProgress: (d, t) => setProgress({ label: "extracting frames", done: d, total: t }),
            onLog: (msg) => log(msg, "ok"),
          });
          if (retry?.frames.length) {
            framesOut = retry.frames;
            duration = retry.duration;
          } else {
            toast.warning("fallback resolver timed out — continuing with the frames already captured");
          }
        }
        meta.duration = duration;

        // Store frames + source meta so the UI can render the strip
        setProject({
          mode: "analysis",
          analysisSource: meta,
          analysisFrames: framesOut.map((f) => ({ t: f.t, dataUrl: f.dataUrl })),
          analysisCaptions: undefined,
          analysisBatchSummaries: undefined,
          ...CLEAR_DOWNSTREAM,
        });

        // Transcribe (best-effort, non-blocking to keep vision cost trending)
        if (getGlobalSignal().aborted) throw new Error("Aborted by user");
        setPhase("transcribing");
        let transcript = "";

        //    Works for any YouTube URL. For other platforms it returns empty gracefully.
        if (sourceUrl) {
          setProgress({ label: "fetching captions", done: 0, total: 1 });
          log(`fetching captions via transcript.py (youtube-transcript-api)…`);
          try {
            const { fetchTranscript } = await import("@/lib/youtube.functions");
            const yt = await fetchTranscript({ data: { url: sourceUrl } });
            transcript = yt.transcript.map((s: any) => s.text).join(" ").trim();
            if (yt.transcript.length === 0) {
              log("no captions found for this video (caption API returned empty)", "info");
            } else {
              log(`transcript · ${yt.transcript.length} segments · ${transcript.length} chars · source: ${yt.meta?.source ?? "captions"}`, "ok");
            }
          } catch (e) {
            const msg = (e as Error).message ?? "";
            log(`caption fetch skipped: ${msg.slice(0, 120)}`, "info");
          }
        }

        // 2) Whisper fallback: call server-side /api/transcribe (yt-dlp + faster-whisper).
        //    Requires a public URL — works for YouTube and most platforms.
        //    Only triggered when captions were not found and user opted in.
        if (!transcript) {
          if (!cfg.transcribeAudio) {
            log("audio transcription skipped (disabled in settings)", "info");
          } else if (!sourceUrl) {
            log("Whisper fallback unavailable for uploaded files without a URL — vision-only", "warn");
            toast.warning("Whisper requires a video URL. Continuing vision-only.");
          } else {
            setProgress({ label: "transcribing (server-side Whisper)", done: 0, total: 1 });
            log(`starting server-side Whisper (yt-dlp + faster-whisper) for ${new URL(sourceUrl).hostname}…`);
            toast.info("No captions found. Starting server-side Whisper — this may take 1–3 minutes.", { duration: 8000 });
            try {
              const resp = await fetch("/api/transcribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: sourceUrl }),
                signal: getGlobalSignal(),
              });
              const data = await resp.json();
              if (resp.ok && Array.isArray(data.segments) && data.segments.length > 0) {
                transcript = data.segments.map((s: any) => s.text).join(" ").trim();
                log(`Whisper done · ${data.segments.length} segments · ${data.meta?.language ?? ""} · ${data.meta?.source ?? "whisper"}`, "ok");
                toast.success("Server Whisper transcription complete");
              } else {
                throw new Error(data.error || "Whisper returned empty result");
              }
            } catch (e) {
              if ((e as Error).name === "AbortError") throw new Error("Aborted by user");
              console.warn("whisper fallback failed", e);
              toast.warning("Whisper fallback failed — continuing vision-only");
              log(`Whisper failed: ${(e as Error).message}`, "warn");
            }
          }
        }

        setProgress({ label: "transcribed", done: 1, total: 1 });

        // 1. Group raw frames into Image Payloads (Stitched Grid Tiles or Single Raw Frames)
        setPhase("captioning");
        const gridMode = cfg.analyzeGridStitch ?? "3x3";
        const rawFramesPerGrid = gridMode === "3x3" ? 9 : gridMode === "2x2" ? 4 : 1;

        type ImagePayload = {
          dataUrl: string;
          rawFrames: ExtractedFrame[];
        };

        const imagePayloads: ImagePayload[] = [];
        if (gridMode !== "off" && framesOut.length > 1) {
          const { stitchFramesIntoGrid } = await import("@/lib/frame-grid");
          for (let i = 0; i < framesOut.length; i += rawFramesPerGrid) {
            const rawChunk = framesOut.slice(i, i + rawFramesPerGrid);
            try {
              const stitched = await stitchFramesIntoGrid(
                rawChunk.map((f) => ({ t: f.t, dataUrl: f.dataUrl })),
                gridMode,
              );
              imagePayloads.push({
                dataUrl: stitched.gridDataUrl,
                rawFrames: rawChunk,
              });
            } catch (err) {
              console.warn("Grid stitching fallback to individual frames:", err);
              for (const rf of rawChunk) imagePayloads.push({ dataUrl: rf.dataUrl, rawFrames: [rf] });
            }
          }
        } else {
          for (const rf of framesOut) {
            imagePayloads.push({ dataUrl: rf.dataUrl, rawFrames: [rf] });
          }
        }

        // 2. Package Image Payloads into AI Requests based on cfg.analyzeBatchSize
        const maxPayloadsPerCall = Math.max(1, cfg.analyzeBatchSize ?? 6);
        const totalBatches = Math.ceil(imagePayloads.length / maxPayloadsPerCall);
        let batchesDone = 0;
        setProgress({ label: "captioning scenes", done: 0, total: totalBatches });
        log(`captioning ${framesOut.length} frames across ${imagePayloads.length} image payload(s) in ${totalBatches} AI request batch(es)…`);

        const overrideAnalyze = getStageOverride(cfg, "analyze-vision");
        const overrideMerge = getStageOverride(cfg, "analyze-report");
        const describe = (o: { useLovable?: boolean; host?: string; model?: string }) =>
          o.useLovable ? "lovable-gateway" : `${o.host || "?"} · ${o.model || "?"}`;
        log(`vision model → ${describe(overrideAnalyze)}`);
        log(`merge model  → ${describe(overrideMerge)}`);


        const batchResults = await runInBatches(
          imagePayloads,
          maxPayloadsPerCall,
          CONCURRENT_BATCHES,
          async (payloadBatch: ImagePayload[], idx: number) => {
            log(`batch ${idx + 1}/${totalBatches} starting…`);
            if (getGlobalSignal().aborted) throw new Error("Aborted by user");

            const batchRawFrames = payloadBatch.flatMap((p) => p.rawFrames);

            const r = await analyzeFrameBatch({
              data: {
                frames: batchRawFrames.map((f) => ({ t: f.t, dataUrl: f.dataUrl })),
                imagePayloads: payloadBatch.map((p) => ({ dataUrl: p.dataUrl })),
                meta: { title: meta.title, platform: meta.platform },
                promptTemplate: cfg.promptOverrides["analyze.frameCaption"],
                override: overrideAnalyze,
              },
            });

            batchesDone++;
            setProgress({ label: "captioning scenes", done: batchesDone, total: totalBatches });
            log(`batch ${idx + 1}/${totalBatches} captioned (${batchRawFrames.length} frames in ${payloadBatch.length} image payload(s))`, "ok");

            // Align returned frame captions with raw timestamps
            const captionsMap = new Map(r.frameCaptions.map((c) => [c.t.toFixed(1), c]));
            const mappedCaptions = batchRawFrames.map((bf) => {
              const match = captionsMap.get(bf.t.toFixed(1)) || r.frameCaptions.find((c) => Math.abs(c.t - bf.t) < 1.0);
              return {
                t: bf.t,
                visual: match?.visual ?? r.frameCaptions[0]?.visual ?? "(visual caption unavailable)",
                onScreenText: match?.onScreenText,
              };
            });

            return { frameCaptions: mappedCaptions, batchSummary: r.batchSummary };
          },
        );

        const allCaptions = batchResults.flatMap((b) => b.frameCaptions);
        const batchSummaries = batchResults.map((b) => b.batchSummary);

        // Attach captions back to stored frames for UI + cache captions/summaries
        // so the report can be regenerated later without repeating vision calls.
        setProject({
          analysisFrames: framesOut.map((f, i) => {
            const cap = allCaptions[i] ?? allCaptions.find((c) => Math.abs(c.t - f.t) < 0.5);
            return {
              t: f.t,
              dataUrl: f.dataUrl,
              visual: cap?.visual,
              onScreenText: cap?.onScreenText,
            };
          }),
          analysisCaptions: allCaptions,
          analysisBatchSummaries: batchSummaries,
        });

        // Draft (Gemini watches actual video) — only for URL sources.
        // Runs before merge so mergeAnalysis can use it as extra grounding.
        let videoDraft: string | undefined;
        if (sourceUrl) {
          setPhase("drafting");
          setProgress({ label: "drafting from video (Gemini watching)", done: 0, total: 1 });
          log("Gemini is watching the video and drafting a reference script…");
          if (getGlobalSignal().aborted) throw new Error("Aborted by user");
          try {
            const captionsDigest = allCaptions
              .map((c) => `[${c.t.toFixed(1)}s] ${c.visual ?? ""}${c.onScreenText ? ` | text: ${c.onScreenText}` : ""}`)
              .join("\n");
            const metaBlurb = [meta.title && `Title: ${meta.title}`, meta.author && `Author: ${meta.author}`, meta.platform && `Platform: ${meta.platform}`]
              .filter(Boolean)
              .join("\n");
            // Prefer the Gemini model the user picked for the "frames" stage,
            // so the Settings choice (e.g. gemini-2.5-flash) actually flows through.
            const draftModel =
              overrideAnalyze.model && /^gemini[-\w.]*$/i.test(overrideAnalyze.model)
                ? overrideAnalyze.model
                : undefined;
            log(`draft model  → gemini · ${draftModel ?? "gemini-flash-latest (default)"}`);
            const draftRes = await generateVideoDraftScript({
              data: {
                url: sourceUrl,
                apiKeys: cfg.voiceover.geminiApiKeys ?? [],
                model: draftModel,
                transcript,
                captions: captionsDigest,
                metaBlurb,
                promptTemplate: cfg.promptOverrides["analyze.videoDraft"],
                userCorrections: project.userCorrections,
              },
            });

            videoDraft = draftRes.draft;
            setProject({ videoDraft });
            log(`draft ready (${draftRes.model}, ${draftRes.draft.length} chars)`, "ok");
          } catch (e) {
            console.warn("video draft failed", e);
            toast.warning("video draft skipped — continuing without it");
            log(`draft skipped: ${(e as Error).message}`, "warn");
          }
        }

        setPhase("merging");
        setProgress({ label: "assembling report", done: 0, total: 1 });
        log("assembling final report (summary, scenes, angles)…");
        if (getGlobalSignal().aborted) throw new Error("Aborted by user");

        const merged = await mergeAnalysis({
          data: {
            meta,
            frameCaptions: allCaptions,
            batchSummaries,
            transcript,
            videoDraft,
            promptTemplate: cfg.promptOverrides["analyze.reportMerge"],
            mirrorPromptTemplate: cfg.promptOverrides["analyze.mirrorDerive"],
            userCorrections: project.userCorrections,
            override: overrideMerge,
          },
        });

        setProject({
          analysis: merged.report,
          analysisTranscript: transcript || undefined,
          mirrorKnobs: merged.mirrorKnobs,
        });
        setPhase("done");
        setProgress(null);
        log(`✓ analysis complete in ${((Date.now() - (startedAtRef.current ?? Date.now())) / 1000).toFixed(1)}s${merged.mirrorKnobs ? " · mirror knobs bundled" : ""}`, "ok");
      } catch (e: any) {
        if (e.message === "Aborted by user") {
          log("Analysis stopped.", "warn");
          setPhase("error");
          setError("Stopped by user");
        } else {
          setPhase("error");
          setError(e.message);
          log(`error: ${e.message}`, "warn");
        }
      } finally {
        setGlobalProcessing(false);
      }
    },
    [cfg, setProject, log],
  );

  const runReport = useCallback(async () => {
    setError(null);
    setProgress(null);
    setLogs([]);
    setGlobalProcessing(true);
    try {
      startedAtRef.current = Date.now();
      setElapsed(0);
      log(`↻ regenerating report from cached captions (no vision cost)…`, "info");
      
      const cachedCaptions = project.analysisCaptions ?? [];
      const cachedSummaries = project.analysisBatchSummaries ?? [];
      const overrideMerge = getStageOverride(cfg, "analyze-report");
      const meta = project.analysisSource ?? {};

      if (getGlobalSignal().aborted) throw new Error("Aborted by user");

      const merged = await mergeAnalysis({
        data: {
          meta,
          frameCaptions: cachedCaptions,
          batchSummaries: cachedSummaries,
          transcript: project.analysisTranscript ?? "",
          videoDraft: project.videoDraft,
          promptTemplate: cfg.promptOverrides["analyze.reportMerge"],
          mirrorPromptTemplate: cfg.promptOverrides["analyze.mirrorDerive"],
          userCorrections: project.userCorrections,
          override: overrideMerge,
        },
      });

      setProject({ analysis: merged.report, mirrorKnobs: merged.mirrorKnobs });
      autoMirrorRef.current = false;
      log(`✓ report regenerated${merged.mirrorKnobs ? " + mirror knobs" : ""}`, "ok");
      toast.success("report regenerated");
    } catch (e: any) {
      if (e.message === "Aborted by user") {
        log("Report regeneration stopped.", "warn");
      } else {
        log(`regen error: ${e.message}`, "warn");
        toast.error(`Regen failed: ${e.message}`);
      }
    } finally {
      setRegenReport(false);
      setGlobalProcessing(false);
    }
  }, [cfg, setProject, project.analysisCaptions, project.analysisBatchSummaries, project.analysisTranscript, project.videoDraft, project.analysisSource, project.userCorrections, log]);

  // Auto-run when navigated in with ?url= or ?upload=1
  useEffect(() => {
    if (startedRef.current) return;
    if (phase !== "idle" || analysis) return;
    if (uploadFlag) {
      const f = takePendingVideoFile();
      if (f) {
        startedRef.current = true;
        run("file", f);
        return;
      }
    }
    if (urlFromSearch) {
      startedRef.current = true;
      run("url", urlFromSearch);
    }
  }, [urlFromSearch, uploadFlag, analysis, phase, run]);

  // Auto-derive mirror knobs once analysis is ready (unless already derived or currently deriving)
  const autoMirrorRef = useRef(false);
  useEffect(() => {
    if (autoMirrorRef.current) return;
    if (phase !== "done" || !analysis) return;
    if (project.mirrorKnobs || mirrorBusy) return;
    autoMirrorRef.current = true;
    runDeriveMirror();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, analysis, project.mirrorKnobs]);

  function saveCustomAngle() {
    const v = customAngleInput.trim();
    setProject({
      customAngle: v || undefined,
      selectedAngle: v || undefined,
      angleSource: v ? "selected" : "mirror",
    });
    toast.success(v ? "custom angle set — overrides Mirror in commentary" : "custom angle cleared");
  }



  async function runDeriveMirror() {
    if (!analysis) return;
    setMirrorBusy(true);
    try {
      const override = getStageOverride(cfg, "analyze-report");
      const res = await deriveMirrorKnobs({
        data: {
          meta: {
            title: source?.title,
            author: source?.author,
            platform: source?.platform,
            duration: source?.duration,
            sourceUrl: source?.sourceUrl,
          },
          brief: "",
          analysis,
          transcript: project.analysisTranscript,
          videoDraft: project.videoDraft,
          promptTemplate: cfg.promptOverrides["analyze.mirrorDerive"],
          userCorrections: project.userCorrections,
          override,
        },
      });

      setProject({ mirrorKnobs: res, angleSource: "mirror" });
      toast.success("mirror knobs derived — set as commentary source");
    } catch (e) {
      toast.error((e as Error).message || "mirror derive failed");
    } finally {
      setMirrorBusy(false);
    }
  }

  async function regenerateReport() {
    const cachedCaptions = project.analysisCaptions ?? [];
    const cachedSummaries = project.analysisBatchSummaries ?? [];
    const hasTranscript = !!project.analysisTranscript?.trim();
    const hasDraft = !!project.videoDraft?.trim();
    if (!cachedCaptions.length && !hasTranscript && !hasDraft) {
      toast.error("No cached grounding — run a full analysis first.");
      return;
    }
    setRegenReport(true);
    try {
      const overrideMerge = getStageOverride(cfg, "analyze-report");
      const meta = project.analysisSource ?? {};
      log("↻ regenerating report + mirror knobs from cached captions (no vision cost)…", "info");
      const merged = await mergeAnalysis({
        data: {
          meta,
          frameCaptions: cachedCaptions,
          batchSummaries: cachedSummaries,
          transcript: project.analysisTranscript ?? "",
          videoDraft: project.videoDraft,
          promptTemplate: cfg.promptOverrides["analyze.reportMerge"],
          mirrorPromptTemplate: cfg.promptOverrides["analyze.mirrorDerive"],
          userCorrections: project.userCorrections,
          override: overrideMerge,
        },
      });
      setProject({ analysis: merged.report, mirrorKnobs: merged.mirrorKnobs });
      autoMirrorRef.current = false; // let auto-mirror fall back only if the bundle missed
      log(`✓ report regenerated${merged.mirrorKnobs ? " + mirror knobs" : ""}`, "ok");
      toast.success("report regenerated");
    } catch (e) {
      const msg = (e as Error).message || "regenerate failed";
      log(`✗ regenerate failed: ${msg}`, "warn");
      toast.error(msg);
    } finally {
      setRegenReport(false);
    }
  }

  function goToCommentary() {
    if (!analysis) {
      toast.error("Run the analysis first");
      return;
    }
    navigate({ to: "/commentary" });
  }

  const mirrorKnobs = project.mirrorKnobs as MirrorKnobs | undefined;
  

  const busy = phase !== "idle" && phase !== "done" && phase !== "error";

  return (
    <AppShell>
      <StageHeader
        current="analyze"
        title="Video analysis"
        purpose="Ingest a URL or file, transcribe, and build the source report every downstream stage depends on."
      />
      {/* Input row */}
      <div className="mb-6 rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="paste any video URL (YouTube, TikTok, IG, FB, X, Vimeo, Reddit...)"
            className="font-mono text-xs"
            disabled={busy}
          />
          <Button
            onClick={() => {
              if (!urlInput.trim()) return toast.error("paste a URL");
              startedRef.current = true;
              setProject({ url: urlInput, mode: "analysis", ...CLEAR_DOWNSTREAM, analysisSource: undefined, analysisFrames: undefined, analysis: undefined, analysisTranscript: undefined, videoDraft: undefined });
              run("url", urlInput);
            }}
            disabled={busy}
            className="font-mono"
          >
            {busy ? "working…" : "→ analyse url"}
          </Button>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-mono">— or —</span>
          <label className="font-mono cursor-pointer rounded border border-dashed border-border px-3 py-2 hover:border-primary hover:text-primary">
            <input
              type="file"
              accept="video/*"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 200 * 1024 * 1024) {
                  toast.error("file exceeds 200 MB cap");
                  return;
                }
                startedRef.current = true;
                setProject({ url: "", mode: "analysis", ...CLEAR_DOWNSTREAM, analysisSource: undefined, analysisFrames: undefined, analysis: undefined, analysisTranscript: undefined, videoDraft: undefined });
                run("file", f);
              }}
            />
            + upload video file (≤ 200 MB)
          </label>
          <span className="text-[10px]">
            frames decoded from the full video timeline · nothing persisted server-side
          </span>
        </div>
      </div>

      {/* Progress / error */}
      {(busy || logs.length > 0) && (
        <div className="mb-6 rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-primary">
              {busy && (
                <span
                  className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary"
                  aria-hidden
                />
              )}
              phase: {phase}
              {busy && <span className="ml-1 opacity-60">· working…</span>}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground tabular-nums">
              {(elapsed / 1000).toFixed(1)}s
            </div>
          </div>
          {progress && (
            <div className="mt-2 font-mono text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>{progress.label}</span>
                <span className="tabular-nums">{progress.done}/{progress.total}</span>
              </div>
              <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded bg-border">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }}
                />
                {busy && progress.total <= 1 && progress.done === 0 && (
                  <div className="absolute inset-0 animate-pulse bg-primary/30" />
                )}
              </div>
            </div>
          )}
          {logs.length > 0 && (
            <details className="mt-3 group" open>
              <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-primary">
                logs · {logs.length} {busy ? "· live" : ""}
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[10px] leading-relaxed">
                {logs.slice(-30).map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.kind === "warn"
                        ? "text-destructive"
                        : l.kind === "ok"
                        ? "text-primary"
                        : "text-muted-foreground"
                    }
                  >
                    <span className="opacity-50">
                      {new Date(l.t).toLocaleTimeString(undefined, { hour12: false })}
                    </span>{" "}
                    {l.msg}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {error && (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4 font-mono text-xs text-destructive">
          error: {error}
        </div>
      )}

      {/* Source card */}
      {source && (
        <div className="mb-6 rounded-lg border border-border bg-card p-4">
          <div className="flex gap-4">
            {source.thumbnail && (
              <img src={source.thumbnail} alt="" className="h-24 w-40 shrink-0 rounded border border-border object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{source.title ?? source.filename ?? "Untitled"}</div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                {source.platform ?? "—"} · {source.author ?? "—"} · {source.duration ? `${source.duration.toFixed(1)}s` : "—"}
                {source.service ? ` · resolver: ${source.service}` : ""}
              </div>
              {source.sourceUrl && (
                <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-[10px] text-primary hover:underline">
                  {source.sourceUrl}
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Frame strip */}
      {frames && frames.length > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-card p-4">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            frames · {frames.length}
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {frames.map((f, i) => (
              <div key={i} className="w-32 shrink-0">
                {f.dataUrl ? <img src={f.dataUrl} alt="" className="h-20 w-32 rounded border border-border object-cover" /> : null}
                <div className="mt-1 font-mono text-[9px] text-muted-foreground">{f.t.toFixed(1)}s</div>
                {f.visual && <div className="mt-0.5 line-clamp-3 text-[10px] leading-tight">{f.visual}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No-analysis fallback: any grounding cached but no merged report yet */}
      {!analysis && !busy &&
        ((project.analysisCaptions?.length ?? 0) > 0 ||
          !!project.videoDraft?.trim() ||
          !!project.analysisTranscript?.trim()) && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <div className="font-mono text-[11px] uppercase tracking-wider text-amber-500">
            report not built
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Grounding cached ({project.analysisCaptions?.length ?? 0} frames
            {project.videoDraft ? " · draft" : ""}
            {project.analysisTranscript ? " · transcript" : ""}
            ). Regenerate the report without re-paying for vision or transcription.
          </p>
          <Button
            size="sm"
            onClick={regenerateReport}
            disabled={regenReport}
            className="mt-3 font-mono"
          >
            {regenReport ? "regenerating…" : "↻ regenerate report from cache"}
          </Button>
        </div>
      )}

      {/* Analysis report */}
      {analysis && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-sm uppercase tracking-wider text-muted-foreground">Report</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={regenerateReport}
                disabled={regenReport}
                title="Rebuild the report using cached captions / draft / transcript — no vision or transcription cost"
                className="font-mono"
              >
                {regenReport ? "regenerating…" : "↻ regenerate report"}
              </Button>
              <Button onClick={() => goToCommentary()} className="font-mono">
                → open commentary editor
              </Button>
            </div>
          </div>


          <Tabs defaultValue="summary">
            <TabsList>
              <TabsTrigger value="summary" className="font-mono text-xs">Summary</TabsTrigger>
              <TabsTrigger value="scenes" className="font-mono text-xs">Scenes</TabsTrigger>
              <TabsTrigger value="frames" className="font-mono text-xs">Frames</TabsTrigger>
              <TabsTrigger value="draft" className="font-mono text-xs">
                Draft{project.videoDraft ? " ✓" : ""}
              </TabsTrigger>
              <TabsTrigger value="mirror" className="font-mono text-xs">
                Mirror &amp; Angle{mirrorKnobs || project.customAngle ? " ✓" : ""}
              </TabsTrigger>
              <TabsTrigger value="transcript" className="font-mono text-xs">Transcript</TabsTrigger>
              <TabsTrigger value="json" className="font-mono text-xs">JSON</TabsTrigger>
            </TabsList>

            <TabsContent value="summary">
              <div className="rounded-lg border border-border bg-card p-5 space-y-4 text-sm">
                {analysis.clipType && (
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
                      clip type · {analysis.clipType}
                    </span>
                  </div>
                )}

                {/* Summary — inline editable */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      summary {analysis.summary && summaryDraft && summaryDraft !== analysis.summary ? "· unsaved" : ""}
                    </div>
                    {!editingSummary ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 font-mono text-[10px] text-primary"
                        onClick={() => {
                          setSummaryDraft(analysis.summary ?? "");
                          setEditingSummary(true);
                        }}
                      >
                        ✎ edit
                      </Button>
                    ) : (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          className="h-6 px-2 font-mono text-[10px]"
                          onClick={() => {
                            setProject({ analysis: { ...analysis, summary: summaryDraft.trim() } });
                            setEditingSummary(false);
                            toast.success("summary saved — used by every downstream step");
                          }}
                        >
                          save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 font-mono text-[10px] text-muted-foreground"
                          onClick={() => setEditingSummary(false)}
                        >
                          cancel
                        </Button>
                      </div>
                    )}
                  </div>
                  {editingSummary ? (
                    <Textarea
                      value={summaryDraft}
                      onChange={(e) => setSummaryDraft(e.target.value)}
                      rows={6}
                      className="font-sans text-sm leading-relaxed"
                    />
                  ) : (
                    <p className="leading-relaxed">{analysis.summary}</p>
                  )}
                </div>

                {/* Corrections & facts — project-level, wired into every downstream prompt */}
                <div className="rounded border border-dashed border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-amber-500">
                      corrections &amp; facts {project.userCorrections ? "· active" : "· optional"}
                    </div>
                    {project.userCorrections && (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9px] text-amber-600">
                        overrides all sources
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Anything you write here is treated as verified fact and takes priority over the draft, frames, and transcript in every downstream prompt (report merge, mirror knobs, commentary script, video draft). Use it to correct actor identity, action order, or missed context.
                  </p>
                  <Textarea
                    value={correctionsDraft}
                    onChange={(e) => setCorrectionsDraft(e.target.value)}
                    rows={4}
                    placeholder="e.g. The man is stepping onto the large white ship, not the small black boat between the pier and the ship. The small black boat is just a stepping stone."
                    className="font-mono text-[11px] leading-relaxed"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {correctionsDraft.trim().length}/4000 chars
                    </div>
                    <div className="flex gap-2">
                      {project.userCorrections && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 font-mono text-[11px] text-muted-foreground"
                          onClick={() => {
                            setCorrectionsDraft("");
                            setProject({ userCorrections: undefined });
                            toast.success("corrections cleared");
                          }}
                        >
                          clear
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 font-mono text-[11px]"
                        disabled={correctionsDraft.trim() === (project.userCorrections ?? "")}
                        onClick={() => {
                          const v = correctionsDraft.trim();
                          setProject({ userCorrections: v || undefined });
                          toast.success(v ? "corrections saved — will be used on next regenerate" : "corrections cleared");
                        }}
                      >
                        save
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 font-mono text-[11px]"
                        disabled={regenReport || !correctionsDraft.trim()}
                        onClick={async () => {
                          const v = correctionsDraft.trim();
                          setProject({ userCorrections: v || undefined });
                          // Small tick so state is committed before regenerate reads it
                          await new Promise((r) => setTimeout(r, 30));
                          await regenerateReport();
                        }}
                        title="Save corrections and rebuild the report using them"
                      >
                        {regenReport ? "rebuilding…" : "save + rebuild report"}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  <div><span className="font-mono text-muted-foreground">tone:</span> {analysis.tone}</div>
                  <div><span className="font-mono text-muted-foreground">pacing:</span> {analysis.pacing}</div>
                  <div className="sm:col-span-2"><span className="font-mono text-muted-foreground">audience:</span> {analysis.targetAudience}</div>
                  <div className="sm:col-span-2"><span className="font-mono text-muted-foreground">topics:</span> {(analysis.topics ?? []).join(", ")}</div>
                  <div className="sm:col-span-2"><span className="font-mono text-muted-foreground">entities:</span> {(analysis.entities ?? []).join(", ") || "—"}</div>
                </div>
                {analysis.hookMoments?.length ? (
                  <div>
                    <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">hook moments</div>
                    <ul className="mt-1 space-y-1 text-xs">
                      {analysis.hookMoments.map((h, i) => (
                        <li key={i}>
                          <span className="font-mono text-primary">{h.t.toFixed(1)}s</span>
                          {h.role && (
                            <span className={`ml-1.5 rounded px-1 py-0.5 font-mono text-[9px] uppercase ${
                              h.role === "sympathetic" ? "bg-emerald-500/15 text-emerald-500"
                              : h.role === "villain" ? "bg-red-500/15 text-red-500"
                              : h.role === "hero" ? "bg-amber-500/15 text-amber-500"
                              : "bg-muted text-muted-foreground"
                            }`}>{h.role}</span>
                          )}
                          {" — "}{h.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </TabsContent>

            <TabsContent value="scenes">
              <div className="rounded-lg border border-border bg-card divide-y divide-border">
                {(analysis.scenes ?? []).map((s, i) => (
                  <div key={i} className="p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-mono text-[10px] text-primary">
                        {s.start.toFixed(1)}s – {s.end.toFixed(1)}s
                      </div>
                      {s.beatType && (() => {
                        const bt = s.beatType.toLowerCase();
                        const cls =
                          bt === "payoff" ? "bg-amber-500/15 text-amber-500"
                          : bt === "impact" || bt === "turn" ? "bg-rose-500/15 text-rose-500"
                          : bt === "response" ? "bg-sky-500/15 text-sky-500"
                          : bt === "setup" ? "bg-muted text-muted-foreground"
                          : bt === "resolution" ? "bg-emerald-500/15 text-emerald-500"
                          : bt === "cta" ? "bg-primary/15 text-primary"
                          : bt === "b-roll" ? "bg-muted text-muted-foreground/70"
                          : "bg-muted text-muted-foreground";
                        return (
                          <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${cls}`}>{s.beatType}</span>
                        );
                      })()}

                    </div>
                    <div className="mt-1"><span className="font-mono text-muted-foreground">visual:</span> {s.visual}</div>
                    {s.onScreenText && <div className="mt-1"><span className="font-mono text-muted-foreground">on-screen:</span> "{s.onScreenText}"</div>}
                    {s.spoken && <div className="mt-1"><span className="font-mono text-muted-foreground">spoken:</span> {s.spoken}</div>}
                    <div className="mt-1 text-primary/90"><span className="font-mono text-muted-foreground">takeaway:</span> {s.keyTakeaway}</div>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="frames">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  extracted visuals · {frames?.length ?? 0}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(frames ?? []).map((f, i) => (
                    <div key={i} className="rounded border border-border bg-background/40 p-2">
                      {f.dataUrl ? <img src={f.dataUrl} alt={`Extracted video frame at ${f.t.toFixed(1)} seconds`} className="aspect-video w-full rounded object-cover" /> : null}
                      <div className="mt-2 font-mono text-[10px] text-primary">{f.t.toFixed(1)}s</div>
                      {f.visual && <div className="mt-1 text-xs leading-snug">{f.visual}</div>}
                      {f.onScreenText && <div className="mt-1 text-[11px] text-muted-foreground">text: “{f.onScreenText}”</div>}
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="draft">
              <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      video draft · Gemini watched the actual video
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      This draft feeds every downstream stage (report grounding, angles, commentary script) as an inspirational reference.
                      Edit freely — changes persist for this session.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={draftBusy || !source?.sourceUrl}
                    onClick={async () => {
                      if (!source?.sourceUrl) return;
                      setDraftBusy(true);
                      try {
                        const captionsDigest = (project.analysisFrames ?? [])
                          .map((f) => `[${f.t.toFixed(1)}s] ${f.visual ?? ""}${f.onScreenText ? ` | text: ${f.onScreenText}` : ""}`)
                          .join("\n");
                        const metaBlurb = [
                          source?.title && `Title: ${source.title}`,
                          source?.author && `Author: ${source.author}`,
                          source?.platform && `Platform: ${source.platform}`,
                        ].filter(Boolean).join("\n");
                        const res = await generateVideoDraftScript({
                          data: {
                            url: source.sourceUrl,
                            apiKeys: cfg.voiceover.geminiApiKeys ?? [],
                            transcript: project.analysisTranscript ?? "",
                            captions: captionsDigest,
                            metaBlurb,
                            promptTemplate: cfg.promptOverrides["analyze.videoDraft"],
                            userCorrections: project.userCorrections,
                          },
                        });

                        setProject({ videoDraft: res.draft });
                        toast.success(`draft ready (${res.model})`);
                      } catch (e) {
                        toast.error((e as Error).message || "draft failed");
                      } finally {
                        setDraftBusy(false);
                      }
                    }}
                    className="h-8 gap-1.5 font-mono text-[11px]"
                  >
                    {draftBusy ? "watching video…" : project.videoDraft ? "↻ regenerate draft" : "✨ draft from video"}
                  </Button>
                </div>
                {project.videoDraft ? (
                  <Textarea
                    value={project.videoDraft}
                    onChange={(e) => setProject({ videoDraft: e.target.value })}
                    rows={20}
                    className="font-mono text-[11px] leading-relaxed"
                  />
                ) : (
                  <div className="rounded border border-dashed border-border p-6 text-center font-mono text-xs text-muted-foreground">
                    {source?.sourceUrl
                      ? "No draft yet — click regenerate to have Gemini watch the video."
                      : "Draft is only available for URL sources (Gemini needs a public video URL)."}
                  </div>
                )}
              </div>
            </TabsContent>


            <TabsContent value="mirror">
              <div className="rounded-lg border border-emerald-500/40 bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-mono text-sm font-semibold">🪞 Mirror knobs — derived from source</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Auto-derives angle, tone, hook, length, and visual format that clone the source's viral arc (in your own words, copyright-free). Uses the video draft + summary + scenes.
                    </p>
                  </div>
                  <Button
                    onClick={runDeriveMirror}
                    disabled={mirrorBusy}
                    variant="outline"
                    size="sm"
                    className="font-mono shrink-0"
                  >
                    {mirrorBusy ? "deriving…" : mirrorKnobs ? "↻ re-derive" : "✨ derive"}
                  </Button>
                </div>
                {mirrorKnobs ? (
                  <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2 text-xs">
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">angle (grounded)</span>
                        <div className="mt-0.5">{mirrorKnobs.angle}</div>
                      </div>
                      <div>
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">tone</span>
                        <div className="mt-0.5">{mirrorKnobs.tone}</div>
                      </div>
                      <div>
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">hook</span>
                        <div className="mt-0.5">{mirrorKnobs.hookArchetype}</div>
                      </div>
                      <div>
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">length</span>
                        <div className="mt-0.5">{mirrorKnobs.lengthTargetSec}s</div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">visual format</span>
                        <div className="mt-0.5">{mirrorKnobs.visualFormat}</div>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">mirror context brief</span>
                        <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] leading-snug">{mirrorKnobs.briefAddendum}</pre>
                      </div>
                    </div>
                    <div className="border-t border-emerald-500/20 pt-2">
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">why</span>
                      <div className="mt-0.5 italic text-muted-foreground">{mirrorKnobs.reasoning}</div>
                    </div>
                    {!project.videoDraft && (
                      <div className="border-t border-amber-500/30 pt-2 text-[10px] text-amber-500">
                        ⚠ No video draft attached — mirror is inferring the arc from summary+scenes only. Generate a draft in the Draft tab for best results.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
                    {mirrorBusy ? "Reading the draft + brief…" : "Click ✨ derive to compute mirror knobs from the source's actual arc."}
                  </div>
                )}

                {/* Custom angle override — takes precedence over Mirror in downstream commentary/script */}
                <div className="rounded border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-primary">
                      custom angle override {project.customAngle ? "· active" : "· optional"}
                    </div>
                    {project.customAngle && (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] text-primary">
                        overrides Mirror
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Leave blank to use the Mirror-derived angle above. Anything you write here becomes the commentary source used by the script generator.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={customAngleInput}
                      onChange={(e) => setCustomAngleInput(e.target.value)}
                      placeholder="e.g. Deadpan documentary-narrator retelling of the rescue"
                      className="font-mono text-xs"
                    />
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={saveCustomAngle}
                        className="font-mono text-[11px]"
                      >
                        {project.customAngle && customAngleInput.trim() === (project.customAngle ?? "")
                          ? "saved"
                          : "save"}
                      </Button>
                      {project.customAngle && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setCustomAngleInput("");
                            setProject({ customAngle: undefined, selectedAngle: undefined, angleSource: "mirror" });
                            toast.success("custom angle cleared — Mirror is source");
                          }}
                          className="font-mono text-[11px] text-muted-foreground"
                        >
                          clear
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <div className="font-mono text-[10px] text-muted-foreground">
                    active source: <span className="text-foreground">{project.customAngle ? "custom angle" : mirrorKnobs ? "mirror" : "—"}</span>
                  </div>
                  <Button onClick={goToCommentary} size="sm" className="font-mono" disabled={!mirrorKnobs && !project.customAngle}>
                    → open commentary editor
                  </Button>
                </div>
              </div>
            </TabsContent>


            <TabsContent value="transcript">
              <div className="rounded-lg border border-border bg-card p-4 text-sm">
                {project.analysisTranscript ? (
                  <pre className="whitespace-pre-wrap font-sans">{project.analysisTranscript}</pre>
                ) : (
                  <p className="text-muted-foreground">
                    No transcript (either the video had no dialog, or transcription failed).
                    The analysis was built from visuals only.
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="json">
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-card p-4 font-mono text-[11px]">
                {JSON.stringify({ source, analysis, transcript: project.analysisTranscript }, null, 2)}
              </pre>
            </TabsContent>
          </Tabs>
        </div>
      )}

      {!source && !busy && !error && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
          Paste a video URL or drop a file to begin. All processing is transient in your browser.
        </div>
      )}
      <StageFooter current="analyze" disabled={!project.analysis} />
    </AppShell>
  );
}

