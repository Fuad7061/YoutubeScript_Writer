import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Youtube, ShoppingCart, Clapperboard } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { UrlPreview } from "@/components/UrlPreview";
import { useProject, useConfig } from "@/lib/store";
import { setPendingVideoFile } from "@/lib/pending-upload";
import { fetchTranscript } from "@/lib/youtube.functions";
import { fetchAmazonByAsins, parseAsin } from "@/lib/amazon-input.functions";
import { useActiveProfile, useProfiles } from "@/lib/pipeline-profiles";
import { useActivityLog } from "@/hooks/useActivityLog";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";


type Mode = "youtube" | "amazon" | "analysis";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Foundry — YouTube · Amazon · Video → Review pipeline" },
      { name: "description", content: "Start a project from a YouTube URL, Amazon links, or any video for commentary. Sidebar + command palette, modular pipeline profiles." },
      { property: "og:title", content: "Foundry — Review Pipeline" },
      { property: "og:description", content: "YouTube · Amazon · Video → full script, voiceover, SEO." },
    ],
  }),
  component: Index,
});

const MODES: {
  id: Mode;
  title: string;
  desc: string;
  icon: typeof Youtube;
}[] = [
  { id: "youtube", title: "YouTube Review", desc: "Video → product detection → full review", icon: Youtube },
  { id: "amazon", title: "Amazon Listicle", desc: "Product links → deep dive or rapid list", icon: ShoppingCart },
  { id: "analysis", title: "Any Video → Commentary", desc: "Analyse a clip → viral commentary script", icon: Clapperboard },
];

