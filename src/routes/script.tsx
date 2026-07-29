import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useConfig, useProject, getStageOverride } from "@/lib/store";
import { generateScript } from "@/lib/script.functions";
import { resolveActivePromptText, resolvePromptTextById } from "@/lib/prompt-registry";
import { ScriptResult } from "@/components/ScriptResult";
import { generateSeo } from "@/lib/seo.functions";
import { toast } from "sonner";
import { StageHeader } from "@/components/stage/StageHeader";
import { StageFooter } from "@/components/stage/StageFooter";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import { useActivityLog } from "@/hooks/useActivityLog";

export const Route = createFileRoute("/script")({
  component: ScriptPage,
});

const FORMATS = [
  "Format A: The Rapid Listicle (Multiple Products)",
  "Format B: The Deep Dive (Single Product)",
];

const TONES = [
  "Hyped & Fast (High-energy vertical style)",
  "Calm & Authoritative (Expert reviewer)",
  "Funny & Sarcastic (Gen-Z meme energy)",
  "Curious & Storytelling (Documentary vibe)",
];

function defaultProductInfo(products: NonNullable<ReturnType<typeof useProject>[0]["products"]>, amazon?: Record<string, { affiliateUrl?: string; price?: string; title?: string }[]>) {
  return products
    .map((p, i) => {
      const top = amazon?.[p.name]?.[0];
      const link = p.affiliate_url || top?.affiliateUrl || "";
      const feature = p.key_feature || p.description || "";
      return `Product #${i + 1}: ${p.name}${p.brand ? ` (${p.brand})` : ""}
- Key Features: ${feature || "—"}${link ? `\n- Link: ${link}` : ""}`;
    })
    .join("\n\n");
}

