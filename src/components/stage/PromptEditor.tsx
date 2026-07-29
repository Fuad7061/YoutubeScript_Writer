import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Save, AlertTriangle, Copy, Check, BookmarkPlus, Trash2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfig, useProject } from "@/lib/store";
import {
  promptById,
  normalizePromptPlaceholders,
  validateAgainstDefault,
  type PromptId,
  type PromptMeta,
} from "@/lib/prompt-registry";
import {
  buildLivePrompt,
  PLACEHOLDER_DOCS,
  segmentRenderedPrompt,
  colorForPlaceholder,
} from "@/lib/prompt-preview";
import { toast } from "sonner";

/**
 * Editor for a single registered prompt.
 * Reads / writes via useConfig() — the source of truth for both
 * Config.promptOverrides and legacy per-prompt Config fields
 * (commentaryPromptTemplate / scriptPromptTemplate).
 */
export function PromptEditor({ id }: { id: PromptId }) {
  const meta: PromptMeta = promptById[id];
  const [cfg, setCfg] = useConfig();
  const [project] = useProject();
  const storedRaw =
    (meta.legacyConfigKey ? cfg[meta.legacyConfigKey] : "") ||
    cfg.promptOverrides?.[id] ||
    "";
  const normalizedStoredRaw = normalizePromptPlaceholders(storedRaw);

  // Stale-format detector: commentary prompts were upgraded from a 3-column
  // table ("SFX & Text Overlays") to a 4-column CapCut table
  // ("📱 Editor (CapCut)"). An override saved before that upgrade still shows
  // the old format in the editor even though the code default has changed.
  // Treat such overrides as stale so the editor + runtime pick up the new default.
  const isStaleCommentary = (txt: string) =>
    (id === "commentary.v1" || id === "commentary.v2") &&
    txt.length > 0 &&
    !txt.includes("📱 Editor (CapCut)");

  // Self-heal: if a stored override contains NONE of the declared
  // placeholders, treat it as broken/stale (older schema, accidental clear,
  // partial paste) and fall back to the default so the editor doesn't scare
  // the user with a full "all placeholders missing" warning on first open.
  const storedHasAnyPlaceholder =
    normalizedStoredRaw.trim().length > 0 &&
    meta.placeholders.some((p) => normalizedStoredRaw.toUpperCase().includes(p.toUpperCase()));
  const stored =
    storedHasAnyPlaceholder && !isStaleCommentary(normalizedStoredRaw) ? normalizedStoredRaw : "";
  const isCustom = stored.trim().length > 0;

  // Personal baseline: what Reset should restore to. Falls back to factory.
  const factoryDefault = useMemo(() => normalizePromptPlaceholders(meta.getDefault()), [meta]);
  const baselineRaw = cfg.promptBaselines?.[id] ?? "";
  const normalizedBaseline = baselineRaw ? normalizePromptPlaceholders(baselineRaw) : "";
  const hasCustomBaseline =
    normalizedBaseline.trim().length > 0 &&
    meta.placeholders.some((p) => normalizedBaseline.toUpperCase().includes(p.toUpperCase())) &&
    !isStaleCommentary(normalizedBaseline);
  const activeDefault = hasCustomBaseline ? normalizedBaseline : factoryDefault;


  const initial = isCustom ? stored : activeDefault;

  const [draft, setDraft] = useState(initial);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const dirty = draft !== initial;

  const livePreview = useMemo(
    () => (previewOpen ? buildLivePrompt(id, project, cfg, draft) : null),
    [previewOpen, id, project, cfg, draft],
  );

  useEffect(() => {
    setDraft(initial);
    setCopied(false);
  }, [id, initial]);

  const validation = useMemo(() => validateAgainstDefault(meta, draft), [meta, draft]);

  const save = () => {
    const patch: Parameters<typeof setCfg>[0] = {
      promptOverrides: { ...(cfg.promptOverrides ?? {}), [id]: draft },
    };
    if (meta.legacyConfigKey) {
      patch[meta.legacyConfigKey] = draft;
    }
    setCfg(patch);
    if (!validation.ok) {
      toast.warning(
        `Saved — ${validation.missing.length} placeholder${
          validation.missing.length === 1 ? "" : "s"
        } missing. Runtime will use default fallback.`,
      );
    } else {
      toast.success("Prompt saved");
    }
  };

  const setAsDefault = () => {
    if (!validation.ok) {
      const proceed = window.confirm(
        `This prompt is missing ${validation.missing.length} required placeholder${
          validation.missing.length === 1 ? "" : "s"
        } (${validation.missing.join(", ")}).\n\n` +
          "Save it as your personal default anyway? Runtime will still fall back for missing placeholders.",
      );
      if (!proceed) return;
    }
    const patch: Parameters<typeof setCfg>[0] = {
      promptBaselines: { ...(cfg.promptBaselines ?? {}), [id]: draft },
      // Clear any override so Reset (which we're effectively doing here)
      // shows the new baseline as the active prompt.
      promptOverrides: (() => {
        const next = { ...(cfg.promptOverrides ?? {}) };
        delete next[id];
        return next;
      })(),
    };
    if (meta.legacyConfigKey) {
      patch[meta.legacyConfigKey] = "";
    }
    setCfg(patch);
    toast.success("Saved as your default — Reset will restore this");
  };

  const clearBaseline = () => {
    if (!hasCustomBaseline) return;
    const next = { ...(cfg.promptBaselines ?? {}) };
    delete next[id];
    setCfg({ promptBaselines: next });
    toast.success("Personal default cleared — Reset now restores factory template");
  };

  const reset = () => {
    const patch: Parameters<typeof setCfg>[0] = {
      promptOverrides: (() => {
        const next = { ...(cfg.promptOverrides ?? {}) };
        delete next[id];
        return next;
      })(),
    };
    if (meta.legacyConfigKey) {
      patch[meta.legacyConfigKey] = "";
    }
    setCfg(patch);
    setDraft(activeDefault);
    toast.success(hasCustomBaseline ? "Reset to your default" : "Reset to factory default");
  };

  const copyDefault = async () => {
    try {
      await navigator.clipboard.writeText(activeDefault);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // Robust copy — falls back to a hidden textarea for restricted contexts
  // (iframes, non-secure origins) where navigator.clipboard is blocked.
  const copyText = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  };

  const copyLivePrompt = async () => {
    if (!livePreview) return;
    const ok = await copyText(livePreview.text);
    if (ok) {
      setPreviewCopied(true);
      setTimeout(() => setPreviewCopied(false), 1500);
      toast.success("Live prompt copied");
    } else {
      toast.error("Copy failed — select the text manually");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          placeholders:
        </span>
        {meta.placeholders.map((p) => {
          const present = draft.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(p).catch(() => {});
                toast.success(`Copied ${p}`);
              }}
              className={
                "rounded border px-1.5 py-0.5 font-mono text-[10px] transition " +
                (present
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-destructive/30 bg-destructive/5 text-destructive")
              }
              title={`${PLACEHOLDER_DOCS[p] ? PLACEHOLDER_DOCS[p] + "\n\n" : ""}${present ? "Present in template — click to copy" : "Missing from template — click to copy"}`}
            >
              {p}
            </button>
          );
        })}
      </div>

      {!validation.ok && (
        <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Missing required placeholder{validation.missing.length === 1 ? "" : "s"}:{" "}
            <code className="font-mono">{validation.missing.join(", ")}</code>. Saving is allowed —
            the generator will silently fall back to the default template until fixed.
          </span>
        </div>
      )}

      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="min-h-[320px] flex-1 resize-none font-mono text-[11px] leading-relaxed"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {isCustom ? (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">custom</span>
          ) : hasCustomBaseline ? (
            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
              your default
            </span>
          ) : (
            <span>factory default</span>
          )}
          {dirty && <span className="text-amber-500">· unsaved</span>}
          <span>· {draft.length.toLocaleString()} chars</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPreviewOpen(true)}
            className="h-8 gap-1"
            title="Show the fully-rendered prompt with all placeholders filled from the current project"
          >
            <Eye className="h-3.5 w-3.5" />
            <span className="text-xs">Preview live prompt</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={copyDefault} className="h-8 gap-1">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="text-xs">Copy default</span>
          </Button>
          {hasCustomBaseline && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearBaseline}
              className="h-8 gap-1 text-muted-foreground hover:text-destructive"
              title="Forget your saved default and go back to the factory template"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="text-xs">Clear default</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            disabled={!isCustom && !dirty}
            className="h-8 gap-1"
            title={hasCustomBaseline ? "Reset to your saved default" : "Reset to factory default"}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="text-xs">Reset</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={setAsDefault}
            disabled={draft.trim().length === 0 || draft === normalizedBaseline}
            className="h-8 gap-1"
            title={
              draft === normalizedBaseline
                ? "This is already your saved default"
                : "Save the current text as your personal default. Future Reset restores to this."
            }
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            <span className="text-xs">Set as default</span>
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty} className="h-8 gap-1">
            <Save className="h-3.5 w-3.5" />
            <span className="text-xs">Save</span>
          </Button>
        </div>
      </div>


      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="border-b border-border px-5 py-3">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Eye className="h-4 w-4 text-primary" />
              Live prompt — {meta.label}
            </DialogTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The exact string the model will receive, with placeholders filled from your current project.
              Edits in the editor above appear here immediately (unsaved changes included).
            </p>
          </DialogHeader>

          <div className="flex max-h-[70vh] flex-col gap-2 overflow-hidden px-5 pb-4 pt-3">
            {livePreview && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{livePreview.text.length.toLocaleString()} chars</span>
                    {livePreview.missing.length > 0 ? (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                        {livePreview.missing.length} unresolved
                      </span>
                    ) : (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
                        all placeholders resolved
                      </span>
                    )}
                  </div>
                  <Button size="sm" onClick={copyLivePrompt} className="h-7 gap-1">
                    {previewCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span className="text-xs">{previewCopied ? "Copied" : "Copy prompt"}</span>
                  </Button>
                </div>

                {livePreview.notes.length > 0 && (
                  <ul className="rounded border border-border bg-muted/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    {livePreview.notes.map((n, i) => (
                      <li key={i}>· {n}</li>
                    ))}
                  </ul>
                )}

                {livePreview.missing.length > 0 && (
                  <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Unresolved at preview time:{" "}
                      <code className="font-mono">{livePreview.missing.join(", ")}</code>. These get filled by the runtime handler
                      when a real generation runs (e.g. per-batch frames, per-sentence chunks).
                    </span>
                  </div>
                )}

                <ColoredPromptView template={draft} rendered={livePreview.text} />

              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ColoredPromptView({ template, rendered }: { template: string; rendered: string }) {
  const segments = useMemo(() => segmentRenderedPrompt(template, rendered), [template, rendered]);
  // Legend: unique placeholders actually filled in this render
  const legend = useMemo(() => {
    const seen = new Map<string, { placeholder: string; sample: string }>();
    for (const s of segments) {
      if ((s.kind === "value" || s.kind === "unresolved") && !seen.has(s.placeholder)) {
        seen.set(s.placeholder, {
          placeholder: s.placeholder,
          sample: s.text.length > 60 ? s.text.slice(0, 60) + "…" : s.text,
        });
      }
    }
    return [...seen.values()];
  }, [segments]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {legend.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {legend.map(({ placeholder }) => {
            const c = colorForPlaceholder(placeholder);
            return (
              <span
                key={placeholder}
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${c.bg} ${c.text} ${c.ring}`}
                title={PLACEHOLDER_DOCS[placeholder] ?? "runtime substitution"}
              >
                {placeholder}
              </span>
            );
          })}
        </div>
      )}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
        {segments.map((seg, i) => {
          if (seg.kind === "literal") return <span key={i}>{seg.text}</span>;
          if (seg.kind === "extra") {
            return (
              <span
                key={i}
                className="rounded bg-muted-foreground/10 px-0.5 text-foreground/80"
                title="Added by the builder (not from a template placeholder — e.g. mirror preamble)"
              >
                {seg.text}
              </span>
            );
          }
          if (seg.kind === "unresolved") {
            return (
              <span
                key={i}
                className="rounded bg-amber-500/15 px-0.5 text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-300"
                title={`Unresolved: ${seg.placeholder}`}
              >
                {seg.text}
              </span>
            );
          }
          const c = colorForPlaceholder(seg.placeholder);
          return (
            <span
              key={i}
              className={`rounded px-0.5 ${c.bg} ${c.text}`}
              title={`${seg.placeholder}${PLACEHOLDER_DOCS[seg.placeholder] ? " — " + PLACEHOLDER_DOCS[seg.placeholder] : ""}`}
            >
              {seg.text}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