function Index() {
  const navigate = useNavigate();
  const [project, setProject, reset] = useProject();
  const [cfg, setCfg] = useConfig();
  const [mode, setMode] = useState<Mode>(project.mode ?? "youtube");
  const { profiles } = useProfiles();
  const { active, setActive, setActiveByMode } = useActiveProfile();
  const activity = useActivityLog();

  const [url, setUrl] = useState(project.url ?? "");
  const [loading, setLoading] = useState(false);


  const [amazonText, setAmazonText] = useState((project.amazonInputs ?? []).join("\n"));
  const [tag, setTag] = useState(project.affiliateTag ?? "consecho-20");
  const [amzLoading, setAmzLoading] = useState(false);

  const [analysisUrl, setAnalysisUrl] = useState("");

  const projectSig = `${project.mode ?? ""}|${project.url ?? ""}|${project.videoId ?? ""}|${(project.amazonInputs ?? []).join(",")}|${project.affiliateTag ?? ""}`;
  useEffect(() => {
    setMode(project.mode ?? "youtube");
    setUrl(project.url ?? "");
    setAmazonText((project.amazonInputs ?? []).join("\n"));
    setTag(project.affiliateTag ?? "consecho-20");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSig]);

  // Keyboard shortcuts 1/2/3
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "1") pickMode("youtube");
      if (e.key === "2") pickMode("amazon");
      if (e.key === "3") pickMode("analysis");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickMode(m: Mode) {
    setMode(m);
    setActiveByMode(m);
  }

  const lines = amazonText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const asinPreview = lines.map((l) => ({ line: l, asin: parseAsin(l) }));
  const validCount = asinPreview.filter((r) => r.asin).length;
  const invalidCount = asinPreview.length - validCount;

  const profilesForMode = profiles.filter((p) => p.mode === mode);

  async function runYouTube() {
    if (!url.trim()) return;
    setLoading(true);
    activity.start(`Fetching YouTube video · ${url}`);
    try {
      reset();
      setProject({ url, mode: "youtube" });
      activity.log("fetching captions via youtube-transcript-api…");
      const res = await fetchTranscript({ data: { url } });
      const title = res.meta?.title;
      activity.log(
        `video: ${title?.slice(0, 60) ?? res.videoId ?? "unknown"}`,
      );

      // Populate meta with duration/language if available from Tier 1
      const meta = {
        ...res.meta,
        videoId: res.videoId ?? res.meta?.videoId,
      };

      let finalTranscript = res.transcript;

      if (!finalTranscript.length && cfg.transcribeAudio) {
        activity.log("no captions — starting Whisper fallback (yt-dlp + faster-whisper)…");
        toast.info("No captions found. Starting Whisper transcription — this may take 1–3 minutes.", { duration: 8000 });

        try {
          const resp = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          const data = await resp.json();
          if (resp.ok && Array.isArray(data.segments) && data.segments.length > 0) {
            finalTranscript = data.segments;
            // Merge Whisper meta (it has language, duration etc.)
            if (data.meta) Object.assign(meta, data.meta);
            activity.log(`Whisper transcription ready · ${finalTranscript.length} segments · ${data.meta?.language ?? ""}`, "ok");
            toast.success("Whisper transcription complete");
          } else {
            throw new Error(data.error || "Whisper returned empty result");
          }
        } catch (e) {
          activity.log(`Whisper failed: ${(e as Error).message}`, "error");
          activity.log("no captions found — paste a manual transcript to continue", "warn");
          toast.warning("Whisper fallback failed. Please paste a manual transcript.");
        }
      } else if (!finalTranscript.length) {
        activity.log("no captions on this video — paste a manual transcript to continue", "warn");
        toast.warning("No captions on this video. Enable Whisper in settings or paste a manual transcript.");
      } else {
        const langInfo = res.meta?.language ? ` · ${res.meta.language}` : "";
        const durInfo = res.meta?.duration ? ` · ${res.meta.duration}` : "";
        activity.log(`transcript ready · ${finalTranscript.length} segments${langInfo}${durInfo}`, "ok");
      }

      setProject({ url, mode: "youtube", videoId: res.videoId ?? meta.videoId, transcript: finalTranscript, meta });
      if (finalTranscript.length) {
        activity.stop("transcript fetched → opening editor", "ok");
        toast.success("Transcript fetched");
      } else {
        activity.stop("transcript fetched → opening editor (empty)", "ok");
      }
      navigate({ to: "/transcript" });
    } catch (e) {
      activity.log((e as Error).message, "error");
      activity.stop("failed", "error");
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }


  async function runAmazon() {
    if (validCount === 0) return toast.error("Paste at least one Amazon URL or ASIN");
    setAmzLoading(true);
    activity.start(`Fetching ${validCount} Amazon product${validCount > 1 ? "s" : ""}…`);
    try {
      reset();
      setProject({ url: "", mode: "amazon", amazonInputs: lines, affiliateTag: tag });
      activity.log(`affiliate tag: ${tag}`);
      activity.log(`resolving ${validCount} ASIN${validCount > 1 ? "s" : ""}…`);
      
      const pOverrides = active.stages?.products?.overrides || {};
      const amzConfig = {
        mode: (pOverrides.amazonApiMode as string) || cfg.amazonApiMode || "creator",
        useLambdaFallback: pOverrides.amazonUseLambdaFallback !== undefined 
          ? Boolean(pOverrides.amazonUseLambdaFallback) 
          : cfg.amazonUseLambdaFallback || false,
        clientId: (pOverrides.amazonClientId as string) || cfg.amazonClientId || "",
        clientSecret: (pOverrides.amazonClientSecret as string) || cfg.amazonClientSecret || "",
        partnerTag: (pOverrides.amazonPartnerTag as string) || cfg.amazonPartnerTag || "",
        region: (pOverrides.amazonRegion as string) || cfg.amazonRegion || "NA",
        marketplace: (pOverrides.amazonMarketplace as string) || cfg.amazonMarketplace || "www.amazon.com",
      } as any;

      const res = await fetchAmazonByAsins({ 
        data: { 
          urls: lines, 
          tag,
          config: amzConfig
        } 
      });
      const format = res.products.length === 1 ? "deep-dive" : "listicle";
      activity.log(`loaded ${res.products.length} · failed ${res.failed.length}`, res.failed.length ? "warn" : "ok");
      setProject({
        url: "",
        mode: "amazon",
        amazonInputs: lines,
        affiliateTag: tag,
        products: res.products,
        amazon: res.amazon,
        meta: {
          videoId: "amazon",
          title:
            res.products.length === 1
              ? `Deep dive — ${res.products[0].name.slice(0, 60)}`
              : `${res.products.length} products review`,
        },
      });
      if (res.failed.length) {
        activity.stop(`done with ${res.failed.length} failure(s)`, "warn");
        toast.warning(`${res.products.length} loaded · ${res.failed.length} failed (${res.failed.join(", ")})`);
      } else {
        activity.stop(`ready → ${format}`, "ok");
        toast.success(`${res.products.length} products loaded · ${format === "deep-dive" ? "Deep Dive" : "Rapid Listicle"}`);
      }
      navigate({ to: "/products" });
    } catch (e) {
      activity.log((e as Error).message, "error");
      activity.stop("failed", "error");
      toast.error((e as Error).message);
    } finally {
      setAmzLoading(false);
    }
  }

  function runAnalysis() {
    if (!analysisUrl.trim()) return toast.error("paste a video URL");
    reset();
    setProject({ url: analysisUrl, mode: "analysis" });
    navigate({ to: "/analyze", search: { url: analysisUrl } });
  }

  function runAnalysisFile(f: File) {
    if (f.size > 200 * 1024 * 1024) return toast.error("file exceeds 200 MB cap");
    reset();
    setProject({ url: "", mode: "analysis" });
    setPendingVideoFile(f);
    navigate({ to: "/analyze", search: { upload: "1" } });
  }


  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Start a project</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick an input, adjust the profile if needed, and Foundry runs the rest of the pipeline.
          </p>
        </div>
        {/* Mode picker */}
        
        {/* Helper UI variables */}
        {(() => {
          const WhisperToggle = (
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel/40 p-3 hover:border-primary/40 mt-4">
              <input
                type="checkbox"
                checked={cfg.transcribeAudio}
                onChange={(e) => setCfg({ transcribeAudio: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Transcribe audio (Server-side Whisper)</div>
                <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  off = skip when no captions · best for Shorts / music videos ·
                  on = fall back to fast server-side Whisper (yt-dlp + faster-whisper).
                  YouTube captions always run first when available.
                </div>
              </div>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]", cfg.transcribeAudio ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")}>
                {cfg.transcribeAudio ? "ON" : "OFF"}
              </span>
            </label>
          );
          
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
          {MODES.map((m, i) => {
            const Icon = m.icon;
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => pickMode(m.id)}
                className={cn(
                  "group flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition",
                  active
                    ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--primary)]"
                    : "border-border bg-card hover:border-primary/50 hover:bg-panel",
                )}
              >
                <div className="flex w-full items-start justify-between">
                  <Icon className={cn("h-5 w-5", active ? "text-primary" : "text-muted-foreground")} />
                  <kbd className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                    {i + 1}
                  </kbd>
                </div>
                <div>
                  <div className="text-sm font-semibold">{m.title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{m.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
            </>
          );
        })()}

        {/* Profile row */}
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 text-xs">
          <span className="text-muted-foreground">Pipeline profile</span>
          <Select value={active.id} onValueChange={setActive}>
            <SelectTrigger className="h-7 w-auto min-w-[220px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {profilesForMode.length > 0 && (
                <>
                  {profilesForMode.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-xs">
                      {p.name}
                    </SelectItem>
                  ))}
                </>
              )}
              {profiles
                .filter((p) => p.mode !== mode)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}{" "}
                    <span className="text-muted-foreground">({p.mode})</span>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <button
            onClick={() => navigate({ to: "/settings" })}
            className="text-muted-foreground hover:text-primary"
          >
            edit profiles →
          </button>
        </div>

        {/* Input panel */}
        {mode === "youtube" && (
          <div className="rounded-lg border border-border bg-card p-6">
            <Label className="mb-2 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              youtube.url
            </Label>
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="font-mono"
                onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && runYouTube()}
              />
              <Button onClick={runYouTube} disabled={loading} className="font-mono">
                {loading ? "fetching…" : "→ start"}
              </Button>
            </div>
            <UrlPreview url={url} />
            
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel/40 p-3 hover:border-primary/40 mt-4">
              <input
                type="checkbox"
                checked={cfg.transcribeAudio}
                onChange={(e) => setCfg({ transcribeAudio: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Transcribe audio (Server-side Whisper)</div>
                <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  off = skip when no captions · best for Shorts / music videos ·
                  on = fall back to fast server-side Whisper (yt-dlp + faster-whisper).
                  YouTube captions always run first when available.
                </div>
              </div>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]", cfg.transcribeAudio ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")}>
                {cfg.transcribeAudio ? "ON" : "OFF"}
              </span>
            </label>
            
          </div>
        )}

        {mode === "amazon" && (
          <div className="space-y-4 rounded-lg border border-border bg-card p-6">
            <div>
              <Label className="mb-2 block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                amazon.links (one URL or ASIN per line)
              </Label>
              <Textarea
                value={amazonText}
                onChange={(e) => setAmazonText(e.target.value)}
                placeholder={"https://www.amazon.com/dp/B0113UZJE2\nB08N5WRWNW"}
                rows={6}
                className="font-mono text-xs"
              />
              <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span>
                  {validCount} valid ·{" "}
                  {invalidCount ? (
                    <span className="text-destructive">{invalidCount} unrecognized</span>
                  ) : (
                    "0 unrecognized"
                  )}
                </span>
                <span>
                  {validCount === 1 && "→ Deep Dive"}
                  {validCount > 1 && `→ Rapid Listicle (${validCount})`}
                </span>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <div>
                <Label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  affiliate tag
                </Label>
                <Input
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  className="mt-1 font-mono"
                  placeholder="consecho-20"
                />
              </div>
              <div className="flex items-end">
                <Button
                  onClick={runAmazon}
                  disabled={amzLoading || validCount === 0}
                  className="w-full font-mono sm:w-auto"
                >
                  {amzLoading ? "fetching…" : "→ start"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {mode === "analysis" && (
          <div className="space-y-3 rounded-lg border border-border bg-card p-6">
            <Label className="block font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              video.url — YouTube · TikTok · Instagram · X · Vimeo · Reddit
            </Label>
            <div className="flex gap-2">
              <Input
                value={analysisUrl}
                onChange={(e) => setAnalysisUrl(e.target.value)}
                placeholder="https://…"
                className="font-mono"
                onKeyDown={(e) => e.key === "Enter" && runAnalysis()}
              />
              <Button onClick={runAnalysis} className="font-mono">
                → analyse
              </Button>
            </div>
            <UrlPreview url={analysisUrl} />

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel/40 p-3 hover:border-primary/40">
              <input
                type="checkbox"
                checked={cfg.transcribeAudio}
                onChange={(e) => setCfg({ transcribeAudio: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Transcribe audio (Server-side Whisper)</div>
                <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  off = skip when no captions · best for Shorts / music videos ·
                  on = fall back to fast server-side Whisper (yt-dlp + faster-whisper).
                  YouTube captions always run first when available.
                </div>
              </div>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]", cfg.transcribeAudio ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")}>
                {cfg.transcribeAudio ? "ON" : "OFF"}
              </span>
            </label>

            <div className="flex items-center gap-3 pt-1">
              <span className="h-px flex-1 bg-border" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <label
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("border-primary", "bg-primary/5"); }}
              onDragLeave={(e) => e.currentTarget.classList.remove("border-primary", "bg-primary/5")}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove("border-primary", "bg-primary/5");
                const f = e.dataTransfer.files?.[0];
                if (f) runAnalysisFile(f);
              }}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-panel/50 px-4 py-6 text-center transition hover:border-primary/50 hover:bg-panel"
            >
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) runAnalysisFile(f);
                  e.target.value = "";
                }}
              />
              <div className="text-sm font-medium">Drop a video file, or click to browse</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                mp4 · mov · webm · mkv — up to 200 MB · works when the URL is private / DRM'd
              </div>
            </label>
          </div>
        )}

        {(activity.running || activity.logs.length > 0) && (
          <ActivityPanel activity={activity} />
        )}
      </div>

    </AppShell>
  );
}
