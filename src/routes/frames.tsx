import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useProject, CLEAR_DOWNSTREAM } from "@/lib/store";
import type { Product, ProductFrame } from "@/lib/types";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, ExternalLink, Image as ImageIcon } from "lucide-react";
import { alignProductFrames, recaptureAt } from "@/lib/product-frames";
import { StageHeader } from "@/components/stage/StageHeader";
import { StageFooter } from "@/components/stage/StageFooter";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import { useActivityLog } from "@/hooks/useActivityLog";

export const Route = createFileRoute("/frames")({
  component: FramesPage,
});

function fmtTime(s?: number) {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

// Renders any ProductFrame kind — real capture, thumbnail, or legacy storyboard sprite.
function FrameTile({ frame }: { frame: ProductFrame }) {
  if (frame.kind === "image" || frame.kind === "thumbnail") {
    return (
      <img
        src={frame.imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain"
      />
    );
  }
  // Legacy storyboard sprite (history entries created before this refactor).
  return (
    <svg
      viewBox={`${frame.tileX} ${frame.tileY} ${frame.tileW} ${frame.tileH}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      style={{ imageRendering: "auto" }}
    >
      <image href={frame.imageUrl} x={0} y={0} width={frame.spriteW} height={frame.spriteH} />
    </svg>
  );
}

const NUDGE_SEC = 1;

function FramesPage() {
  const [project, setProject] = useProject();
  const [refreshing, setRefreshing] = useState(false);
  const [nudgingIdx, setNudgingIdx] = useState<number | null>(null);
  const activity = useActivityLog();

  const products: Product[] = project.products ?? [];
  const hasVideo = !!project.videoId;
  const framedCount = products.filter((p) => p.frame).length;
  const realCount = products.filter((p) => p.frame?.kind === "image").length;

  async function nudge(index: number, deltaSec: number) {
    if (!project.videoId) return;
    const p = products[index];
    if (!p) return;
    const t = Math.max(0, (p.timestamp_seconds ?? 0) + deltaSec);
    setNudgingIdx(index);
    try {
      const frame = await recaptureAt(project.videoId, t);
      const next = products.map((prod, i) =>
        i === index ? { ...prod, timestamp_seconds: t, frame } : prod,
      );
      setProject({ products: next, ...CLEAR_DOWNSTREAM });
    } finally {
      setNudgingIdx(null);
    }
  }

  async function realign() {
    if (!project.videoId || !project.transcript || !products.length) return;
    setRefreshing(true);
    activity.start("re-aligning product frames…");
    try {
      const sourceUrl = project.meta?.url ?? `https://youtu.be/${project.videoId}`;
      const { products: aligned, captured, usedThumbnails } = await alignProductFrames({
        products,
        transcript: project.transcript,
        videoId: project.videoId,
        sourceUrl,
        log: (msg, level) => activity.log(msg, level ?? "info"),
      });
      setProject({ products: aligned, ...CLEAR_DOWNSTREAM });
      const summary =
        `re-aligned ${aligned.length} · ${captured} real frame${captured === 1 ? "" : "s"}` +
        (usedThumbnails ? ` · ${usedThumbnails} thumbnail${usedThumbnails === 1 ? "" : "s"}` : "");
      activity.stop(summary, "ok");
      toast.success(summary);
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  }

  if (!products.length) {
    return (
      <AppShell>
        <StageHeader
          current="frames"
          title="Product frames"
          purpose="Freeze-frames from the source video aligned to each identified product."
        />
        <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
          No products yet. Go back to the transcript step and click "find product frames".
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <StageHeader
        current="frames"
        title="Product frames"
        purpose="Real freeze-frames captured in-browser from the source video. Zero API cost. Falls back to the YouTube thumbnail if the video can't be downloaded."
      />
      <ActivityPanel activity={activity} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-xs text-muted-foreground">
          {products.length} product{products.length === 1 ? "" : "s"} · {realCount}/{framedCount} real frame{realCount === 1 ? "" : "s"}
        </div>
        <Button
          onClick={realign}
          disabled={refreshing || !hasVideo}
          variant="outline"
          size="sm"
          className="font-mono text-xs"
        >
          {refreshing ? "capturing…" : "↻ re-align frames"}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {products.map((p, i) => {
          const jumpUrl =
            hasVideo && p.timestamp_seconds != null
              ? `https://youtu.be/${project.videoId}?t=${Math.floor(p.timestamp_seconds)}`
              : null;
          const isThumb = p.frame?.kind === "thumbnail";
          return (
            <div key={i} className="rounded-md border border-border bg-card overflow-hidden">
              <div className="relative aspect-video w-full bg-muted">
                {p.frame ? (
                  <FrameTile frame={p.frame} />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2 font-mono text-[10px]">
                      <ImageIcon className="h-6 w-6 opacity-40" />
                      no frame aligned
                    </div>
                  </div>
                )}
                <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
                  {fmtTime(p.timestamp_seconds)}
                </span>
                {isThumb && (
                  <span className="absolute left-2 bottom-2 rounded bg-amber-500/90 px-1.5 py-0.5 font-mono text-[10px] text-black">
                    thumbnail
                  </span>
                )}
                {p.brand && (
                  <span className="absolute right-2 top-2 rounded bg-primary/90 px-1.5 py-0.5 font-mono text-[10px] text-primary-foreground">
                    {p.brand}
                  </span>
                )}
              </div>

              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold leading-tight">{p.name}</h3>
                  {p.estimated_price && (
                    <span className="shrink-0 font-mono text-[10px] text-primary">{p.estimated_price}</span>
                  )}
                </div>
                {p.category && (
                  <div className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">{p.category}</div>
                )}
                {p.description && (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
                )}
                {p.key_feature && (
                  <p className="mt-2 text-xs leading-relaxed">
                    <span className="font-mono text-[10px] uppercase text-primary">USP · </span>
                    {p.key_feature}
                  </p>
                )}
                {p.mentioned_context && (
                  <blockquote className="mt-2 border-l-2 border-primary/40 pl-2 text-[11px] italic text-muted-foreground">
                    "{p.mentioned_context}"
                  </blockquote>
                )}
                {jumpUrl && (
                  <a
                    href={jumpUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-3 inline-flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
                  >
                    jump to {fmtTime(p.timestamp_seconds)} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => nudge(i, -NUDGE_SEC)}
                    disabled={nudgingIdx === i}
                    className="h-7 px-2 font-mono text-[10px]"
                    title={`back ${NUDGE_SEC}s`}
                  >
                    <ChevronLeft className="h-3 w-3" /> prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => nudge(i, NUDGE_SEC)}
                    disabled={nudgingIdx === i}
                    className="h-7 px-2 font-mono text-[10px]"
                    title={`forward ${NUDGE_SEC}s`}
                  >
                    next <ChevronRight className="h-3 w-3" />
                  </Button>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {nudgingIdx === i ? "seeking…" : `±${NUDGE_SEC}s`}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <StageFooter current="frames" />
    </AppShell>
  );
}