function ScriptPage() {
  const [project, setProject] = useProject();
  const [cfg] = useConfig();
  const navigate = useNavigate();
  const [generating, setGenerating] = useState(false);
  const [loadingSeo, setLoadingSeo] = useState(false);
  const [tab, setTab] = useState("inputs");
  const activity = useActivityLog();

  const products = project.products ?? [];
  const amazonMode = project.mode === "amazon";
  const transcriptText = useMemo(
    () => (project.transcript ?? []).map((s) => s.text).join(" "),
    [project.transcript],
  );

  const autoProductInfo = useMemo(
    () => defaultProductInfo(products, project.amazon),
    [products, project.amazon],
  );
  const autoAudience = useMemo(() => {
    const names = products.map((p) => p.name).filter(Boolean).join(", ");
    const cats = Array.from(new Set(products.map((p) => p.category).filter(Boolean))).join(", ");
    if (!names) return "";
    return `Buyers researching ${names}${cats ? ` — interest niches: ${cats}` : ""}. High-utility lifestyle hacks, honest product reviews, and smart household gadgets.`;
  }, [products]);

  // Amazon mode has no source video → synthesise a stylistic reference beat
  // sheet from product data so the model still gets pacing/hook/loop cues.
  const autoCompetitorAmazon = useMemo(() => {
    if (!products.length) return "";
    const single = products.length === 1;
    const p0 = products[0];
    const hook = single
      ? `Stop scrolling — this ${p0.category || "thing"} solved a problem I didn't know I had.`
      : `${products.length} Amazon finds that quietly upgraded my whole week.`;
    const beats = products.map((p, i) => {
      const feat = (p.key_feature || p.description || "").split(/[.•]/)[0].trim();
      const price = p.estimated_price ? ` Around ${p.estimated_price}.` : "";
      return single
        ? `Beat ${i + 1}: name the tiny pain → reveal the ${p.name} → show ${feat || "it in action"} → land the feeling of relief.${price}`
        : `#${products.length - i}: ${p.name}${p.brand ? ` by ${p.brand}` : ""} — ${feat || "punchy benefit"}.${price} Tease the next one.`;
    });
    const outro = single
      ? "End on the honest caveat + reframe, then loop back to the opening pain."
      : "Close on the final pick with a line that flows back into the hook.";
    return [
      `Reference vertical-video beat sheet (synthesised from product data — Amazon mode has no source transcript). Model the pacing, hook shape, per-product tempo, and loop cadence.`,
      `HOOK: ${hook}`,
      ...beats,
      `OUTRO: ${outro}`,
    ].join("\n");
  }, [products]);

  const autoCompetitor = amazonMode ? autoCompetitorAmazon : transcriptText;

  const autoVisuals = useMemo(() => {
    const fmt = (s?: number) => {
      if (s == null) return "?";
      const m = Math.floor(s / 60);
      const ss = Math.floor(s % 60).toString().padStart(2, "0");
      return `${m}:${ss}`;
    };
    const beats = products
      .filter((p) => p.frame)
      .slice(0, 12)
      .map((p) => `- [${fmt(p.timestamp_seconds)}] ${p.name}${p.key_feature ? ` — ${p.key_feature}` : ""}`)
      .join("\n");
    if (beats) {
      return `Aligned product frames from the source video (use as b-roll cues in order):\n${beats}`;
    }
    if (amazonMode && products.length) {
      const cues = products
        .slice(0, 10)
        .map(
          (p, i) =>
            `- Beat ${i + 1}: macro close-up of ${p.name}${
              p.key_feature ? ` demonstrating "${p.key_feature.split(/[.•]/)[0].trim()}"` : " in real use"
            }, hands-in-frame, one satisfying pattern-interrupt cut.`,
        )
        .join("\n");
      return `No source video — build b-roll around the products themselves:\n${cues}\nGeneral rule: 1.5–2s cuts, tactile close-ups, real-hand demos, quick before/after reveals, kinetic captions on impact words.`;
    }
    return "Clean close-ups of the products in action, tactile hand-held demos, satisfying before/after cuts, and quick pattern-interrupt reactions.";
  }, [products, amazonMode]);

  const [format, setFormat] = useState(FORMATS[0]);
  const [tone, setTone] = useState(TONES[0]);
  const [productInfoText, setProductInfoText] = useState(autoProductInfo);
  const [competitorScript, setCompetitorScript] = useState(autoCompetitor);
  const [targetAudience, setTargetAudience] = useState(autoAudience);
  const [videoVisuals, setVideoVisuals] = useState(autoVisuals);

  const [dirty, setDirty] = useState({
    productInfo: false,
    competitor: false,
    audience: false,
    visuals: false,
  });

  useEffect(() => { if (!dirty.productInfo) setProductInfoText(autoProductInfo); }, [autoProductInfo, dirty.productInfo]);
  useEffect(() => { if (!dirty.competitor) setCompetitorScript(autoCompetitor); }, [autoCompetitor, dirty.competitor]);
  useEffect(() => { if (!dirty.audience) setTargetAudience(autoAudience); }, [autoAudience, dirty.audience]);
  useEffect(() => { if (!dirty.visuals) setVideoVisuals(autoVisuals); }, [autoVisuals, dirty.visuals]);

  useEffect(() => {
    if (products.length === 1 && format === FORMATS[0]) setFormat(FORMATS[1]);
    if (products.length > 1 && format === FORMATS[1]) setFormat(FORMATS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length]);

  const canGenerate = productInfoText.trim().length > 0;

  function buildPayload() {
    // We embed user-edited product/competitor text directly by shipping them
    // via targetAudience-less fields: pass overrides via the raw inputs.
    return {
      title: project.meta?.title,
      transcript: competitorScript,
      products: products.map((p) => ({ ...p })),
      amazon: project.amazon,
      frames: project.frames,
      format,
      tone,
      targetAudience,
      videoVisuals,
      promptTemplate: resolveActivePromptText(cfg, "script")?.text,
      // productInfoText is what the user actually sees; if they edited it,
      // rebuild a synthetic products array so the prompt uses their text verbatim.
      override: getStageOverride(cfg, "script"),
    };
  }

  // If the user edited the product text, ship it as a single synthetic product
  // whose "name" carries the whole block so buildScriptPrompt renders it.
  function payloadForPrompt() {
    const base = buildPayload();
    const defaultText = defaultProductInfo(products, project.amazon);
    if (productInfoText.trim() && productInfoText.trim() !== defaultText.trim()) {
      return {
        ...base,
        products: [
          {
            name: productInfoText,
            key_feature: "",
          },
        ],
      };
    }
    return base;
  }


  async function generate() {
    if (!canGenerate) return toast.error("Add product information first");
    setGenerating(true);
    activity.start("generating viral script…");
    try {
      activity.log("assembling prompt with product info, beats, and visuals…");
      const res = await generateScript({ data: payloadForPrompt() });
      setProject({
        script: res.script,
        voiceoverText: undefined,
        voiceover: undefined,
        voiceoverScriptHash: undefined,
      });
      
      activity.stop(`script ready · ${res.script.split(/\s+/).length} words`, "ok");
      toast.success("Viral script generated");
      setTab("script");
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  async function next() {
    if (!project.script || !products.length) return;
    setLoadingSeo(true);
    activity.start("generating SEO pack…");
    try {
      const res = await generateSeo({
        data: {
          title: project.meta?.title,
          script: project.script,
          products,
          amazon: project.amazon,
          promptTemplateCommentary: resolvePromptTextById(cfg, "seo.commentary"),
          promptTemplateReview: resolvePromptTextById(cfg, "seo.review"),
          override: getStageOverride(cfg, "seo"),
        },
      });
      setProject({ seo: res });
      activity.stop("SEO pack ready", "ok");
      toast.success("SEO pack ready");
      navigate({ to: "/seo" });
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setLoadingSeo(false);
    }
  }

  return (
    <AppShell>
      <StageHeader
        current="script"
        title="Viral script generator"
        purpose="Turn products + reference beats into a tight, hook-first script — ready for voiceover."
      />
      <div className="mb-4"><ActivityPanel activity={activity} /></div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="inputs">1. Script Inputs</TabsTrigger>
              <TabsTrigger value="script">2. Completed Script</TabsTrigger>
            </TabsList>

            <TabsContent value="inputs" className="space-y-6">
              <section className="rounded-lg border border-border bg-card p-5">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-mono text-sm font-semibold">
                    1. Product Information{" "}
                    <span className="text-muted-foreground">(&lt;Product_Info&gt;)</span>
                  </h3>
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
                    algorithm critical
                  </span>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  Product names, USPs, and affiliate links. Auto-filled from the Products stage — edit freely.
                </p>
                <Textarea
                  value={productInfoText}
                  onChange={(e) => { setProductInfoText(e.target.value); setDirty((d) => ({ ...d, productInfo: true })); }}
                  rows={10}
                  className="font-mono text-xs"
                  placeholder="Product #1: ...\n- Key Features: ...\n- Link: https://..."
                />
              </section>

              <section className="rounded-lg border border-border bg-card p-5">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-mono text-sm font-semibold">
                    2. {amazonMode ? "Reference Beat Sheet" : "Reference / Competitor Transcript"}{" "}
                    <span className="text-muted-foreground">(&lt;Competitor_Script&gt;)</span>
                  </h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                    {amazonMode ? "auto-synthesised" : "pacing model"}
                  </span>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  {amazonMode
                    ? "Amazon mode has no source transcript — this beat sheet is generated from your product data to give the model pacing/hook/loop cues. Edit freely or paste a real reference."
                    : "The AI models successful hooks, flow speed, and item transitions from this."}
                </p>
                <Textarea
                  value={competitorScript}
                  onChange={(e) => { setCompetitorScript(e.target.value); setDirty((d) => ({ ...d, competitor: true })); }}
                  rows={6}
                  className="font-mono text-xs"
                  placeholder="Paste a reference transcript…"
                />
              </section>

              <section className="rounded-lg border border-border bg-card p-5">
                <h3 className="mb-2 font-mono text-sm font-semibold">
                  3. Target Audience{" "}
                  <span className="text-muted-foreground">(&lt;Target_Audience&gt;)</span>
                </h3>
                <Textarea
                  value={targetAudience}
                  onChange={(e) => { setTargetAudience(e.target.value); setDirty((d) => ({ ...d, audience: true })); }}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="e.g. DIY home renovators, tool nerds, contractors on TikTok…"
                />
              </section>

              <section className="rounded-lg border border-border bg-card p-5">
                <h3 className="mb-2 font-mono text-sm font-semibold">
                  4. Video Visuals{" "}
                  <span className="text-muted-foreground">(&lt;Video_Visuals&gt;)</span>
                </h3>
                <p className="mb-3 text-xs text-muted-foreground">
                  Leave empty to auto-use your captured frame scenes as b-roll cues.
                </p>
                <Textarea
                  value={videoVisuals}
                  onChange={(e) => { setVideoVisuals(e.target.value); setDirty((d) => ({ ...d, visuals: true })); }}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="Optional — describe desired b-roll style…"
                />
              </section>
            </TabsContent>

            <TabsContent value="script">
              {!project.script ? (
                <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
                  No script yet. Click <span className="text-primary">Generate Viral Script</span>.
                </div>
              ) : (
                <div className="space-y-4">
                  <ScriptResult raw={project.script} />
                </div>
              )}
            </TabsContent>

          </Tabs>
        </div>

        {/* Sidebar */}
        <aside className="space-y-5 rounded-lg border border-border bg-card p-5 h-fit lg:sticky lg:top-4">
          <div>
            <h3 className="mb-3 font-mono text-sm font-semibold">Formula Options</h3>
            <div className="space-y-4">
              <div>
                <Label className="font-mono text-[11px] uppercase text-muted-foreground">
                  Pacing framework
                </Label>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>{f}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-2 rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
                  <span className="font-semibold text-foreground">The Countdown Hack:</span>{" "}
                  Spend 4–6s per item. On-screen visual countdown hooks retention;
                  numbers are <strong>never</strong> spoken aloud.
                </p>
              </div>

              <div>
                <Label className="font-mono text-[11px] uppercase text-muted-foreground">
                  Voiceover vibe & tone
                </Label>
                <Select value={tone} onValueChange={setTone}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="font-mono text-[11px] uppercase text-muted-foreground">
                  Video title (optional)
                </Label>
                <Input
                  value={project.meta?.title ?? ""}
                  onChange={(e) => setProject({ meta: { ...(project.meta ?? { videoId: "" }), title: e.target.value } })}
                  className="mt-1"
                  placeholder="Auto-filled from video…"
                />
              </div>
            </div>
          </div>

          <Button
            onClick={generate}
            disabled={generating || !canGenerate}
            className="w-full font-mono"
          >
            {generating ? "generating…" : project.script ? "↻ regenerate viral script" : "✨ generate viral script"}
          </Button>

          <div className="font-mono text-[10px] text-muted-foreground space-y-1 border-t border-border pt-4">
            <div>mode: <span className="text-primary">{amazonMode ? "amazon links" : "youtube"}</span></div>
            <div>products: <span className={products.length ? "text-primary" : ""}>{products.length}</span></div>
            {amazonMode ? (
              <>
                <div>frames: <span className="text-muted-foreground/50">n/a</span></div>
                <div>transcript: <span className="text-muted-foreground/50">synthesised</span></div>
              </>
            ) : (
              <>
                <div>frames: <span className={products.some((p) => p.frame) ? "text-primary" : ""}>{products.filter((p) => p.frame).length} aligned</span></div>
                <div>transcript: <span className={project.transcript?.length ? "text-primary" : ""}>{project.transcript?.length ?? 0} segs</span></div>
              </>
            )}
          </div>
        </aside>
      </div>
      <StageFooter current="script" disabled={!project.script} />
    </AppShell>
  );
}
