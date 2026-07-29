import { useConfig } from "@/lib/store";
import type { StageKey as StoreStageKey } from "@/lib/types";
import type { StageKey as PipelineStageKey } from "@/pipelines/_core/types";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Slot = { key: StoreStageKey; label: string; hint?: string };

// Which store-level stage(s) power each pipeline stage's runtime call.
// Analyze uses two — one for vision (frame captions), one for the report merge.
const SLOTS: Record<PipelineStageKey, Slot[]> = {
  analyze: [
    { key: "analyze-vision", label: "Vision (frame captions)", hint: "multimodal model — Gemini Flash / GPT-4o class" },
    { key: "analyze-report", label: "Report merge & mirror angles", hint: "text model — assembles the final report" },
  ],
  transcript: [{ key: "transcript", label: "Model" }],
  frames: [{ key: "frames", label: "Model" }],
  products: [{ key: "products", label: "Model" }],
  commentary: [{ key: "script", label: "Model", hint: "commentary generation runs on the script stage" }],
  script: [{ key: "script", label: "Model" }],
  voiceover: [{ key: "voiceover", label: "Model (for Enhance-with-Emotion)" }],
  seo: [{ key: "seo", label: "Model" }],
  fairuse: [{ key: "fairuse", label: "Model" }],
};

