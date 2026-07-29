import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { StageHeader } from "@/components/stage/StageHeader";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import { useActivityLog } from "@/hooks/useActivityLog";
import { StageFooter } from "@/components/stage/StageFooter";
import { ScriptResult } from "@/components/ScriptResult";
import { useConfig, useProject, getStageOverride } from "@/lib/store";
import { resolveModelChoice } from "@/lib/ai-provider";
import {
  generateCommentaryScript,
  type MirrorKnobs,
} from "@/lib/commentary-script.functions";

import { resolveActivePromptText } from "@/lib/prompt-registry";

const searchSchema = z.object({ angle: z.string().optional() });

export const Route = createFileRoute("/commentary")({
  validateSearch: (s: Record<string, unknown>) => searchSchema.parse(s),
  component: CommentaryPage,
  head: () => ({
    meta: [
      { title: "Foundry — Commentary Script" },
      {
        name: "description",
        content:
          "Turn a video analysis report into an original commentary/reaction script — the angle & tone are picked on the Analyze stage; here you set visual format, hook, length, and generate.",
      },
    ],
  }),
});

// Universal starter chips — click-to-fill hints for the free-form hook input.
// The Mirror deriver can coin any topic-specific label; these are just presets.
const HOOK_SUGGESTIONS = [
  "Payoff First",
  "Curiosity Gap",
  "OMG Reveal",
  "Instant Karma",
  "Unlikely Hero",
  "Hater Hook",
  "Contrarian Take",
  "Missing Context",
  "Deadpan Reaction",
  "Direct Callout",
  "Absurd Analogy",
  "Recipe Reveal",
  "Buyer Warning",
] as const;

const VISUAL_FORMATS = [
  { value: "Voice-over only (no creator on camera)", label: "Voice-over only (no creator on camera)" },
  { value: "Green screen (creator keyed over the clip)", label: "Green screen (creator over the clip)" },
  { value: "Picture-in-Picture reaction (creator in a corner bubble)", label: "Picture-in-Picture (corner bubble)" },
  { value: "Split-screen / Duet (creator side-by-side with the clip)", label: "Split-screen / Duet" },
  { value: "Talking-head cutaways (creator cuts in between clip beats)", label: "Talking-head cutaways" },
  { value: "__custom__", label: "Custom…" },
] as const;

const LENGTHS = [
  { value: 25, label: "Snap (20–30s)" },
  { value: 35, label: "Standard (30–45s)" },
  { value: 50, label: "Long (45–60s)" },
  { value: -1, label: "Custom…" },
] as const;

export function autoLengthFromSource(durationSec?: number): number {
  if (!durationSec || !isFinite(durationSec) || durationSec <= 0) return 35;
  // 1:1 mapping so short sources stay short. Cap at 180s for very long clips.
  return Math.max(5, Math.min(180, Math.round(durationSec)));
}


function assembleBrief(project: ReturnType<typeof useProject>[0]): string {
  const a = project.analysis;
  const m = project.analysisSource ?? {};
  if (!a) return "";

  const lines: string[] = [];
  lines.push("=== SOURCE ===");
  lines.push(`Title:    ${m.title ?? "(none)"}`);
  lines.push(`Author:   ${m.author ?? "(unknown)"}`);
  lines.push(`Platform: ${m.platform ?? "(unknown)"}`);
  if (m.duration) lines.push(`Duration: ${m.duration.toFixed(1)}s`);
  if (m.sourceUrl) lines.push(`URL:      ${m.sourceUrl}`);

  lines.push("", "=== SUMMARY ===", a.summary);

  if (a.tone || a.pacing || a.targetAudience) {
    lines.push("", "=== FEEL ===");
    if (a.tone) lines.push(`Tone:     ${a.tone}`);
    if (a.pacing) lines.push(`Pacing:   ${a.pacing}`);
    if (a.targetAudience) lines.push(`Audience: ${a.targetAudience}`);
  }

  if (a.topics?.length) lines.push("", "=== TOPICS ===", a.topics.join(", "));
  if (a.entities?.length) lines.push("", "=== ENTITIES ===", a.entities.join(", "));

  if (a.hookMoments?.length) {
    lines.push("", "=== HOOK MOMENTS ===");
    for (const h of a.hookMoments) lines.push(`[${h.t.toFixed(1)}s] ${h.description}`);
  }

  if (a.scenes?.length) {
    lines.push("", "=== SCENES ===");
    for (const [i, s] of a.scenes.entries()) {
      lines.push(
        `#${i + 1} [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] visual: ${s.visual}` +
          (s.onScreenText ? ` | on-screen: "${s.onScreenText}"` : "") +
          (s.spoken ? ` | spoken: ${s.spoken}` : "") +
          ` | takeaway: ${s.keyTakeaway}`,
      );
    }
  }

  const t = project.analysisTranscript;
  if (t && t.trim()) {
    lines.push("", "=== TRANSCRIPT (excerpt) ===", t.slice(0, 1800));
  }

  const draft = project.videoDraft?.trim();
  if (draft) {
    lines.push(
      "",
      "=== DRAFT SCRIPT (Gemini watched the actual video — inspirational reference, not final. Obey ANGLE/TONE/HOOK knobs; trust the brief on contradictions.) ===",
      draft.slice(0, 6000),
    );
  }
  return lines.join("\n");
}

