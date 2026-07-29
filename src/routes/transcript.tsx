import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useConfig, useProject, getStageOverride, CLEAR_DOWNSTREAM } from "@/lib/store";
import { useActiveProfile } from "@/lib/pipeline-profiles";
import { extractProducts } from "@/lib/products.functions";
import { resolvePromptTextById } from "@/lib/prompt-registry";
import { alignProductFrames } from "@/lib/product-frames";
import type { Product } from "@/lib/types";
import { toast } from "sonner";
import { Calendar, Clock, Eye, ThumbsUp, ExternalLink } from "lucide-react";
import { StageHeader } from "@/components/stage/StageHeader";
import { StageFooter } from "@/components/stage/StageFooter";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import { useActivityLog } from "@/hooks/useActivityLog";

export const Route = createFileRoute("/transcript")({
  component: TranscriptPage,
});

function formatDate(d?: string) {
  if (!d || d.length !== 8) return d ?? "—";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function formatNumber(n?: number) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function TranscriptPage() {
  const [project, setProject] = useProject();
  const [cfg] = useConfig();
  const navigate = useNavigate();
  const { setActiveByMode } = useActiveProfile();
  const [loading, setLoading] = useState(false);
  const activity = useActivityLog();

  const transcript = project.transcript ?? [];
  const meta = project.meta;
  const fullText = transcript.map((s) => s.text).join(" ");

  async function next() {
    if (!project.videoId || !transcript.length) return;
    setLoading(true);
    activity.start("extracting products from transcript…");
    try {
      // 1) Extract products from the transcript (no frames on first pass).
      const pr = await extractProducts({
        data: {
          transcript: fullText,
          title: project.meta?.title,
          promptTemplate: resolvePromptTextById(cfg, "products.extract"),
          override: getStageOverride(cfg, "products"),
        },
      });
      const products: Product[] = pr.products;
      if (!products.length) {
        activity.stop("no products detected in transcript", "warn");
        toast.error("No products detected in transcript");
        setLoading(false);
        return;
      }
      activity.log(`extracted ${products.length} product${products.length === 1 ? "" : "s"}`, "ok");

      // 2) Real video frame per product (built-in seek-canvas → ffmpeg → thumbnail).
      const sourceUrl = project.meta?.url ?? `https://youtu.be/${project.videoId}`;
      activity.log("aligning frames to product timestamps…");
      const { products: aligned, captured, usedThumbnails } = await alignProductFrames({
        products,
        transcript,
        videoId: project.videoId,
        sourceUrl,
        log: (msg, level) => activity.log(msg, level ?? "info"),
      });

      setProject({ products: aligned, amazon: {}, frames: [], ...CLEAR_DOWNSTREAM });
      const summary =
        `${aligned.length} product${aligned.length === 1 ? "" : "s"} · ${captured} real frame${captured === 1 ? "" : "s"}` +
        (usedThumbnails ? ` · ${usedThumbnails} thumbnail${usedThumbnails === 1 ? "" : "s"}` : "");
      activity.stop(summary, "ok");
      toast.success(summary);
      navigate({ to: "/frames" });
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  if (!transcript.length) {
    return (
      <AppShell>
        <StageHeader
          current="transcript"
          title="Transcript & video data"
          purpose="Fetched captions and video metadata — the raw material for downstream stages."
        />
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="font-mono text-sm text-muted-foreground">
            No captions found for this video.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/" })} className="font-mono">
              ← back to home
            </Button>
            <Button 
              size="sm" 
              onClick={() => {
                setProject({ mode: "analysis" });
                setActiveByMode("analysis");
                toast.info("Switched to Commentary profile");
                navigate({ to: "/analyze", search: { url: project.url || (project.videoId ? `https://youtu.be/${project.videoId}` : "") } });
              }} 
              className="font-mono"
            >
              run visual + audio analysis instead
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <StageHeader
        current="transcript"
        title="Transcript & video data"
        purpose="Fetched captions and video metadata — the raw material for downstream stages."
      />
      <ActivityPanel activity={activity} />
      {/* Video card */}
      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col gap-5 sm:flex-row">
          {meta?.thumbnail && (
            <img
              src={meta.thumbnail}
              alt=""
              className="h-40 w-56 shrink-0 rounded-md border border-border object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold">{meta?.title ?? "Untitled"}</h2>
            {meta?.author && (
              <div className="mt-1 text-sm text-primary">{meta.author}</div>
            )}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> {formatDate(meta?.uploadDate)}</span>
              <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> {meta?.duration ?? "—"}</span>
              <span className="inline-flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" /> {formatNumber(meta?.viewCount)}</span>
              <span className="inline-flex items-center gap-1.5"><ThumbsUp className="h-3.5 w-3.5" /> {formatNumber(meta?.likeCount)}</span>
            </div>
            {meta?.url && (
              <a
                href={meta.url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-primary hover:underline"
              >
                {meta.url} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:w-40">
            <Button onClick={next} disabled={loading} className="font-mono">
              {loading ? "working…" : "→ find product frames"}
            </Button>
            <button
              onClick={() => { navigator.clipboard.writeText(fullText); toast.success("copied"); }}
              className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground hover:text-primary"
            >[copy text]</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="raw">
        <div className="mb-3 flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="raw" className="font-mono text-xs">Raw Text</TabsTrigger>
            <TabsTrigger value="ts" className="font-mono text-xs">Timestamps</TabsTrigger>
            <TabsTrigger value="json" className="font-mono text-xs">JSON Payload</TabsTrigger>
          </TabsList>
          <span className="font-mono text-[10px] text-muted-foreground">
            {transcript.length} segments · {fullText.split(/\s+/).length} words
          </span>
        </div>

        <TabsContent value="raw">
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-card p-6 text-sm leading-relaxed">
            {fullText}
          </div>
        </TabsContent>

        <TabsContent value="ts">
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">
            {transcript.map((s, i) => (
              <div key={i} className="mb-2 flex gap-3">
                <span className="w-14 shrink-0 font-mono text-[10px] text-primary/70">{formatTime(s.start)}</span>
                <span>{s.text}</span>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="json">
          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-card p-4 font-mono text-[11px] leading-relaxed">
            {JSON.stringify({ videoId: project.videoId, meta, segments: transcript }, null, 2)}
          </pre>
        </TabsContent>
      </Tabs>
      <StageFooter current="transcript" disabled={loading} />
    </AppShell>
  );
}