export function StageModelPanel({ stage }: { stage: PipelineStageKey }) {
  const [cfg, , setStage] = useConfig();
  const slots = SLOTS[stage] ?? [];

  if (slots.length === 0) {
    return (
      <div className="rounded border border-dashed border-border p-4 text-xs text-muted-foreground">
        No model routing for this stage.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Pick which endpoint powers this stage. Uses the <b>Global default</b> from Settings unless
        you select a saved preset or override the host/model inline.
      </p>
      {slots.map((slot) => {
        const st = cfg.stages[slot.key] ?? { useLovable: false };
        const currentValue = st.presetId
          ? `preset:${st.presetId}`
          : st.mode === "inline" || st.host || st.apiKey || st.model
            ? "inline"
            : "global";
        return (
          <div key={slot.key} className="rounded-md border border-border bg-panel/40 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{slot.label}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  stage.{slot.key}
                  {slot.hint ? ` · ${slot.hint}` : ""}
                </div>
              </div>
              <Select
                value={currentValue}
                onValueChange={(v) => {
                  if (v === "global") {
                    setStage(slot.key, { mode: "global", useLovable: false, presetId: undefined, host: "", apiKey: "", model: "" });
                  } else if (v === "inline") {
                    setStage(slot.key, { mode: "inline", useLovable: false, presetId: undefined });
                  } else if (v.startsWith("preset:")) {
                    setStage(slot.key, {
                      mode: "preset",
                      useLovable: false,
                      presetId: v.slice(7),
                      host: "",
                      apiKey: "",
                      model: "",
                    });
                  }
                }}
              >
                <SelectTrigger className="h-8 w-[220px] font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global" className="font-mono text-xs">
                    Global default
                  </SelectItem>
                  <SelectItem value="inline" className="font-mono text-xs">
                    Inline endpoint (below)
                  </SelectItem>
                  {cfg.customModels.length > 0 && (
                    <div className="mt-1 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      Custom presets
                    </div>
                  )}
                  {cfg.customModels.map((p) => (
                    <SelectItem key={p.id} value={`preset:${p.id}`} className="font-mono text-xs">
                      {p.label || p.model} — {p.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {currentValue === "inline" && (
              <div className="space-y-2">
                <div className="grid gap-2 md:grid-cols-3">
                  <Input
                    value={st.host ?? ""}
                    onChange={(e) => setStage(slot.key, { mode: "inline", host: e.target.value })}
                    placeholder="host URL (e.g. https://api.groq.com/openai/v1)"
                    className="font-mono text-xs"
                  />
                  <Input
                    value={st.apiKey ?? ""}
                    onChange={(e) => setStage(slot.key, { mode: "inline", apiKey: e.target.value })}
                    placeholder="API key (optional if local)"
                    type="password"
                    className="font-mono text-xs"
                  />
                  <Input
                    value={st.model ?? ""}
                    onChange={(e) => setStage(slot.key, { mode: "inline", model: e.target.value })}
                    placeholder="model ID (e.g. qwen/qwen3.6-27b)"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">Quick fill:</span>
                  <button
                    type="button"
                    onClick={() =>
                      setStage(slot.key, {
                        mode: "inline",
                        host: "https://api.groq.com/openai/v1",
                        model: "qwen/qwen3.6-27b",
                      })
                    }
                    className="rounded bg-muted/80 px-2 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-primary/20 hover:text-primary"
                  >
                    🚀 Groq (qwen/qwen3.6-27b)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setStage(slot.key, {
                        mode: "inline",
                        host: "https://generativelanguage.googleapis.com/v1beta/openai/",
                        model: "gemini-2.5-flash",
                      })
                    }
                    className="rounded bg-muted/80 px-2 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-primary/20 hover:text-primary"
                  >
                    ⚡ Gemini (gemini-2.5-flash)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setStage(slot.key, {
                        mode: "inline",
                        host: "http://localhost:11434/v1",
                        model: "qwen2-vl",
                      })
                    }
                    className="rounded bg-muted/80 px-2 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-primary/20 hover:text-primary"
                  >
                    🦙 Ollama Local (qwen2-vl)
                  </button>
                </div>
              </div>
            )}

            {/* Fallback Model Section */}
            <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={st.enableFallback ?? false}
                  onChange={(e) => setStage(slot.key, { enableFallback: e.target.checked })}
                  className="h-3.5 w-3.5 accent-primary"
                />
                <span>Enable Fallback Model (auto failover if primary fails)</span>
              </label>

              {st.enableFallback && (
                <div className="space-y-2 rounded border border-border/50 bg-background/50 p-2.5">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    Fallback endpoint &amp; model:
                  </div>
                  <div className="grid gap-2 md:grid-cols-3">
                    <Input
                      value={st.fallbackHost ?? ""}
                      onChange={(e) => setStage(slot.key, { fallbackHost: e.target.value })}
                      placeholder="fallback host URL (e.g. https://api.groq.com/openai/v1)"
                      className="font-mono text-xs"
                    />
                    <Input
                      value={st.fallbackApiKey ?? ""}
                      onChange={(e) => setStage(slot.key, { fallbackApiKey: e.target.value })}
                      placeholder="fallback API key"
                      type="password"
                      className="font-mono text-xs"
                    />
                    <Input
                      value={st.fallbackModel ?? ""}
                      onChange={(e) => setStage(slot.key, { fallbackModel: e.target.value })}
                      placeholder="fallback model ID (e.g. qwen/qwen3.6-27b)"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">Quick fill fallback:</span>
                    <button
                      type="button"
                      onClick={() =>
                        setStage(slot.key, {
                          enableFallback: true,
                          fallbackHost: "https://api.groq.com/openai/v1",
                          fallbackModel: "qwen/qwen3.6-27b",
                        })
                      }
                      className="rounded bg-muted/80 px-2 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-primary/20 hover:text-primary"
                    >
                      🚀 Groq (qwen/qwen3.6-27b)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setStage(slot.key, {
                          enableFallback: true,
                          fallbackHost: "https://generativelanguage.googleapis.com/v1beta/openai/",
                          fallbackModel: "gemini-2.5-flash",
                        })
                      }
                      className="rounded bg-muted/80 px-2 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-primary/20 hover:text-primary"
                    >
                      ⚡ Gemini (gemini-2.5-flash)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setStage(slot.key, {
                          enableFallback: true,
                          fallbackHost: "http://localhost:11434/v1",
                          fallbackModel: "qwen2-vl",
                        })
                      }
                      className="rounded bg-muted/80 px-2 py-0.5 font-mono text-[10px] text-foreground transition hover:bg-primary/20 hover:text-primary"
                    >
                      🦙 Ollama Local (qwen2-vl)
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