function CommentaryPage() {
  const [project, setProject] = useProject();
  const [cfg] = useConfig();
  const navigate = useNavigate();
  const { angle: angleFromSearch } = Route.useSearch();

  const analysis = project.analysis;
  const source = project.analysisSource;
  const mirrorKnobs = project.mirrorKnobs as MirrorKnobs | undefined;

  // Backward compat: if navigated with ?angle=..., write to project once.
  useEffect(() => {
    if (angleFromSearch && angleFromSearch !== project.selectedAngle) {
      setProject({ selectedAngle: angleFromSearch, angleSource: "selected" });
    }
  }, [angleFromSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolved source: mirror knobs win when angleSource === "mirror" and they exist.
  const activeSource: "mirror" | "selected" | undefined =
    project.angleSource ?? (mirrorKnobs ? "mirror" : project.selectedAngle ? "selected" : undefined);
  const useMirror = activeSource === "mirror" && !!mirrorKnobs;

  const derivedAngle = useMirror ? mirrorKnobs!.angle : project.selectedAngle ?? "";
  const resolvedTone = useMirror ? mirrorKnobs!.tone : project.selectedTone ?? "";

  // Custom angle override — replaces the derived {{ANGLE}} in the final prompt when non-empty.
  const [customAngle, setCustomAngle] = useState<string>(project.customAngle ?? "");
  const [customBriefAddendum, setCustomBriefAddendum] = useState<string>(project.customBriefAddendum ?? "");
  useEffect(() => {
    setCustomAngle(project.customAngle ?? "");
    setCustomBriefAddendum(project.customBriefAddendum ?? "");
  }, [project.customAngle, project.customBriefAddendum]);

  const effectiveAngle = customAngle.trim() || derivedAngle;

  // Manual per-run knobs (visual, hook, length)
  const [hook, setHook] = useState<string>(useMirror ? mirrorKnobs!.hookArchetype : "auto");
  
  const [visualFormat, setVisualFormat] = useState<string>(
    useMirror ? mirrorKnobs!.visualFormat : VISUAL_FORMATS[0].value,
  );
  const [customVisualFormat, setCustomVisualFormat] = useState<string>("");
  const autoLength = useMemo(() => autoLengthFromSource(source?.duration), [source?.duration]);
  const [lengthTarget, setLengthTarget] = useState<number>(useMirror ? mirrorKnobs!.lengthTargetSec : autoLength);
  const [lengthAuto, setLengthAuto] = useState<boolean>(!useMirror);
  const [lengthCustom, setLengthCustom] = useState<boolean>(false);
  useEffect(() => {
    if (lengthAuto && !useMirror) setLengthTarget(autoLength);
  }, [autoLength, lengthAuto, useMirror]);

  // Brief (editable)
  const autoBrief = useMemo(() => assembleBrief(project), [project]);
  const [brief, setBrief] = useState<string>(autoBrief);
  const briefTouched = useRef(false);
  useEffect(() => {
    if (!briefTouched.current) setBrief(autoBrief);
  }, [autoBrief]);

  const [showBrief, setShowBrief] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [tab, setTab] = useState<"knobs" | "script">("knobs");
  const activity = useActivityLog();




  async function generate() {
    if (!analysis) {
      toast.error("Run the analysis first on /analyze");
      return;
    }
    if (!effectiveAngle.trim()) {
      toast.error("Pick an angle (or derive mirror knobs) on the Analyze stage, or write a custom angle below");
      return;
    }

    const effectiveTone = resolvedTone || "Deadpan roast — dry, observational, laughs without smiling";
    const trimmedHook = (hook || "").trim();
    const effectiveHook = useMirror
      ? mirrorKnobs!.hookArchetype
      : (!trimmedHook || trimmedHook.toLowerCase() === "auto" ? "auto" : trimmedHook);
    const effectiveCustomHook = undefined;
    const effectiveLength = useMirror ? mirrorKnobs!.lengthTargetSec : lengthTarget;
    const effectiveMirrorContext = useMirror
      ? [mirrorKnobs!.briefAddendum, customBriefAddendum.trim()].filter(Boolean).join("\n\n")
      : (customBriefAddendum.trim() || undefined);
    const effectiveVisualFormat = useMirror
      ? mirrorKnobs!.visualFormat
      : visualFormat === "__custom__"
        ? customVisualFormat.trim() || undefined
        : visualFormat;

    setGenerating(true);
    activity.start("generating commentary script…");
    activity.log(`angle · ${effectiveAngle.slice(0, 80)}`);
    activity.log(`hook · ${effectiveHook} · target ${effectiveLength}s${useMirror ? " · mirror mode" : ""}`);
    try {
      const override = resolveModelChoice(
        project.scriptModelChoice,
        cfg.customModels,
        getStageOverride(cfg, "script"),
        { host: cfg.defaultHost, apiKey: cfg.defaultApiKey, model: cfg.defaultModel },
      );
      activity.log("calling model…");
      const res = await generateCommentaryScript({
        data: {
          meta: {
            title: source?.title,
            author: source?.author,
            platform: source?.platform,
            duration: source?.duration,
            sourceUrl: source?.sourceUrl,
          },
          analysis: analysis ?? undefined,
          brief,
          angle: effectiveAngle,
          tone: effectiveTone,
          hookArchetype: effectiveHook,
          customHook: effectiveCustomHook,
          visualFormat: effectiveVisualFormat,
          lengthTargetSec: effectiveLength,
          mirrorMode: useMirror,
          mirrorContext: effectiveMirrorContext,
          promptTemplate: resolveActivePromptText(cfg, "commentary")?.text,
          userCorrections: project.userCorrections,

          override,
        },
      });
      if (!res?.script?.trim()) throw new Error("Model returned an empty script");

      setProject({
        script: res.script,
        voiceover: undefined,
        voiceoverText: undefined,
        voiceoverScriptHash: undefined,
        meta: {
          videoId: "commentary",
          title: source?.title ?? "Video commentary",
          author: source?.author,
          thumbnail: source?.thumbnail,
        },
      });
      activity.stop(`script ready · ${res.script.split(/\s+/).length} words`, "ok");
      toast.success("Commentary script ready");
      setTab("script");
    } catch (e) {
      console.error("generateCommentaryScript failed", e);
      const msg = (e as Error).message || "Commentary script generation failed";
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  if (!analysis) {
    return (
      <AppShell>
        <StageHeader
          current="commentary"
          title="Commentary script"
          purpose="Turn the analysis into a scripted, hook-first commentary voiceover."
        />
        <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
          No analysis in this session.{" "}
          <button className="text-primary underline" onClick={() => navigate({ to: "/analyze" })}>
            Go to /analyze
          </button>{" "}
          and analyse a video first.
        </div>
      </AppShell>
    );
  }

  const hasSource = !!effectiveAngle.trim();

  return (
    <AppShell>
      <StageHeader
        current="commentary"
        title="Commentary script"
        purpose="Turn the analysis into a scripted, hook-first commentary voiceover."
      />
      <div className="mb-4"><ActivityPanel activity={activity} /></div>
      <div className="flex flex-col gap-6">
        <div>
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="mb-4">
              <TabsTrigger value="knobs">1. Format &amp; Length</TabsTrigger>
              <TabsTrigger value="script">2. Commentary Script</TabsTrigger>

            </TabsList>

            <TabsContent value="knobs" className="space-y-5">
              {/* Angle & Tone summary — read-only, edited on /analyze */}
              <section
                className={`rounded-lg border p-5 space-y-3 ${
                  useMirror ? "border-emerald-500/40 bg-emerald-500/5" : hasSource ? "border-primary/40 bg-primary/5" : "border-amber-500/40 bg-amber-500/5"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-mono text-sm font-semibold">
                      {useMirror ? "🪞 Mirror source" : hasSource ? "🎯 Selected angle" : "⚠ No angle selected"}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {hasSource
                        ? "Angle & tone are set on the Analyze stage. Change them there and come back."
                        : "Head to the Analyze stage to pick an angle from the AI suggestions, write your own, or derive mirror knobs from the source."}
                    </p>
                  </div>
                  <Button
                    onClick={() => navigate({ to: "/analyze" })}
                    variant="outline"
                    size="sm"
                    className="font-mono shrink-0"
                  >
                    ↗ edit on analyze
                  </Button>
                </div>

                {hasSource && (
                  <div className="rounded border border-border/60 bg-background/60 p-3 text-xs space-y-2">
                    <div>
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">angle</span>
                      <div className="mt-0.5">{effectiveAngle}{customAngle.trim() && <span className="ml-2 rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[9px] uppercase text-primary">custom override</span>}</div>
                    </div>
                    {resolvedTone && (
                      <div>
                        <span className="font-mono text-[10px] uppercase text-muted-foreground">tone (from mirror)</span>
                        <div className="mt-0.5">{resolvedTone}</div>
                      </div>
                    )}
                    {useMirror && (
                      <>
                        <div className="grid gap-1.5 sm:grid-cols-2 pt-2 border-t border-border/40">
                          <div>
                            <span className="font-mono text-[10px] uppercase text-muted-foreground">hook</span>
                            <div className="mt-0.5">{mirrorKnobs!.hookArchetype}</div>
                          </div>
                          <div>
                            <span className="font-mono text-[10px] uppercase text-muted-foreground">length</span>
                            <div className="mt-0.5">{mirrorKnobs!.lengthTargetSec}s</div>
                          </div>
                          <div className="sm:col-span-2">
                            <span className="font-mono text-[10px] uppercase text-muted-foreground">visual format</span>
                            <div className="mt-0.5">{mirrorKnobs!.visualFormat}</div>
                          </div>
                        </div>
                        <p className="pt-2 text-[10px] text-muted-foreground italic">
                          Mirror mode overrides hook, length, and visual format below.
                        </p>
                      </>
                    )}
                  </div>
                )}

                {/* Toggle between mirror & selected — only shown when both exist */}
                {mirrorKnobs && project.selectedAngle && (
                  <div className="flex items-center gap-3 text-xs">
                    <span className="font-mono text-[10px] uppercase text-muted-foreground">use:</span>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        checked={activeSource === "mirror"}
                        onChange={() => setProject({ angleSource: "mirror" })}
                      />
                      mirror
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        checked={activeSource === "selected"}
                        onChange={() => setProject({ angleSource: "selected" })}
                      />
                      selected angle
                    </label>
                  </div>
                )}
              </section>

              {/* Custom Angle Override — writes to project.customAngle; replaces the derived {{ANGLE}} at generate time. */}
              <section className="rounded-lg border border-dashed border-primary/40 bg-card p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-mono text-sm font-semibold">✍️ Custom angle override <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">optional</span></h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Leave blank to use the Mirror-derived angle. Anything you type here becomes the final <code className="font-mono text-[10px]">{"{{ANGLE}}"}</code> sent to the model.
                    </p>
                  </div>
                  {customAngle.trim() && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setCustomAngle(""); setProject({ customAngle: "" }); }}
                      className="h-7 shrink-0 font-mono text-[10px]"
                    >
                      clear
                    </Button>
                  )}
                </div>
                <Textarea
                  value={customAngle}
                  onChange={(e) => setCustomAngle(e.target.value)}
                  onBlur={() => setProject({ customAngle: customAngle.trim() })}
                  rows={2}
                  placeholder="e.g. Frame the whole clip as a physics lesson — laugh with the maker, not at them."
                  className="font-mono text-xs"
                />
                <div>
                  <Label className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">
                    extra vibe / notes <span className="normal-case text-muted-foreground/60">(appended to the brief)</span>
                  </Label>
                  <Textarea
                    value={customBriefAddendum}
                    onChange={(e) => setCustomBriefAddendum(e.target.value)}
                    onBlur={() => setProject({ customBriefAddendum: customBriefAddendum.trim() })}
                    rows={2}
                    placeholder="e.g. Keep it wholesome — no roast energy. Focus on how impressive the finish is."
                    className="font-mono text-xs"
                  />
                </div>
              </section>

              {/* Visual format — hidden when mirror overrides it */}
              {!useMirror && (
                <section className="rounded-lg border border-border bg-card p-5 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="font-mono text-sm font-semibold">Visual format</Label>
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
                      shapes visual cues
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    How the creator appears with the clip. Adapts the script's visual cues and on-screen overlays.
                  </p>
                  <Select value={visualFormat} onValueChange={setVisualFormat}>
                    <SelectTrigger className="mt-2 font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VISUAL_FORMATS.map((v) => (
                        <SelectItem key={v.value} value={v.value} className="font-mono text-xs">
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {visualFormat === "__custom__" && (
                    <Input
                      value={customVisualFormat}
                      onChange={(e) => setCustomVisualFormat(e.target.value)}
                      placeholder='e.g. "Creator sits at a desk, clip plays on the monitor behind them"'
                      className="mt-2 font-mono text-xs"
                    />
                  )}
                </section>
              )}

              {/* Hook + Length — hidden when mirror overrides */}
              {!useMirror && (
                <section className="rounded-lg border border-border bg-card p-5 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="font-mono text-sm font-semibold">Hook archetype</Label>
                    <Input
                      value={hook === "auto" ? "" : hook}
                      onChange={(e) => setHook(e.target.value || "auto")}
                      list="hook-suggestions"
                      placeholder='auto — or type a topic-specific hook (e.g. "Recipe Reveal", "Instant Karma")'
                      className="mt-2 font-mono text-xs"
                    />
                    <datalist id="hook-suggestions">
                      {HOOK_SUGGESTIONS.map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => setHook("auto")}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition ${
                          hook === "auto"
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary"
                        }`}
                      >
                        auto
                      </button>
                      {HOOK_SUGGESTIONS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setHook(s)}
                          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition ${
                            hook === s
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary"
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Free-form — type any label the source suggests. Mirror derive can also coin one from the video.
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <Label className="font-mono text-sm font-semibold">Length target</Label>
                      {lengthAuto ? (
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
                          auto · {lengthTarget}s
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setLengthAuto(true);
                            setLengthCustom(false);
                            setLengthTarget(autoLength);
                          }}
                          className="font-mono text-[10px] text-muted-foreground hover:text-primary"
                        >
                          [reset to auto]
                        </button>
                      )}
                    </div>
                    <Select
                      value={lengthCustom ? "-1" : String(lengthTarget)}
                      onValueChange={(v) => {
                        const n = Number(v);
                        if (n === -1) {
                          setLengthCustom(true);
                          setLengthAuto(false);
                        } else {
                          setLengthCustom(false);
                          setLengthAuto(false);
                          setLengthTarget(n);
                        }
                      }}
                    >
                      <SelectTrigger className="mt-2 font-mono text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LENGTHS.map((l) => (
                          <SelectItem key={l.value} value={String(l.value)} className="font-mono text-xs">
                            {l.label}
                          </SelectItem>
                        ))}
                        {!lengthCustom && !LENGTHS.some((l) => l.value === lengthTarget) && (
                          <SelectItem value={String(lengthTarget)} className="font-mono text-xs">
                            Auto ({lengthTarget}s — matches source)
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {lengthCustom && (
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          type="number"
                          min={5}
                          max={180}
                          value={lengthTarget}
                          onChange={(e) => {
                            const n = Math.max(5, Math.min(180, Number(e.target.value) || 0));
                            setLengthTarget(n);
                          }}
                          className="font-mono text-xs"
                        />
                        <span className="font-mono text-[10px] text-muted-foreground">seconds (5–180)</span>

                      </div>
                    )}
                  </div>
                </section>
              )}

              <section className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-mono text-sm font-semibold">Context Brief</h3>
                  <div className="flex items-center gap-3">
                    {briefTouched.current && (
                      <button
                        className="font-mono text-[10px] text-muted-foreground hover:text-primary"
                        onClick={() => {
                          briefTouched.current = false;
                          setBrief(autoBrief);
                        }}
                      >
                        [reset to analysis]
                      </button>
                    )}
                    <button
                      className="font-mono text-[10px] text-muted-foreground hover:text-primary"
                      onClick={() => setShowBrief((s) => !s)}
                    >
                      {showBrief ? "[hide]" : "[peek / edit]"}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Everything the model sees about the source video. Auto-assembled from Summary, Scenes, Transcript, Draft. Edit to prune or add notes.
                </p>
                {showBrief && (
                  <Textarea
                    value={brief}
                    onChange={(e) => {
                      briefTouched.current = true;
                      setBrief(e.target.value);
                    }}
                    rows={18}
                    className="mt-3 font-mono text-[11px] leading-relaxed"
                  />
                )}
              </section>

              <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel/40 p-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 flex-1 sm:max-w-md">
                  <Label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    model
                  </Label>
                  <Select
                    value={project.scriptModelChoice ?? "default"}
                    onValueChange={(v) => setProject({ scriptModelChoice: v })}
                  >
                    <SelectTrigger className="w-full font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-[360px]">
                      <SelectItem value="default" className="font-mono text-xs">
                        Use stage default (Settings)
                      </SelectItem>
                      {cfg.defaultHost && cfg.defaultModel && (
                        <SelectItem value="global" className="font-mono text-xs">
                          Global default — {cfg.defaultModel}
                        </SelectItem>
                      )}
                      <div className="mt-1 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        Custom presets
                      </div>
                      {cfg.customModels.length === 0 ? (
                        <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                          None — add in Settings →
                        </div>
                      ) : (
                        cfg.customModels.map((p) => (
                          <SelectItem key={p.id} value={`custom:${p.id}`} className="font-mono text-xs">
                            {p.label || p.model || "(unnamed)"} — {p.model}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={generate}
                  disabled={generating || !hasSource}
                  className="w-full font-mono sm:w-auto sm:shrink-0"
                >
                  {generating ? "writing…" : "→ generate commentary script"}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="script">
              {!project.script ? (
                <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
                  No script yet. Confirm the angle and generate.
                </div>
              ) : (
                <div className="space-y-4">
                  <ScriptResult raw={project.script} />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button onClick={() => navigate({ to: "/voiceover" })} className="font-mono">
                      → continue to voiceover
                    </Button>
                    <Button
                      onClick={() => navigate({ to: "/fair-use" })}
                      variant="outline"
                      className="font-mono"
                    >
                      fair-use notes
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>


          </Tabs>
        </div>

        {/* Source & report summary — moved below so the script table can use full width */}
        <aside className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start">
            <div className="flex gap-3 min-w-0">
              {source?.thumbnail && (
                <img
                  src={source.thumbnail}
                  alt=""
                  className="h-16 w-24 shrink-0 rounded border border-border object-cover"
                />
              )}
              <div className="min-w-0 space-y-1 text-xs">
                <div className="truncate font-medium" title={source?.title ?? ""}>
                  {source?.title ?? "(untitled)"}
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {source?.platform ?? "—"} · {source?.author ?? "—"}
                  {source?.duration ? ` · ${source.duration.toFixed(1)}s` : ""}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase text-muted-foreground">tone</div>
                <div className="truncate" title={analysis.tone}>{analysis.tone}</div>
              </div>
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase text-muted-foreground">pacing</div>
                <div className="truncate" title={analysis.pacing}>{analysis.pacing}</div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase text-muted-foreground">scenes</div>
                <div>{analysis.scenes?.length ?? 0}</div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase text-muted-foreground">angles</div>
                <div>{analysis.commentaryAngles?.length ?? 0}</div>
              </div>
            </div>
          </div>
        </aside>

      </div>
      <StageFooter current="commentary" disabled={!project.script} />
    </AppShell>
  );
}
